package dev

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestExtractSubdomainParts(t *testing.T) {
	tests := []struct {
		name       string
		host       string
		domain     string
		wantServer string
		wantWS     string
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
