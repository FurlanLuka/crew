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

// SessionName is the server's tmux session: outside crew-dev-*, so crew dev
// stop and crew kill — which take every crew-dev-* down — never stop the
// page that asked for them. A var so tests use their own tmux session.
var SessionName = "crew-server"

// LegacySessionName is where a server started by a crew before the rename
// runs (crew-dev-os): still recognised, so one started before an upgrade
// reads as running and can be stopped. A var for the same reason.
var LegacySessionName = dev.SessionName(dev.Slug(workspace.VoiceSlug))

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

// DebugNotesFile and NotesDir live on the main, where the kernel writes them
// (voiceos/src/config.ts).
func DebugNotesFile() string { return filepath.Join(Dir(), "logs", "debug-notes.jsonl") }

func NotesDir() string { return filepath.Join(Dir(), "notes") }

// keptLogs is how many rotated files Voice OS keeps beside a log (voiceos/src/log.ts).
const keptLogs = 5

// RotatedFiles is a log and its rotations, newest first: base, base.1 … base.5.
// Named, never globbed, so debug-notes.jsonl beside it is never read as a log.
func RotatedFiles(base string) []string {
	files := []string{base}
	for i := 1; i <= keptLogs; i++ {
		files = append(files, fmt.Sprintf("%s.%d", base, i))
	}
	return files
}

// Binary is where the Voice OS executable lives: downloaded there on the first
// crew server (Install), or compiled there from source with `bun run install-dev`.
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
	// ClaudeBin is the claude crew found (ClaudeBin()); empty leaves Voice OS to look.
	ClaudeBin string
	// SSHAuthSock is the caller's ssh-agent: other machines are reached over
	// SSH with no prompt, and the tmux server may have none or a stale one.
	SSHAuthSock string
}

// Command is the line the tmux session runs. HOME is explicit because the
// tmux server's environment belongs to whoever started it; CREW_BIN makes
// Voice OS call back into this crew, not whichever one PATH finds;
// VOICEOS_RECORD_STATE lets only this instance write state.json, so a manual
// run cannot overwrite the port and pid crew tracks; VOICEOS_CLAUDE_BIN is the
// claude crew checked, since the tmux server's PATH may not find it. Pure.
func Command(spec LaunchSpec) string {
	parts := append(envPrelude(spec.Home, spec.CrewBin),
		fmt.Sprintf("PORT=%d", spec.Port),
		"VOICEOS_PROXY_HOST="+crewExec.ShellQuote(spec.ProxyHost),
		fmt.Sprintf("VOICEOS_PROXY_PORT=%d", spec.ProxyPort),
	)
	if spec.ProxyHTTPSPort > 0 {
		parts = append(parts, fmt.Sprintf("VOICEOS_PROXY_HTTPS_PORT=%d", spec.ProxyHTTPSPort))
	}
	if spec.ClaudeBin != "" {
		parts = append(parts, "VOICEOS_CLAUDE_BIN="+crewExec.ShellQuote(spec.ClaudeBin))
	}
	if spec.SSHAuthSock != "" {
		parts = append(parts, "SSH_AUTH_SOCK="+crewExec.ShellQuote(spec.SSHAuthSock))
	}
	parts = append(parts, "VOICEOS_RECORD_STATE=1", crewExec.ShellQuote(spec.Binary))
	return strings.Join(parts, " ")
}

// envPrelude is what every Voice OS process starts with, cockpit or remote. Pure.
func envPrelude(home, crewBin string) []string {
	return []string{"HOME=" + crewExec.ShellQuote(home), "CREW_BIN=" + crewExec.ShellQuote(crewBin)}
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

// ProxyRouteAnswers is whether the server's proxy link works from another
// device: crew's proxy, asked here for the server's own hostname, reaches
// it, and the domain is not this machine's loopback (an automatic nip.io
// name on a machine with no LAN address). Over SSH that link is preferred
// to a tunnel — a domain set or the automatic server_ip one alike.
func ProxyRouteAnswers() bool {
	domain, port, _ := proxySettings()
	return !isLoopbackDomain(domain) && routeAnswers(port, ProxyHost(domain))
}

// isLoopbackDomain: a nip.io name (or a bare address) for 127.x, which no
// other device resolves to this machine. Pure.
func isLoopbackDomain(domain string) bool {
	return domain == "" || domain == "localhost" || strings.HasPrefix(domain, "127.")
}

// routeAnswers asks the proxy on loopback:port for host's health page.
func routeAnswers(port int, host string) bool {
	if port <= 0 {
		return false
	}
	req, err := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/healthz", port), nil)
	if err != nil {
		return false
	}
	req.Host = host
	client := http.Client{Timeout: time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
	res, err := client.Do(req)
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
	st.Running = CockpitRunning()
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

func killSessions(names ...string) {
	for _, name := range names {
		if crewExec.TmuxSessionExists(name) {
			crewExec.KillTmuxSession(name)
		}
	}
}

// Start launches Voice OS unless it already answers, registers its proxy
// route, and waits until it is healthy.
func Start() (Status, error) {
	if st := Inspect(); st.Healthy {
		debug.Log("voice", "already running on %d", st.Port)
		// A sweep or a crashed stop may have dropped the route while the
		// server ran; status must never advertise a link nothing serves.
		ensureRoute(st.Port)
		return st, nil
	}
	if !crewExec.HasTmux() {
		return Status{}, fmt.Errorf("tmux not found — install with: brew install tmux")
	}
	binary := Binary()
	if _, err := os.Stat(binary); err != nil {
		return Status{}, fmt.Errorf("Voice OS is not installed at %s — crew server downloads it (a dev crew: cd voiceos && bun run install-dev)", binary)
	}
	if CockpitRunning() {
		// A session that exists but does not answer is a hung or crashed server.
		debug.Log("voice", "session up but unhealthy — restarting")
		killSessions(SessionName, LegacySessionName)
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
	cmd := Command(LaunchSpec{Binary: binary, CrewBin: crewBin, Home: home, Port: port, ProxyHost: ProxyHost(domain), ProxyPort: proxyPort, ProxyHTTPSPort: httpsPort, ClaudeBin: ClaudeBin(), SSHAuthSock: os.Getenv("SSH_AUTH_SOCK")})
	debug.Log("voice", "start → %s", cmd)
	if err := crewExec.TmuxRunInSession(SessionName, "voiceos", home, cmd); err != nil {
		return Status{}, fmt.Errorf("failed to start the Voice OS session: %w", err)
	}

	saveRoute(port)
	launched, err := dev.EnsureProxy(domain, proxyPort)
	if err != nil {
		debug.Log("voice", "proxy not started: %v", err)
	}
	// Alongside the health wait, not before it: a freshly launched proxy gets
	// up to tlsStartWait to bind, so the link printed is already the HTTPS
	// one, while a start that fails is not held up by it.
	tlsWarning := make(chan string, 1)
	go func() { tlsWarning <- dev.ProxyTLSWarning(domain, httpsPort, launched) }()

	deadline := time.Now().Add(healthWait)
	for time.Now().Before(deadline) {
		if healthy(port) {
			warning := <-tlsWarning
			if warning != "" {
				debug.Log("voice", "%s", warning)
			}
			st := Inspect()
			st.Warning = warning
			return st, nil
		}
		if !crewExec.TmuxSessionExists(SessionName) {
			return Status{}, fmt.Errorf("Voice OS exited during start — see crew server logs")
		}
		time.Sleep(200 * time.Millisecond)
	}
	return Inspect(), fmt.Errorf("Voice OS did not answer within %s — see crew server logs", healthWait)
}

func saveRoute(port int) {
	route := dev.Route{ServerName: RouteServer, ExternalPort: port, InternalPort: port}
	if err := dev.SaveRoutes(dev.Slug(workspace.VoiceSlug), []dev.Route{route}); err != nil {
		debug.Log("voice", "route not saved: %v", err)
	}
}

// ensureRoute writes the server's route unless it is already there for port.
func ensureRoute(port int) {
	routes, _ := dev.LoadRoutes(dev.Slug(workspace.VoiceSlug))
	if routeServes(routes, port) {
		return
	}
	debug.Log("voice", "route missing for %d — rewritten", port)
	saveRoute(port)
}

func routeServes(routes []dev.Route, port int) bool {
	for _, r := range routes {
		if r.ServerName == RouteServer && r.InternalPort == port {
			return true
		}
	}
	return false
}

// Stop ends Voice OS and every Claude session it runs, and drops its route —
// under the legacy session name too, so a server from before the rename
// stops like one after it.
func Stop() {
	debug.Log("voice", "stop")
	killSessions(SessionName, LegacySessionName)
	if err := dev.SaveRoutes(dev.Slug(workspace.VoiceSlug), nil); err != nil {
		debug.Log("voice", "route not removed: %v", err)
	}
}

// PageURL is crew's page on this machine without its sign-in token — what a
// line in a terminal may print without handing out the login. "" when the
// server is not answering.
func PageURL() string {
	st := Inspect()
	if !st.Healthy {
		return ""
	}
	return LoginURL("http", "localhost", st.Port, "")
}
