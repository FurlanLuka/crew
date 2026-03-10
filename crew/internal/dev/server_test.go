package dev

import (
	"net"
	"testing"
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
