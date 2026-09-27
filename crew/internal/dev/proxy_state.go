package dev

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

// ProxyStatusURL is the proxy's own page — every proxied URL, served for any
// hostname it does not route. The first thing to open from another device.
func ProxyStatusURL() string {
	return statusURL(ResolveHostIP(), config.LoadSettings().GetProxyPort())
}

func statusURL(host string, port int) string {
	if port != 80 {
		host = fmt.Sprintf("%s:%d", host, port)
	}
	return "http://" + host + "/"
}

// proxyState is what the running proxy was launched with. The proxy matches
// hostnames against the domain it started with, so a settings change
// (server_ip, domain, proxy_port) after it is up would print URLs the proxy
// never answers. EnsureProxy compares against this and relaunches.
type proxyState struct {
	Domain string `json:"domain"`
	Port   int    `json:"port"`
	// HTTPSPort is the TLS port, 0 when HTTPS is off. A pointer so a record
	// written before HTTPS existed reads as unknown and relaunches.
	HTTPSPort *int `json:"https_port,omitempty"`
	// Error is why the proxy exited, written by the proxy itself: the pane
	// is not a reliable record (a prompt redraw can clear it).
	Error string `json:"error,omitempty"`
	// TLSError is why HTTPS is not serving while plain HTTP carries on.
	TLSError string `json:"tls_error,omitempty"`
}

func proxyStatePath() string { return filepath.Join(config.ConfigDir, "dev-proxy.json") }

func loadProxyState() (proxyState, bool) {
	data, err := os.ReadFile(proxyStatePath())
	if err != nil {
		return proxyState{}, false
	}
	var st proxyState
	if err := json.Unmarshal(data, &st); err != nil {
		return proxyState{}, false
	}
	return st, true
}

func saveProxyState(st proxyState) error {
	data, err := json.Marshal(st)
	if err != nil {
		return err
	}
	return os.WriteFile(proxyStatePath(), data, 0o644)
}

// RecordProxyError is the proxy's own last word before it exits — a bind
// failure, usually — kept beside its launch settings for the warning.
func RecordProxyError(err error) {
	st, _ := loadProxyState()
	st.Error = err.Error()
	if werr := saveProxyState(st); werr != nil {
		debug.Log("dev", "proxy error not recorded: %v", werr)
	}
}

// RecordProxyTLSError is the proxy's note that HTTPS could not start (a bind
// or certificate failure) while plain HTTP keeps serving.
func RecordProxyTLSError(err error) {
	st, _ := loadProxyState()
	st.TLSError = err.Error()
	if werr := saveProxyState(st); werr != nil {
		debug.Log("dev", "proxy tls error not recorded: %v", werr)
	}
}

// StopProxy kills the proxy session and forgets what it was launched with.
func StopProxy() {
	crewExec.KillTmuxSession(ProxySessionName)
	os.Remove(proxyStatePath())
}

// ProxyStatus is the proxy as crew knows it: whether its session is up and
// crew's own proxy answers on its port, and what it was launched with.
type ProxyStatus struct {
	Running   bool   `json:"running"`
	Listening bool   `json:"listening"` // crew's proxy answers, not merely something on the port
	Domain    string `json:"domain,omitempty"`
	Port      int    `json:"port,omitempty"`
	URL       string `json:"url,omitempty"`
	Error     string `json:"error,omitempty"` // why the proxy exited, if it did
	HTTPSPort int    `json:"https_port"`      // 0: HTTPS off
	// TLS is "up", "not listening" or "off".
	TLS      string `json:"tls"`
	TLSError string `json:"tls_error,omitempty"`
}

// InspectProxy reports the running proxy. A session without a listener is
// the failure mode a user cannot see from `crew dev status`: the URLs print,
// nothing answers.
func InspectProxy() ProxyStatus {
	st := ProxyStatus{Running: crewExec.TmuxSessionExists(ProxySessionName)}
	have, ok := loadProxyState()
	if !ok {
		// A session with no record predates the record; the next --proxy
		// start relaunches it, so report the settings it will get.
		settings := config.LoadSettings()
		httpsPort := settings.GetProxyHTTPSPort()
		have = proxyState{Domain: settings.GetDomain(ResolveHostIP()), Port: settings.GetProxyPort(), HTTPSPort: &httpsPort}
	}
	st.Domain, st.Port, st.Error, st.TLSError = have.Domain, have.Port, have.Error, have.TLSError
	st.URL = statusURL(ResolveHostIP(), have.Port)
	if have.HTTPSPort != nil {
		st.HTTPSPort = *have.HTTPSPort
	}
	st.TLS = "off"
	if st.HTTPSPort > 0 {
		st.TLS = "not listening"
	}
	if st.Running {
		st.Listening = proxyAnswers(have.Port, 0)
		if st.HTTPSPort > 0 && tlsAnswers(st.HTTPSPort, st.Domain, 0) {
			st.TLS = "up"
		}
	}
	return st
}

// ProxyServesTLS is whether crew's proxy answers HTTPS on port with the
// domain's certificate, right now.
func ProxyServesTLS(domain string, port int) bool {
	return port > 0 && tlsAnswers(port, domain, 0)
}

// ProxyTLSWarning is ProxyWarning for the HTTPS side: empty when HTTPS is off
// or answers with crew's certificate.
func ProxyTLSWarning(domain string, httpsPort int) string {
	// A proxy launched a moment ago needs a few seconds to issue its certificate and bind.
	if httpsPort <= 0 || tlsAnswers(httpsPort, domain, 5*time.Second) {
		return ""
	}
	if st, ok := loadProxyState(); ok && st.TLSError != "" {
		return fmt.Sprintf("proxy HTTPS is not answering on :%d — %s", httpsPort, st.TLSError)
	}
	return fmt.Sprintf("proxy HTTPS is not answering on :%d — another server holds the port? lsof -nP -iTCP:%d -sTCP:LISTEN", httpsPort, httpsPort)
}

// proxyAnswers asks loopback:<port> for the proxy's status page, retrying
// for up to wait — the proxy binds a moment after send-keys returns. A
// bare dial would not do: whatever else holds the port (another app on 80)
// answers a dial just as well, and that is exactly the case to catch.
func proxyAnswers(port int, wait time.Duration) bool {
	// No keep-alive: a probe must not hold a connection open to the proxy,
	// and a kept one would keep answering after the listener is gone.
	client := &http.Client{Timeout: 500 * time.Millisecond, Transport: &http.Transport{DisableKeepAlives: true}}
	deadline := time.Now().Add(wait)
	for {
		if isProxyStatusPage(client, port) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func isProxyStatusPage(client *http.Client, port int) bool {
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/", port))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	return strings.Contains(string(body), proxyPageMarker)
}

// ProxyWarning is what a start prints when the proxy session is up but
// crew's proxy does not answer. The reason is what the proxy recorded on
// its way out; the pane is the fallback for a proxy that never got that far.
func ProxyWarning(port int) string {
	if proxyAnswers(port, 2*time.Second) {
		return ""
	}
	if st, ok := loadProxyState(); ok && st.Error != "" {
		return fmt.Sprintf("proxy is not answering on :%d — %s", port, st.Error)
	}
	out, _ := crewExec.CaptureTmuxPane(ProxySessionName, "", 10)
	if reason := paneError(out); reason != "" {
		return fmt.Sprintf("proxy is not answering on :%d — %s", port, reason)
	}
	// No recorded error and a quiet pane: the bind went through but
	// something else answers the port (macOS lets two SO_REUSEADDR
	// listeners share one; the older one gets the connections).
	return fmt.Sprintf("proxy is not answering on :%d — another server holds the port? lsof -nP -iTCP:%d -sTCP:LISTEN", port, port)
}

// paneError is the last line of a pane that reads like an error. After a
// bind failure the process has exited, so the very last line is the shell
// prompt — the error sits above it. "listen" is not a keyword: the proxy's
// own "Listening on" banner would match. Pure.
func paneError(pane string) string {
	lines := strings.Split(pane, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		l := strings.TrimSpace(lines[i])
		low := strings.ToLower(l)
		if strings.Contains(low, "error") || strings.Contains(low, "bind") || strings.Contains(low, "denied") || strings.Contains(low, "in use") {
			return l
		}
	}
	return ""
}

// EnsureProxy starts the shared reverse proxy on domain:port — plus HTTPS on
// the configured TLS port — relaunching a running one that was started with
// different settings.
func EnsureProxy(domain string, port int) error {
	httpsPort := config.LoadSettings().GetProxyHTTPSPort()
	want := proxyState{Domain: domain, Port: port, HTTPSPort: &httpsPort}
	if crewExec.TmuxSessionExists(ProxySessionName) {
		// No record means a proxy from before crew kept one; relaunching is
		// cheaper than guessing what it serves.
		have, ok := loadProxyState()
		switch {
		case ok && have.Error != "":
			debug.Log("dev", "proxy exited (%s) — relaunching", have.Error)
		case ok && sameLaunch(have, want):
			debug.Log("dev", "proxy already running in %s", ProxySessionName)
			return nil
		case ok:
			debug.Log("dev", "proxy running with other settings (%s:%d), want %s:%d https %d — relaunching", have.Domain, have.Port, domain, port, httpsPort)
		default:
			debug.Log("dev", "proxy running with no launch record — relaunching")
		}
		StopProxy()
	}

	debug.Log("dev", "starting shared proxy on %s:%d", domain, port)
	if err := crewExec.CreateTmuxSession(ProxySessionName, ""); err != nil {
		return fmt.Errorf("failed to create proxy session: %w", err)
	}

	crewBin, err := crewExec.CrewBinary()
	if err != nil {
		crewBin = "crew"
	}

	// The record goes down before the launch: a proxy that fails its bind
	// at once writes its error into it, and a record written afterwards
	// would erase that. A lost record only costs a relaunch next time —
	// warn, never block.
	if err := saveProxyState(want); err != nil {
		debug.Log("dev", "proxy state not saved: %v", err)
	}
	cmd := fmt.Sprintf("%s dev _proxy --domain=%s --port=%d --https-port=%d", crewBin, domain, port, httpsPort)
	debug.Log("dev", "proxy cmd: %s", cmd)
	return crewExec.TmuxSendKeys(ProxySessionName, cmd)
}

// sameLaunch is whether a running proxy already serves what want asks for. A
// record from before HTTPS existed has no HTTPS port and never matches. Pure.
func sameLaunch(have, want proxyState) bool {
	if have.Domain != want.Domain || have.Port != want.Port {
		return false
	}
	return have.HTTPSPort != nil && want.HTTPSPort != nil && *have.HTTPSPort == *want.HTTPSPort
}
