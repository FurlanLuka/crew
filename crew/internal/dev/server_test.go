package dev

import (
	"net"
	"testing"

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
	if !crewExec.HasTmux() {
		t.Skip("tmux not available")
	}
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
	if !crewExec.HasTmux() {
		t.Skip("tmux not available")
	}
	setupTestConfig(t)
	t.Cleanup(func() { crewExec.KillTmuxSession(ProxySessionName) })

	if err := crewExec.CreateTmuxSession(ProxySessionName, ""); err != nil {
		t.Fatalf("CreateTmuxSession: %v", err)
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
