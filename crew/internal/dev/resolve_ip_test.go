package dev

import (
	"net"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

func TestResolveHostIP_UsesSettingsWhenSet(t *testing.T) {
	tmp := t.TempDir()
	config.ConfigDir = tmp

	if err := config.SaveSettings(config.Settings{ServerIP: "10.0.0.99"}); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}

	got := ResolveHostIP()
	if got != "10.0.0.99" {
		t.Errorf("ResolveHostIP() = %q, want %q", got, "10.0.0.99")
	}
}

func TestResolveHostIP_FallsBackToLANIP(t *testing.T) {
	tmp := t.TempDir()
	config.ConfigDir = tmp

	// No config file — should fall back to DetectLANIP
	got := ResolveHostIP()
	if got == "" {
		t.Fatal("ResolveHostIP() returned empty string")
	}

	parsed := net.ParseIP(got)
	if parsed == nil {
		t.Errorf("ResolveHostIP() = %q, not a valid IP", got)
	}
}

func TestResolveHostIP_IgnoresEmptyServerIP(t *testing.T) {
	tmp := t.TempDir()
	config.ConfigDir = tmp

	// Save settings with empty ServerIP
	if err := config.SaveSettings(config.Settings{}); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}

	got := ResolveHostIP()
	// Should fall back to DetectLANIP, not return empty
	if got == "" {
		t.Fatal("ResolveHostIP() returned empty string")
	}
}
