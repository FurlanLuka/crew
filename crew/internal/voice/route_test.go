package voice

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// An already-up server rewrites a route a sweep or a crashed stop dropped,
// and leaves a correct one alone.
func TestEnsureRoute(t *testing.T) {
	saved := config.ConfigDir
	config.ConfigDir = t.TempDir()
	t.Cleanup(func() { config.ConfigDir = saved })
	slug := dev.Slug(workspace.VoiceSlug)

	ensureRoute(47811)
	routes, err := dev.LoadRoutes(slug)
	if err != nil || !routeServes(routes, 47811) {
		t.Fatalf("missing route not rewritten: %+v %v", routes, err)
	}
	ensureRoute(47812)
	routes, _ = dev.LoadRoutes(slug)
	if len(routes) != 1 || !routeServes(routes, 47812) {
		t.Errorf("a route for another port must be replaced: %+v", routes)
	}
}

func TestRouteServes(t *testing.T) {
	voiceRoute := dev.Route{ServerName: RouteServer, ExternalPort: 9, InternalPort: 9}
	for _, tt := range []struct {
		name   string
		routes []dev.Route
		want   bool
	}{
		{"none", nil, false},
		{"same port", []dev.Route{voiceRoute}, true},
		{"other port", []dev.Route{{ServerName: RouteServer, InternalPort: 8}}, false},
		{"other server", []dev.Route{{ServerName: "web", InternalPort: 9}}, false},
	} {
		if got := routeServes(tt.routes, 9); got != tt.want {
			t.Errorf("%s: got %v", tt.name, got)
		}
	}
}

// Over SSH the proxy link is printed only when the proxy, asked for the
// server's hostname, reaches it.
func TestRouteAnswers(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host == ProxyHost("10.0.0.2.nip.io") && r.URL.Path == "/healthz" {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()
	port := srv.Listener.Addr().(*net.TCPAddr).Port

	if !routeAnswers(port, ProxyHost("10.0.0.2.nip.io")) {
		t.Error("the server's hostname answers: the route works")
	}
	if routeAnswers(port, ProxyHost("other.example.com")) {
		t.Error("another hostname is not the server's route")
	}
	if routeAnswers(0, ProxyHost("10.0.0.2.nip.io")) {
		t.Error("no proxy port: nothing answers")
	}
}

func TestIsLoopbackDomain(t *testing.T) {
	for domain, want := range map[string]bool{
		"":                 true,
		"localhost":        true,
		"127.0.0.1.nip.io": true,
		"10.0.0.2.nip.io":  false,
		"dev.example.com":  false,
	} {
		if got := isLoopbackDomain(domain); got != want {
			t.Errorf("isLoopbackDomain(%q) = %v", domain, got)
		}
	}
}
