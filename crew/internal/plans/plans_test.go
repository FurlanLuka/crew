package plans

import (
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

func setupTestConfig(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	config.ConfigDir = tmp
	config.WorkspacesDir = filepath.Join(tmp, "workspaces")
	config.ClaudeConfigDir = filepath.Join(tmp, "claude")
	os.MkdirAll(config.WorkspacesDir, 0o755)
	os.MkdirAll(config.ClaudeConfigDir, 0o755)
	return tmp
}

func TestLoadConfig_Defaults(t *testing.T) {
	setupTestConfig(t)

	cfg := LoadConfig()
	if cfg.Enabled {
		t.Error("default config should have Enabled=false")
	}
	if cfg.Port != 80 {
		t.Errorf("default config Port = %d, want 80", cfg.Port)
	}
}

func TestLoadConfig_CustomPort(t *testing.T) {
	tmp := setupTestConfig(t)

	data := []byte(`{"enabled": true, "port": 9090}`)
	os.WriteFile(filepath.Join(tmp, "plans.json"), data, 0o644)

	cfg := LoadConfig()
	if !cfg.Enabled {
		t.Error("Enabled should be true")
	}
	if cfg.Port != 9090 {
		t.Errorf("Port = %d, want 9090", cfg.Port)
	}
}

func TestSaveConfig_RoundTrip(t *testing.T) {
	setupTestConfig(t)

	want := Config{Enabled: true, Port: 3000}
	if err := SaveConfig(want); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}

	got := LoadConfig()
	if got.Enabled != want.Enabled {
		t.Errorf("Enabled = %v, want %v", got.Enabled, want.Enabled)
	}
	if got.Port != want.Port {
		t.Errorf("Port = %d, want %d", got.Port, want.Port)
	}
}

func TestSaveConfig_CreatesDir(t *testing.T) {
	tmp := t.TempDir()
	config.ConfigDir = filepath.Join(tmp, "nested", "crew")

	if err := SaveConfig(Config{Port: 80}); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}

	if _, err := os.Stat(config.ConfigDir); err != nil {
		t.Errorf("SaveConfig should create ConfigDir: %v", err)
	}
}

func TestIsInstalled(t *testing.T) {
	// Just verify it returns without panicking
	_ = IsInstalled()
}

func TestIsRunning(t *testing.T) {
	// No tmux session named "crew-plans" should exist in test
	if IsRunning() {
		t.Skip("crew-plans tmux session exists, skipping")
	}
}

func TestURL(t *testing.T) {
	u := URL()

	parsed, err := url.Parse(u)
	if err != nil {
		t.Fatalf("URL() = %q is not parseable: %v", u, err)
	}
	if parsed.Scheme != "http" {
		t.Errorf("scheme = %q, want http", parsed.Scheme)
	}
	if parsed.Host == "" {
		t.Error("host is empty")
	}
	// Should start with "plans." and end with ".nip.io"
	host := parsed.Hostname()
	if len(host) < len("plans.x.nip.io") {
		t.Errorf("host %q looks too short", host)
	}
	if host[:6] != "plans." {
		t.Errorf("host %q should start with 'plans.'", host)
	}
	if host[len(host)-7:] != ".nip.io" {
		t.Errorf("host %q should end with '.nip.io'", host)
	}
}
