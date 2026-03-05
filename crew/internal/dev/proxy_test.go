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
		baseIP     string
		wantServer string
		wantWS     string
	}{
		{"valid nested", "api.ws-a.192.168.1.50.nip.io:8080", "192.168.1.50", "api", "ws-a"},
		{"no port", "web.ws-b.192.168.1.50.nip.io", "192.168.1.50", "web", "ws-b"},
		{"wrong suffix", "api.ws-a.10.0.0.1.nip.io:8080", "192.168.1.50", "", ""},
		{"single subdomain only", "ws-a.192.168.1.50.nip.io:8080", "192.168.1.50", "", ""},
		{"empty subdomain", "192.168.1.50.nip.io:8080", "192.168.1.50", "", ""},
		{"localhost", "localhost:8080", "192.168.1.50", "", ""},
		{"bare IP", "192.168.1.50:8080", "192.168.1.50", "", ""},
		{"triple nested", "a.b.c.192.168.1.50.nip.io:8080", "192.168.1.50", "a", "b.c"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotServer, gotWS := extractSubdomainParts(tt.host, tt.baseIP)
			if gotServer != tt.wantServer || gotWS != tt.wantWS {
				t.Errorf("extractSubdomainParts(%q, %q) = (%q, %q), want (%q, %q)",
					tt.host, tt.baseIP, gotServer, gotWS, tt.wantServer, tt.wantWS)
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
	h := &proxyHandler{host: "192.168.1.50"}

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
	h := &proxyHandler{host: "192.168.1.50"}

	req := httptest.NewRequest("GET", "http://unknown.192.168.1.50.nip.io:8080/", nil)
	req.Host = "unknown.192.168.1.50.nip.io:8080"
	w := httptest.NewRecorder()

	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
	if !strings.Contains(w.Body.String(), "crew dev proxy") {
		t.Error("single subdomain (no nested) should show status page")
	}
}
