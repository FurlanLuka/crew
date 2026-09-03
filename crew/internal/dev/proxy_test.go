package dev

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
)

func TestExtractSubdomainParts(t *testing.T) {
	tests := []struct {
		name       string
		host       string
		domain     string
		wantServer string
		wantWS     Slug
	}{
		{"valid nip.io", "api--ws-a.192.168.1.50.nip.io:8080", "192.168.1.50.nip.io", "api", "ws-a"},
		{"no port", "web--ws-b.192.168.1.50.nip.io", "192.168.1.50.nip.io", "web", "ws-b"},
		{"wrong suffix", "api--ws-a.10.0.0.1.nip.io:8080", "192.168.1.50.nip.io", "", ""},
		{"single subdomain only", "ws-a.192.168.1.50.nip.io:8080", "192.168.1.50.nip.io", "", ""},
		{"empty subdomain", "192.168.1.50.nip.io:8080", "192.168.1.50.nip.io", "", ""},
		{"localhost", "localhost:8080", "192.168.1.50.nip.io", "", ""},
		{"bare IP", "192.168.1.50:8080", "192.168.1.50.nip.io", "", ""},
		{"custom domain", "api--ws-a.example.com:8080", "example.com", "api", "ws-a"},
		{"custom domain no port", "web--ws-b.example.com", "example.com", "web", "ws-b"},
		{"custom domain wrong suffix", "api--ws-a.other.com:8080", "example.com", "", ""},
		{"ngrok wildcard", "api--my-ws.luka.ngrok.pro:80", "luka.ngrok.pro", "api", "my-ws"},
		// Worktree slugs carry a second "--"; SplitN at the first one keeps it.
		{"worktree slug", "api--phone-speak--wrk2.dev.local:8080", "dev.local", "api", "phone-speak--wrk2"},
		{"hyphenated worktree", "web--ws--wrk-2.dev.local", "dev.local", "web", "ws--wrk-2"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotServer, gotWS := extractSubdomainParts(tt.host, tt.domain)
			if gotServer != tt.wantServer || gotWS != tt.wantWS {
				t.Errorf("extractSubdomainParts(%q, %q) = (%q, %q), want (%q, %q)",
					tt.host, tt.domain, gotServer, gotWS, tt.wantServer, tt.wantWS)
			}
		})
	}
}

func TestIsWebSocketUpgrade(t *testing.T) {
	tests := []struct {
		name       string
		connection string
		upgrade    string
		want       bool
	}{
		{"valid", "Upgrade", "websocket", true},
		{"case insensitive", "upgrade", "WebSocket", true},
		{"comma separated", "keep-alive, Upgrade", "websocket", true},
		{"comma separated lowercase", "keep-alive, upgrade", "WebSocket", true},
		{"missing upgrade header", "Upgrade", "", false},
		{"missing connection header", "", "websocket", false},
		{"wrong upgrade", "Upgrade", "h2c", false},
		{"both empty", "", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := &http.Request{Header: http.Header{}}
			if tt.connection != "" {
				r.Header.Set("Connection", tt.connection)
			}
			if tt.upgrade != "" {
				r.Header.Set("Upgrade", tt.upgrade)
			}
			got := isWebSocketUpgrade(r)
			if got != tt.want {
				t.Errorf("isWebSocketUpgrade = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestProxyHandler_StatusPage(t *testing.T) {
	h := &proxyHandler{domain: "192.168.1.50.nip.io"}

	req := httptest.NewRequest("GET", "http://192.168.1.50:8080/", nil)
	req.Host = "192.168.1.50:8080"
	w := httptest.NewRecorder()

	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
	body := w.Body.String()
	if !strings.Contains(body, "crew dev proxy") {
		t.Error("status page should contain 'crew dev proxy'")
	}
}

func TestProxyHandler_UnknownSubdomain(t *testing.T) {
	h := &proxyHandler{domain: "192.168.1.50.nip.io"}

	req := httptest.NewRequest("GET", "http://unknown.192.168.1.50.nip.io:8080/", nil)
	req.Host = "unknown.192.168.1.50.nip.io:8080"
	w := httptest.NewRecorder()

	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
	if !strings.Contains(w.Body.String(), "crew dev proxy") {
		t.Error("single subdomain (no --) should show status page")
	}
}

// The plan's central claim: a worktree slug survives the trip through a
// hostname and back with no proxy change.
func TestSubdomainRoundTrip(t *testing.T) {
	for _, slug := range []Slug{"phone-speak--wrk2", "mumbo--main", "legacy"} {
		t.Run(string(slug), func(t *testing.T) {
			u, err := url.Parse(FormatURL("api", slug, "dev.local", 8080))
			if err != nil {
				t.Fatalf("FormatURL produced an unparseable URL: %v", err)
			}
			server, got := extractSubdomainParts(u.Host, "dev.local")
			if server != "api" || got != slug {
				t.Errorf("round trip = (%q, %q), want (api, %q)", server, got, slug)
			}
		})
	}
}

// ServeHTTP matches the request's slug against route files; a worktree slug
// has to reach its backend rather than the status page.
func TestProxyHandler_RoutesToWorktreeSlug(t *testing.T) {
	setupTestConfig(t)

	hit := false
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
		w.WriteHeader(http.StatusNoContent)
	}))
	defer backend.Close()

	port, _ := strconv.Atoi(strings.TrimPrefix(backend.URL, "http://127.0.0.1:"))
	if err := saveRoutes("phone-speak--wrk2", []Route{
		{Project: "speak-api", ServerName: "api", ExternalPort: 3000, InternalPort: port},
	}); err != nil {
		t.Fatalf("saveRoutes: %v", err)
	}

	h := &proxyHandler{domain: "dev.local", port: 8080}
	req := httptest.NewRequest("GET", "http://api--phone-speak--wrk2.dev.local:8080/health", nil)
	req.Host = "api--phone-speak--wrk2.dev.local:8080"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if !hit {
		t.Fatalf("backend not reached; status %d, body %q", rec.Code, rec.Body.String())
	}
	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want the backend's 204", rec.Code)
	}
}
