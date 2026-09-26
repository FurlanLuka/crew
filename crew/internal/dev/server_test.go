package dev

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

func TestSessionName(t *testing.T) {
	tests := []struct {
		input Slug
		want  string
	}{
		{"myws", "crew-dev-myws"},
		{"test-workspace", "crew-dev-test-workspace"},
		{"", "crew-dev-"},
	}

	for _, tt := range tests {
		t.Run(string(tt.input), func(t *testing.T) {
			got := SessionName(tt.input)
			if got != tt.want {
				t.Errorf("SessionName(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestFindFreePort(t *testing.T) {
	port1, err := FindFreePort()
	if err != nil {
		t.Fatalf("FindFreePort: %v", err)
	}
	if port1 <= 0 {
		t.Errorf("port = %d, want > 0", port1)
	}

	port2, err := FindFreePort()
	if err != nil {
		t.Fatalf("FindFreePort second call: %v", err)
	}
	if port2 <= 0 {
		t.Errorf("second port = %d, want > 0", port2)
	}

}

func TestStart_NoProxy_WritesRoutesAndSkipsProxy(t *testing.T) {
	if !crewExec.HasTmux() {
		t.Skip("tmux not available")
	}
	setupTestConfig(t)

	session := SessionName("ws-np")
	// A real proxy may be running for the user's own worktrees; only assert
	// that this Start did not create one.
	proxyBefore := crewExec.TmuxSessionExists(ProxySessionName)
	t.Cleanup(func() {
		crewExec.KillTmuxSession(session)
		if !proxyBefore {
			crewExec.KillTmuxSession(ProxySessionName)
		}
	})

	projects := []DevProject{{
		Path: t.TempDir(),
		DevServers: []DevServerConfig{
			{Name: "api", Port: 3001, Command: "sleep 30"},
		},
	}}

	result, err := Start(StartParams{
		Slug:      "ws-np",
		Workspace: "ws",
		Worktree:  "np",
		Projects:  projects,
		Domain:    "dev.local",
		ProxyPort: 8080,
		NoProxy:   true,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(result.Routes) != 1 {
		t.Fatalf("got %d routes, want 1", len(result.Routes))
	}
	r := result.Routes[0]
	if !r.NoProxy {
		t.Errorf("route.NoProxy = false, want true")
	}
	if r.ExternalPort != 3001 {
		t.Errorf("ExternalPort = %d, want the configured 3001 kept for reference", r.ExternalPort)
	}
	if r.InternalPort == 3001 || r.InternalPort == 0 {
		t.Errorf("InternalPort = %d, want a freshly allocated port even in no-proxy mode", r.InternalPort)
	}

	loaded, err := LoadRoutes("ws-np")
	if err != nil || len(loaded) != 1 || !loaded[0].NoProxy {
		t.Errorf("persisted routes = %+v, err=%v", loaded, err)
	}

	if !proxyBefore && crewExec.TmuxSessionExists(ProxySessionName) {
		t.Error("proxy session should not be started in no-proxy mode")
	}
}

func TestStopProxyIfIdle_NoProxyRoutesDontKeepProxyAlive(t *testing.T) {
	isolateProxy(t)
	setupTestConfig(t)
	t.Cleanup(func() { crewExec.KillTmuxSession(ProxySessionName) })

	if err := crewExec.CreateTmuxSession(ProxySessionName, ""); err != nil {
		t.Fatalf("CreateTmuxSession: %v", err)
	}
	if err := saveRoutes("ws", []Route{
		{Project: "api", ServerName: "api", ExternalPort: 3000, InternalPort: 3000, NoProxy: true},
	}); err != nil {
		t.Fatalf("saveRoutes: %v", err)
	}

	StopProxyIfIdle()

	if crewExec.TmuxSessionExists(ProxySessionName) {
		t.Error("a no-proxy route alone should not keep the proxy alive")
	}
}

func TestStopProxyIfIdle_ProxiedRouteKeepsProxyAlive(t *testing.T) {
	isolateProxy(t)
	setupTestConfig(t)
	t.Cleanup(func() { crewExec.KillTmuxSession(ProxySessionName) })

	if err := crewExec.CreateTmuxSession(ProxySessionName, ""); err != nil {
		t.Fatalf("CreateTmuxSession: %v", err)
	}
	if err := saveProxyState(proxyState{Domain: "d", Port: 1}); err != nil {
		t.Fatalf("saveProxyState: %v", err)
	}
	if err := saveRoutes("ws--wrk1", []Route{
		{Project: "api", ServerName: "api", ExternalPort: 3000, InternalPort: 54001},
	}); err != nil {
		t.Fatalf("saveRoutes: %v", err)
	}

	StopProxyIfIdle()

	if !crewExec.TmuxSessionExists(ProxySessionName) {
		t.Error("a proxied route should keep the proxy alive")
	}
	// Dropping the record while the session lives would make the next
	// EnsureProxy relaunch a proxy other worktrees are using.
	if _, ok := loadProxyState(); !ok {
		t.Error("the launch record must survive while the proxy does")
	}
}

func TestDetectLANIP(t *testing.T) {
	ip := detectLANIP()
	if ip == "" {
		t.Fatal("DetectLANIP returned empty string")
	}

	// Should be valid IPv4 format (either LAN or fallback 127.0.0.1)
	parsed := net.ParseIP(ip)
	if parsed == nil {
		t.Errorf("DetectLANIP = %q, not valid IP", ip)
	}
	if parsed.To4() == nil {
		t.Errorf("DetectLANIP = %q, not IPv4", ip)
	}
}

// stubProxyBinary keeps the proxy pane from running the test binary; the
// command line is still echoed, which is what the assertions read.
func stubProxyBinary(t *testing.T) {
	t.Helper()
	prev := crewExec.CrewBinary
	crewExec.CrewBinary = func() (string, error) { return "/usr/bin/true", nil }
	t.Cleanup(func() { crewExec.CrewBinary = prev })
}

// isolateProxy gives the test its own proxy session name, so a user's live
// proxy is never touched and packages testing in parallel never share one.
func isolateProxy(t *testing.T) {
	t.Helper()
	if !crewExec.HasTmux() {
		t.Skip("tmux not available")
	}
	prev := ProxySessionName
	ProxySessionName = fmt.Sprintf("crew-test-proxy-%d-%s", os.Getpid(), strings.ToLower(strings.NewReplacer("/", "-", " ", "-").Replace(t.Name())))
	t.Cleanup(func() {
		crewExec.KillTmuxSession(ProxySessionName)
		ProxySessionName = prev
	})
}

func proxyPanePID(t *testing.T) string {
	t.Helper()
	out, err := exec.Command("tmux", "display-message", "-p", "-t", ProxySessionName, "#{pane_pid}").Output()
	if err != nil {
		t.Fatalf("pane pid: %v", err)
	}
	return strings.TrimSpace(string(out))
}

// proxyPaneShows polls the pane: send-keys returns before the shell echoes.
func proxyPaneShows(t *testing.T, text string) bool {
	t.Helper()
	for i := 0; i < 20; i++ {
		out, _ := crewExec.CaptureTmuxPane(ProxySessionName, "", 50)
		if strings.Contains(out, text) {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
}

func TestEnsureProxy_RelaunchesWhenSettingsChange(t *testing.T) {
	isolateProxy(t)
	setupTestConfig(t)
	stubProxyBinary(t)
	t.Cleanup(func() { crewExec.KillTmuxSession(ProxySessionName) })

	if err := EnsureProxy("10.0.0.1.nip.io", 18080); err != nil {
		t.Fatalf("first EnsureProxy: %v", err)
	}
	if st, ok := loadProxyState(); !ok || st.Domain != "10.0.0.1.nip.io" || st.Port != 18080 || st.HTTPSPort == nil || *st.HTTPSPort != 443 {
		t.Fatalf("state after first start = %+v, %v", st, ok)
	}
	if !proxyPaneShows(t, "--domain=10.0.0.1.nip.io --port=18080 --https-port=443") {
		t.Fatal("proxy pane should show the launch command")
	}

	// Same settings: the running proxy is kept — a needless relaunch would
	// drop every other worktree's proxied connections. The pane's shell PID
	// is what a relaunch changes.
	before := proxyPanePID(t)
	if err := EnsureProxy("10.0.0.1.nip.io", 18080); err != nil {
		t.Fatalf("second EnsureProxy: %v", err)
	}
	if after := proxyPanePID(t); after != before {
		t.Fatalf("same settings relaunched the proxy: pane pid %s → %s", before, after)
	}

	// A changed server_ip (domain) after the proxy is up must relaunch it,
	// or the printed URLs would never match what the proxy answers.
	if err := EnsureProxy("100.64.0.9.nip.io", 18080); err != nil {
		t.Fatalf("relaunch: %v", err)
	}
	if after := proxyPanePID(t); after == before {
		t.Error("changed settings should relaunch the proxy")
	}
	if st, _ := loadProxyState(); st.Domain != "100.64.0.9.nip.io" {
		t.Errorf("state after relaunch = %+v", st)
	}
	if !proxyPaneShows(t, "--domain=100.64.0.9.nip.io") {
		t.Error("proxy pane should show the new domain")
	}

	// A changed HTTPS port relaunches too.
	before = proxyPanePID(t)
	s := config.LoadSettings()
	s.ProxyHTTPSPort = 18443
	if err := config.SaveSettings(s); err != nil {
		t.Fatal(err)
	}
	if err := EnsureProxy("100.64.0.9.nip.io", 18080); err != nil {
		t.Fatalf("https relaunch: %v", err)
	}
	if after := proxyPanePID(t); after == before {
		t.Error("a changed HTTPS port should relaunch the proxy")
	}
	if st, _ := loadProxyState(); st.HTTPSPort == nil || *st.HTTPSPort != 18443 {
		t.Errorf("state after HTTPS relaunch = %+v", st)
	}

	StopProxy()
	if _, ok := loadProxyState(); ok {
		t.Error("StopProxy should forget the state")
	}
}

// A proxy from before crew recorded its settings has a session and no file:
// the upgrade path every existing user takes once.
func TestEnsureProxy_RelaunchesUnrecordedProxy(t *testing.T) {
	isolateProxy(t)
	setupTestConfig(t)
	stubProxyBinary(t)
	t.Cleanup(func() { crewExec.KillTmuxSession(ProxySessionName) })

	if err := crewExec.CreateTmuxSession(ProxySessionName, ""); err != nil {
		t.Fatalf("CreateTmuxSession: %v", err)
	}
	if err := EnsureProxy("10.0.0.1.nip.io", 80); err != nil {
		t.Fatalf("EnsureProxy: %v", err)
	}
	if st, ok := loadProxyState(); !ok || st.Domain != "10.0.0.1.nip.io" {
		t.Errorf("state = %+v, %v", st, ok)
	}
	if !proxyPaneShows(t, "--domain=10.0.0.1.nip.io --port=80") {
		t.Error("proxy pane should show the launch command")
	}
}

func TestProxyStatusURL(t *testing.T) {
	setupTestConfig(t)
	if err := config.SaveSettings(config.Settings{ServerIP: "10.0.0.5", ProxyPort: 8080}); err != nil {
		t.Fatal(err)
	}
	if got := ProxyStatusURL(); got != "http://10.0.0.5:8080/" {
		t.Errorf("with port = %q", got)
	}
	if err := config.SaveSettings(config.Settings{ServerIP: "10.0.0.5"}); err != nil {
		t.Fatal(err)
	}
	if got := ProxyStatusURL(); got != "http://10.0.0.5/" {
		t.Errorf("default port = %q", got)
	}
}

func TestStatusURL(t *testing.T) {
	if got := statusURL("10.0.0.5", 80); got != "http://10.0.0.5/" {
		t.Errorf("80 → %q", got)
	}
	if got := statusURL("10.0.0.5", 8080); got != "http://10.0.0.5:8080/" {
		t.Errorf("8080 → %q", got)
	}
}

func TestInspectProxy(t *testing.T) {
	isolateProxy(t)
	setupTestConfig(t)
	stubProxyBinary(t)
	t.Cleanup(func() { crewExec.KillTmuxSession(ProxySessionName) })
	config.SaveSettings(config.Settings{ServerIP: "10.0.0.5"})

	// Nothing up and no record: the settings say what a start would use.
	if st := InspectProxy(); st.Running || st.Listening || st.Port != 80 || st.Domain != "10.0.0.5.nip.io" {
		t.Errorf("nothing up: %+v", st)
	}

	// Crew's own status page on a free port stands in for the proxy binding.
	l, port := serveOnFreePort(t, proxyPageMarker)
	if err := EnsureProxy("10.0.0.5.nip.io", port); err != nil {
		t.Fatal(err)
	}
	st := InspectProxy()
	if !st.Running || !st.Listening || st.Domain != "10.0.0.5.nip.io" || st.Port != port ||
		st.URL != fmt.Sprintf("http://10.0.0.5:%d/", port) {
		t.Errorf("listening: %+v", st)
	}
	if w := ProxyWarning(port); w != "" {
		t.Errorf("listening port should not warn: %q", w)
	}

	// Session up, nothing bound: the case a user cannot tell from the URLs.
	l.Close()
	st = InspectProxy()
	if !st.Running || st.Listening {
		t.Errorf("dead listener: %+v", st)
	}
	if w := ProxyWarning(port); !strings.Contains(w, fmt.Sprintf("not answering on :%d", port)) {
		t.Errorf("warning = %q", w)
	}
}

// Something else on the port — another app on :80 — answers a dial but is
// not crew's proxy; the URLs would go to it. That must read as not
// listening, not as fine.
func TestInspectProxy_ForeignServerIsNotListening(t *testing.T) {
	isolateProxy(t)
	setupTestConfig(t)
	stubProxyBinary(t)
	l, port := serveOnFreePort(t, "<h1>some other app</h1>")
	defer l.Close()
	if err := EnsureProxy("10.0.0.5.nip.io", port); err != nil {
		t.Fatal(err)
	}
	if st := InspectProxy(); !st.Running || st.Listening {
		t.Errorf("foreign server: %+v", st)
	}
	if w := ProxyWarning(port); !strings.Contains(w, "another server holds the port") {
		t.Errorf("warning = %q", w)
	}
}

// serveOnFreePort is an HTTP server answering every request with body.
func serveOnFreePort(t *testing.T, body string) (net.Listener, int) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go http.Serve(l, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, body) }))
	return l, l.Addr().(*net.TCPAddr).Port
}

func TestPaneError(t *testing.T) {
	pane := "crew dev proxy\nListening on 0.0.0.0:80\nError: listen tcp :80: bind: address already in use\n➜  ~ \n"
	if got := paneError(pane); got != "Error: listen tcp :80: bind: address already in use" {
		t.Errorf("got %q", got)
	}
	if got := paneError("➜  ~ \n"); got != "" {
		t.Errorf("prompt only → %q", got)
	}
	if got := paneError("crew dev proxy\nListening on 0.0.0.0:80\n➜  ~ \n"); got != "" {
		t.Errorf("the banner is not an error → %q", got)
	}
}

// The warning's job is to surface the bind error sitting above the prompt.
func TestProxyWarning_CarriesPaneError(t *testing.T) {
	isolateProxy(t)
	setupTestConfig(t)
	stubProxyBinary(t)
	t.Cleanup(func() { crewExec.KillTmuxSession(ProxySessionName) })

	l, _ := net.Listen("tcp", "127.0.0.1:0")
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	if err := EnsureProxy("10.0.0.5.nip.io", port); err != nil {
		t.Fatal(err)
	}
	crewExec.TmuxSendKeys(ProxySessionName, "echo 'Error: listen tcp: bind: permission denied'")
	if !proxyPaneShows(t, "bind: permission denied") {
		t.Fatal("pane never showed the injected error")
	}
	// The shell decides whether the echoed command or its output survives a
	// prompt redraw; either carries the error text.
	if w := ProxyWarning(port); !strings.Contains(w, "bind: permission denied") {
		t.Errorf("warning = %q", w)
	}
}

// Start with the proxy on and nothing listening ends with a warning, not an
// error — the servers are up either way.
func TestStart_Proxy_WarnsWhenNothingListens(t *testing.T) {
	isolateProxy(t)
	tmp := setupTestConfig(t)
	stubProxyBinary(t)
	slug := Slug("ws--warn")
	t.Cleanup(func() {
		crewExec.KillTmuxSession(SessionName(slug))
		crewExec.KillTmuxSession(ProxySessionName)
	})
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()

	result, err := Start(StartParams{
		Slug:      slug,
		Workspace: "ws",
		Worktree:  "warn",
		Projects:  []DevProject{{Name: "api", Path: tmp, DevServers: []DevServerConfig{{Name: "api", Port: 3000, Command: "sleep 30"}}}},
		Domain:    "10.0.0.5.nip.io",
		ProxyPort: port,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(result.Warnings) != 1 || !strings.Contains(result.Warnings[0], fmt.Sprintf("not answering on :%d", port)) {
		t.Errorf("warnings = %v", result.Warnings)
	}
}

// The proxy's own exit reason beats the pane: a prompt redraw can wipe the
// pane, the record stays.
func TestProxyWarning_UsesRecordedError(t *testing.T) {
	isolateProxy(t)
	setupTestConfig(t)
	stubProxyBinary(t)
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	if err := EnsureProxy("10.0.0.5.nip.io", port); err != nil {
		t.Fatal(err)
	}
	before := proxyPanePID(t)
	RecordProxyError(fmt.Errorf("listen tcp 0.0.0.0:%d: bind: address already in use", port))
	if w := ProxyWarning(port); !strings.Contains(w, "bind: address already in use") {
		t.Errorf("warning = %q", w)
	}
	if st := InspectProxy(); st.Error == "" || st.Listening {
		t.Errorf("status = %+v", st)
	}
	// Same settings, but the proxy died: that is a relaunch, not "already
	// running", and it starts clean.
	if err := EnsureProxy("10.0.0.5.nip.io", port); err != nil {
		t.Fatal(err)
	}
	if after := proxyPanePID(t); after == before {
		t.Error("a dead proxy with unchanged settings must be relaunched")
	}
	if st, _ := loadProxyState(); st.Error != "" {
		t.Errorf("relaunch kept the old error: %+v", st)
	}
}

// A stop-all takes every dev and setup session; the proxy has its own stop
// and anything not crew's is left alone.
func TestSessionsToStop(t *testing.T) {
	all := []string{"crew-dev-ws--main", "crew-setup-ws--wrk2", "crew-dev-proxy", "crew-test-proxy-1", "main", "crew-devel"}
	got := sessionsToStop(all, "crew-dev-proxy")
	if strings.Join(got, ",") != "crew-dev-ws--main,crew-setup-ws--wrk2" {
		t.Errorf("sessions = %v", got)
	}
}

// The dev session's windows each get their own env: the web window's
// command line carries the scoped var, the worker's does not. The pane
// logs hold the command as typed — the positive line is checked first so
// the absence is not vacuous.
func TestStart_PerServerEnv(t *testing.T) {
	if !crewExec.HasTmux() {
		t.Skip("tmux not available")
	}
	setupTestConfig(t)
	slug := Slug("ws--scope")
	t.Cleanup(func() { crewExec.KillTmuxSession(SessionName(slug)) })

	_, err := Start(StartParams{
		Slug: slug, Workspace: "ws", Worktree: "scope", NoProxy: true,
		Projects: []DevProject{{
			Name: "mono", Path: t.TempDir(),
			DevServers: []DevServerConfig{{Name: "web", Port: 3000, Command: "sleep 30"}, {Name: "worker", Port: 3001, Command: "sleep 30"}},
			Bindings:   []Binding{{Var: "API_URL", Value: "http://example.test", Server: "web"}, {Var: "QUEUE_URL", Value: "amqp://q"}},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	read := func(server string) string {
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			data, _ := os.ReadFile(LogFile(slug, server))
			if strings.Contains(string(data), "PORT=") {
				return string(data)
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("%s's log never showed the command", server)
		return ""
	}
	web, worker := read("web"), read("worker")
	if !strings.Contains(web, "export API_URL=") || !strings.Contains(web, "export QUEUE_URL=") {
		t.Errorf("web window:\n%s", web)
	}
	if strings.Contains(worker, "API_URL") || !strings.Contains(worker, "export QUEUE_URL=") {
		t.Errorf("worker window:\n%s", worker)
	}
}

func TestSameLaunch(t *testing.T) {
	p := func(n int) *int { return &n }
	base := proxyState{Domain: "d", Port: 80, HTTPSPort: p(443)}
	cases := []struct {
		name string
		have proxyState
		want bool
	}{
		{"same settings → kept", proxyState{Domain: "d", Port: 80, HTTPSPort: p(443)}, true},
		{"other HTTPS port → relaunch", proxyState{Domain: "d", Port: 80, HTTPSPort: p(8443)}, false},
		{"HTTPS was off, now on → relaunch", proxyState{Domain: "d", Port: 80, HTTPSPort: p(0)}, false},
		{"record from before HTTPS existed → relaunch", proxyState{Domain: "d", Port: 80}, false},
		{"other domain → relaunch", proxyState{Domain: "e", Port: 80, HTTPSPort: p(443)}, false},
	}
	for _, c := range cases {
		if got := sameLaunch(c.have, base); got != c.want {
			t.Errorf("%s: sameLaunch = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestProxyStateReadsPreHTTPSRecord(t *testing.T) {
	setupTestConfig(t)
	if err := os.WriteFile(proxyStatePath(), []byte(`{"domain":"d","port":80}`), 0o644); err != nil {
		t.Fatal(err)
	}
	st, ok := loadProxyState()
	if !ok || st.HTTPSPort != nil || st.Domain != "d" {
		t.Fatalf("old record = %+v, %v; want it read with no HTTPS port", st, ok)
	}
}
