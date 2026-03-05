package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSettingsFilePath(t *testing.T) {
	tmp := t.TempDir()
	ConfigDir = tmp

	want := filepath.Join(tmp, "config.json")
	got := SettingsFilePath()
	if got != want {
		t.Errorf("SettingsFilePath() = %q, want %q", got, want)
	}
}

func TestLoadSettings_Missing(t *testing.T) {
	tmp := t.TempDir()
	ConfigDir = tmp

	s := LoadSettings()
	if s.ServerIP != "" {
		t.Errorf("ServerIP = %q, want empty for missing file", s.ServerIP)
	}
}

func TestLoadSettings_Invalid(t *testing.T) {
	tmp := t.TempDir()
	ConfigDir = tmp

	os.WriteFile(filepath.Join(tmp, "config.json"), []byte("not json"), 0o644)

	s := LoadSettings()
	if s.ServerIP != "" {
		t.Errorf("ServerIP = %q, want empty for invalid JSON", s.ServerIP)
	}
}

func TestSaveAndLoadSettings(t *testing.T) {
	tmp := t.TempDir()
	ConfigDir = tmp

	want := Settings{ServerIP: "10.0.0.5"}
	if err := SaveSettings(want); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}

	got := LoadSettings()
	if got.ServerIP != want.ServerIP {
		t.Errorf("ServerIP = %q, want %q", got.ServerIP, want.ServerIP)
	}
}

func TestSaveSettings_OmitsEmpty(t *testing.T) {
	tmp := t.TempDir()
	ConfigDir = tmp

	if err := SaveSettings(Settings{}); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(tmp, "config.json"))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}

	// Empty settings should produce minimal JSON without server_ip key
	content := string(data)
	if content != "{}" {
		t.Errorf("got %q, want %q", content, "{}")
	}
}
