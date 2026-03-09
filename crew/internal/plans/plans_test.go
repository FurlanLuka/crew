package plans

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
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
	if cfg.Port != 3080 {
		t.Errorf("default config Port = %d, want 3080", cfg.Port)
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

func TestLoadConfig_MigratesPort80(t *testing.T) {
	tmp := setupTestConfig(t)

	data := []byte(`{"enabled": true, "port": 80}`)
	os.WriteFile(filepath.Join(tmp, "plans.json"), data, 0o644)

	cfg := LoadConfig()
	if cfg.Port != 3080 {
		t.Errorf("Port = %d, want 3080 (migrated from 80)", cfg.Port)
	}
}

func TestIsRunning(t *testing.T) {
	// No tmux session named "crew-plans" should exist in test
	if IsRunning() {
		t.Skip("crew-plans tmux session exists, skipping")
	}
}

func TestURL_DefaultDomain(t *testing.T) {
	setupTestConfig(t)

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
	// Should start with "plans." and end with ".nip.io" (default behavior)
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

func TestURL_CustomDomain(t *testing.T) {
	tmp := setupTestConfig(t)

	// Set custom domain
	settingsData := []byte(`{"domain": "example.com"}`)
	os.WriteFile(filepath.Join(tmp, "config.json"), settingsData, 0o644)

	u := URL()

	parsed, err := url.Parse(u)
	if err != nil {
		t.Fatalf("URL() = %q is not parseable: %v", u, err)
	}
	host := parsed.Hostname()
	if host[:6] != "plans." {
		t.Errorf("host %q should start with 'plans.'", host)
	}
	if !strings.HasSuffix(host, ".example.com") {
		t.Errorf("host %q should end with '.example.com'", host)
	}
}
