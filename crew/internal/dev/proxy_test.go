package dev

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestExtractSubdomain(t *testing.T) {
	tests := []struct {
		name   string
		host   string
		baseIP string
		want   string
	}{
		{"valid", "feature-a.192.168.1.50.nip.io:5173", "192.168.1.50", "feature-a"},
		{"no port", "feature-a.192.168.1.50.nip.io", "192.168.1.50", "feature-a"},
		{"wrong suffix", "feature-a.10.0.0.1.nip.io:5173", "192.168.1.50", ""},
		{"nested dots", "a.b.192.168.1.50.nip.io:5173", "192.168.1.50", ""},
		{"empty subdomain", "192.168.1.50.nip.io:5173", "192.168.1.50", ""},
		{"localhost", "localhost:5173", "192.168.1.50", ""},
		{"bare IP", "192.168.1.50:5173", "192.168.1.50", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractSubdomain(tt.host, tt.baseIP)
			if got != tt.want {
				t.Errorf("extractSubdomain(%q, %q) = %q, want %q", tt.host, tt.baseIP, got, tt.want)
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
	h := &proxyHandler{
		host:   "192.168.1.50",
		port:   5173,
		routes: []Route{{Subdomain: "main", ExternalPort: 5173, InternalPort: 49001}},
		all:    map[int][]Route{5173: {{Subdomain: "main", ExternalPort: 5173, InternalPort: 49001}}},
	}

	req := httptest.NewRequest("GET", "http://192.168.1.50:5173/", nil)
	req.Host = "192.168.1.50:5173"
	w := httptest.NewRecorder()

	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
	body := w.Body.String()
	if !strings.Contains(body, "crew dev proxy") {
		t.Error("status page should contain 'crew dev proxy'")
	}
	if !strings.Contains(body, "main") {
		t.Error("status page should list routes")
	}
}

func TestProxyHandler_ReverseProxy(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("backend-response"))
	}))
	defer backend.Close()

	// Extract port from http://127.0.0.1:PORT
	idx := strings.LastIndex(backend.URL, ":")
	backendPort, _ := strconv.Atoi(backend.URL[idx+1:])

	h := &proxyHandler{
		host:   "192.168.1.50",
		port:   5173,
		routes: []Route{{Subdomain: "app", ExternalPort: 5173, InternalPort: backendPort}},
		all:    map[int][]Route{5173: {{Subdomain: "app", ExternalPort: 5173, InternalPort: backendPort}}},
	}

	req := httptest.NewRequest("GET", "http://app.192.168.1.50.nip.io:5173/", nil)
	req.Host = "app.192.168.1.50.nip.io:5173"
	w := httptest.NewRecorder()

	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
	if !strings.Contains(w.Body.String(), "backend-response") {
		t.Error("response should contain backend content")
	}
}

func TestProxyHandler_UnknownSubdomain(t *testing.T) {
	h := &proxyHandler{
		host:   "192.168.1.50",
		port:   5173,
		routes: []Route{{Subdomain: "main", ExternalPort: 5173, InternalPort: 49001}},
		all:    map[int][]Route{5173: {{Subdomain: "main", ExternalPort: 5173, InternalPort: 49001}}},
	}

	req := httptest.NewRequest("GET", "http://unknown.192.168.1.50.nip.io:5173/", nil)
	req.Host = "unknown.192.168.1.50.nip.io:5173"
	w := httptest.NewRecorder()

	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
	if !strings.Contains(w.Body.String(), "crew dev proxy") {
		t.Error("unknown subdomain should show status page")
	}
}
