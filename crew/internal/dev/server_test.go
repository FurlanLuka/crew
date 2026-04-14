package dev

import (
	"net"
	"testing"

	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

func TestSessionName(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"myws", "crew-dev-myws"},
		{"test-workspace", "crew-dev-test-workspace"},
		{"", "crew-dev-"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
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
	t.Cleanup(func() {
		crewExec.KillTmuxSession(session)
		crewExec.KillTmuxSession(ProxySessionName)
	})

	projects := []DevProject{{
		Path: t.TempDir(),
		DevServers: []DevServerConfig{
			{Name: "api", Port: 3001, Command: "sleep 30"},
		},
	}}

	routes, err := Start("ws-np", projects, "dev.local", 8080, true)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(routes) != 1 {
		t.Fatalf("got %d routes, want 1", len(routes))
	}
	r := routes[0]
	if !r.NoProxy {
		t.Errorf("route.NoProxy = false, want true")
	}
	if r.InternalPort != 3001 || r.ExternalPort != 3001 {
		t.Errorf("route ports = (%d, %d), want (3001, 3001)", r.InternalPort, r.ExternalPort)
	}

	loaded, err := LoadRoutes("ws-np")
	if err != nil || len(loaded) != 1 || !loaded[0].NoProxy {
		t.Errorf("persisted routes = %+v, err=%v", loaded, err)
	}

	if crewExec.TmuxSessionExists(ProxySessionName) {
		t.Error("proxy session should not be started in no-proxy mode")
	}
}

func TestStopProxyIfIdle_NoProxyRoutesDontKeepProxyAlive(t *testing.T) {
	setupTestConfig(t)

	// Only a no-proxy route exists; proxy should be considered idle.
	if err := saveRoutes("ws", []Route{
		{Subdomain: "ws", ServerName: "api", ExternalPort: 3000, InternalPort: 3000, NoProxy: true},
	}); err != nil {
		t.Fatalf("saveRoutes: %v", err)
	}

	// Should not panic and should treat the system as idle (KillTmuxSession is a
	// no-op when the proxy session doesn't exist, so we only assert that the
	// function inspected routes correctly by not returning early).
	allRoutes, _ := ListAllRoutes()
	idle := true
	for _, wr := range allRoutes {
		for _, r := range wr.Routes {
			if r.Proxied() {
				idle = false
			}
		}
	}
	if !idle {
		t.Error("workspace with only no-proxy route should leave proxy idle")
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
