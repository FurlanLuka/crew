// Package voice starts and inspects Voice OS, the voice and web cockpit that
// runs Claude Code sessions for crew worktrees. crew owns its lifecycle the way
// it owns the dev proxy: one tmux session, a route for the proxy, a port that
// is remembered so a restart lands on the same one.
package voice

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// SessionName is a var so tests use their own tmux session.
var SessionName = dev.SessionName(dev.Slug(workspace.VoiceSlug))

const (
	RouteServer = "voice"
	healthWait  = 15 * time.Second
)

type Status struct {
	Running      bool   `json:"running"`
	Healthy      bool   `json:"healthy"`
	Port         int    `json:"port"`
	PID          int    `json:"pid"`
	LocalhostURL string `json:"localhost_url"`
	URL          string `json:"url"`
	// Secure is whether URL is the proxy's HTTPS link, where a browser that
	// trusts crew's CA grants the microphone.
	Secure  bool   `json:"secure"`
	Binary  string `json:"binary"`
	Warning string `json:"warning,omitempty"`
}

type savedState struct {
	Port int `json:"port"`
	PID  int `json:"pid"`
}

func Dir() string { return filepath.Join(config.ConfigDir, "voiceos") }

func LogFile() string { return filepath.Join(Dir(), "logs", "voiceos.log") }

// Binary is where the Voice OS executable lives. Development builds are
// compiled into it with `bun run install-dev`; releases will download it there.
func Binary() string {
	if bin := os.Getenv("CREW_VOICEOS_BIN"); bin != "" {
		return bin
	}
	return filepath.Join(config.ConfigDir, "bin", "voiceos")
}

func loadSaved() savedState {
	var st savedState
	data, err := os.ReadFile(filepath.Join(Dir(), "state.json"))
	if err != nil {
		return st
	}
	if err := json.Unmarshal(data, &st); err != nil {
		debug.Log("voice", "state.json unreadable: %v", err)
	}
	return st
}

func saveState(st savedState) error {
	if err := os.MkdirAll(Dir(), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(st)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(Dir(), "state.json"), data, 0o600)
}

func readToken() string {
	data, err := os.ReadFile(filepath.Join(Dir(), "token"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// LoginURL is the link that signs a browser in. A browser grants the
// microphone on localhost or over HTTPS, nowhere else. Pure.
func LoginURL(scheme, host string, port int, token string) string {
	base := fmt.Sprintf("%s://%s:%d", scheme, host, port)
	if (scheme == "http" && port == 80) || (scheme == "https" && port == 443) {
		base = scheme + "://" + host
	}
	if token == "" {
		return base + "/"
	}
	return base + "/login?token=" + url.QueryEscape(token)
}

// proxyLink is what the sign-in link through the dev proxy is built from.
type proxyLink struct {
	Domain    string
	Port      int
	HTTPSPort int  // 0: the proxy serves no HTTPS
	TLSUp     bool // HTTPS answers right now
	Token     string
}

// proxyLoginURL is the sign-in link through the dev proxy: HTTPS when the
// proxy serves it, so the microphone works there too. Pure.
func proxyLoginURL(l proxyLink) (url string, secure bool) {
	if l.HTTPSPort > 0 && l.TLSUp {
		return LoginURL("https", ProxyHost(l.Domain), l.HTTPSPort, l.Token), true
	}
	return LoginURL("http", ProxyHost(l.Domain), l.Port, l.Token), false
}

// ProxyHost is Voice OS's hostname on the dev proxy. Pure.
func ProxyHost(domain string) string {
	return RouteServer + "--" + workspace.VoiceSlug + "." + domain
}

// LaunchSpec is everything the Voice OS process is started with.
type LaunchSpec struct {
	Binary    string
	CrewBin   string
	Home      string
	Port      int
	ProxyHost string
	ProxyPort int
	// ProxyHTTPSPort is 0 when the proxy serves no HTTPS.
	ProxyHTTPSPort int
}

// Command is the line the tmux session runs. HOME is explicit because the
// tmux server's environment belongs to whoever started it; CREW_BIN makes
// Voice OS call back into this crew, not whichever one PATH finds;
// VOICEOS_RECORD_STATE lets only this instance write state.json, so a manual
// run cannot overwrite the port and pid crew tracks. Pure.
func Command(spec LaunchSpec) string {
	parts := []string{
		"HOME=" + crewExec.ShellQuote(spec.Home),
		"CREW_BIN=" + crewExec.ShellQuote(spec.CrewBin),
		fmt.Sprintf("PORT=%d", spec.Port),
		"VOICEOS_PROXY_HOST=" + crewExec.ShellQuote(spec.ProxyHost),
		fmt.Sprintf("VOICEOS_PROXY_PORT=%d", spec.ProxyPort),
	}
	if spec.ProxyHTTPSPort > 0 {
		parts = append(parts, fmt.Sprintf("VOICEOS_PROXY_HTTPS_PORT=%d", spec.ProxyHTTPSPort))
	}
	parts = append(parts, "VOICEOS_RECORD_STATE=1", crewExec.ShellQuote(spec.Binary))
	return strings.Join(parts, " ")
}

func portFree(port int) bool {
	if port <= 0 {
		return false
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return false
	}
	ln.Close()
	return true
}

// portWait is how long a start waits for the remembered port: right after a
// stop, the old Voice OS can still be shutting its sessions down. A var so
// tests do not wait five seconds.
var portWait = 5 * time.Second

// pickPort keeps the remembered port — waiting for it to free up first — so
// bookmarks and open tabs keep working across restarts.
func pickPort(remembered int) (int, error) {
	deadline := time.Now().Add(portWait)
	for remembered > 0 {
		if portFree(remembered) {
			return remembered, nil
		}
		if time.Now().After(deadline) {
			debug.Log("voice", "port %d still taken after %s — picking another", remembered, portWait)
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port, nil
}

func healthy(port int) bool {
	if port <= 0 {
		return false
	}
	client := http.Client{Timeout: time.Second}
	res, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/healthz", port))
	if err != nil {
		return false
	}
	defer res.Body.Close()
	return res.StatusCode == http.StatusOK
}

func proxySettings() (domain string, port, httpsPort int) {
	settings := config.LoadSettings()
	return settings.GetDomain(dev.ResolveHostIP()), settings.GetProxyPort(), settings.GetProxyHTTPSPort()
}

// Inspect reports whether Voice OS runs and answers, and the links to open it.
func Inspect() Status {
	st := Status{Binary: Binary()}
	saved := loadSaved()
	st.Running = crewExec.TmuxSessionExists(SessionName)
	st.Port = saved.Port
	st.PID = saved.PID
	st.Healthy = st.Running && healthy(saved.Port)
	if st.Healthy {
		token := readToken()
		domain, proxyPort, httpsPort := proxySettings()
		st.LocalhostURL = LoginURL("http", "localhost", saved.Port, token)
		st.URL, st.Secure = proxyLoginURL(proxyLink{Domain: domain, Port: proxyPort, HTTPSPort: httpsPort, TLSUp: dev.ProxyServesTLS(domain, httpsPort), Token: token})
	}
	return st
}

// Start launches Voice OS unless it already answers, registers its proxy
// route, and waits until it is healthy.
func Start() (Status, error) {
	if st := Inspect(); st.Healthy {
		debug.Log("voice", "already running on %d", st.Port)
		return st, nil
	}
	if !crewExec.HasTmux() {
		return Status{}, fmt.Errorf("tmux not found — install with: brew install tmux")
	}
	binary := Binary()
	if _, err := os.Stat(binary); err != nil {
		return Status{}, fmt.Errorf("Voice OS is not installed at %s — build it with: cd voiceos && bun run install-dev", binary)
	}
	if crewExec.TmuxSessionExists(SessionName) {
		// A session that exists but does not answer is a hung or crashed server.
		debug.Log("voice", "session up but unhealthy — restarting")
		crewExec.KillTmuxSession(SessionName)
	}

	port, err := pickPort(loadSaved().Port)
	if err != nil {
		return Status{}, fmt.Errorf("no free port: %w", err)
	}
	// crew owns the port: it is recorded before launch so status never reads
	// a stale one while Voice OS is still starting.
	if err := saveState(savedState{Port: port}); err != nil {
		debug.Log("voice", "state not saved: %v", err)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		debug.Log("voice", "no home dir: %v", err)
	}
	domain, proxyPort, httpsPort := proxySettings()
	crewBin, err := crewExec.CrewBinary()
	if err != nil {
		crewBin = "crew"
	}
	cmd := Command(LaunchSpec{Binary: binary, CrewBin: crewBin, Home: home, Port: port, ProxyHost: ProxyHost(domain), ProxyPort: proxyPort, ProxyHTTPSPort: httpsPort})
	debug.Log("voice", "start → %s", cmd)
	if err := crewExec.TmuxRunInSession(SessionName, "voiceos", home, cmd); err != nil {
		return Status{}, fmt.Errorf("failed to start the Voice OS session: %w", err)
	}

	route := dev.Route{ServerName: RouteServer, ExternalPort: port, InternalPort: port}
	if err := dev.SaveRoutes(dev.Slug(workspace.VoiceSlug), []dev.Route{route}); err != nil {
		debug.Log("voice", "route not saved: %v", err)
	}
	if err := dev.EnsureProxy(domain, proxyPort); err != nil {
		debug.Log("voice", "proxy not started: %v", err)
	}
	// Also gives a freshly launched proxy the moment it needs to bind, so the
	// link printed below is already the HTTPS one.
	warning := dev.ProxyTLSWarning(domain, httpsPort)
	if warning != "" {
		debug.Log("voice", "%s", warning)
	}

	deadline := time.Now().Add(healthWait)
	for time.Now().Before(deadline) {
		if healthy(port) {
			st := Inspect()
			st.Warning = warning
			return st, nil
		}
		if !crewExec.TmuxSessionExists(SessionName) {
			return Status{}, fmt.Errorf("Voice OS exited during start — see crew voice logs")
		}
		time.Sleep(200 * time.Millisecond)
	}
	return Inspect(), fmt.Errorf("Voice OS did not answer within %s — see crew voice logs", healthWait)
}

// Stop ends Voice OS and every Claude session it runs, and drops its route.
// It kills SessionName rather than going through dev.StopAll, which targets
// the fixed crew-dev-os name: tests swap SessionName and must never reach a
// real running Voice OS.
func Stop() {
	debug.Log("voice", "stop")
	crewExec.KillTmuxSession(SessionName)
	if err := dev.SaveRoutes(dev.Slug(workspace.VoiceSlug), nil); err != nil {
		debug.Log("voice", "route not removed: %v", err)
	}
}
