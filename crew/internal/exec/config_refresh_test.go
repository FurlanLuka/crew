package exec

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

func TestEnsureTmuxConfig_CreatesWhenMissing(t *testing.T) {
	tmp := t.TempDir()
	config.ConfigDir = tmp

	EnsureTmuxConfig()

	data, err := os.ReadFile(TmuxConfigPath())
	if err != nil {
		t.Fatalf("config not created: %v", err)
	}
	if !strings.HasPrefix(string(data), "# crew-config") {
		t.Errorf("config missing version header, got: %q", string(data)[:40])
	}
}

func TestEnsureTmuxConfig_OverwritesCrewManaged(t *testing.T) {
	tmp := t.TempDir()
	config.ConfigDir = tmp

	cfgFile := filepath.Join(tmp, "tmux.conf")
	os.WriteFile(cfgFile, []byte("# crew-managed tmux config\nold content\n"), 0o644)

	EnsureTmuxConfig()

	data, _ := os.ReadFile(cfgFile)
	if strings.Contains(string(data), "old content") {
		t.Error("crew-managed config was not overwritten")
	}
	if !strings.HasPrefix(string(data), "# crew-config v2") {
		t.Errorf("config missing new version header, got: %q", string(data)[:40])
	}
}

func TestEnsureTmuxConfig_LeavesUserCustomized(t *testing.T) {
	tmp := t.TempDir()
	config.ConfigDir = tmp

	cfgFile := filepath.Join(tmp, "tmux.conf")
	userContent := "set -g status off\n"
	os.WriteFile(cfgFile, []byte(userContent), 0o644)

	EnsureTmuxConfig()

	data, _ := os.ReadFile(cfgFile)
	if string(data) != userContent {
		t.Errorf("user config was modified, got: %q", string(data))
	}
}

func TestEnsureLazygitConfig_CreatesWhenMissing(t *testing.T) {
	tmp := t.TempDir()
	config.ConfigDir = tmp

	EnsureLazygitConfig()

	cfgFile := filepath.Join(LazygitConfigDir(), "config.yml")
	data, err := os.ReadFile(cfgFile)
	if err != nil {
		t.Fatalf("config not created: %v", err)
	}
	if !strings.HasPrefix(string(data), "# crew-config") {
		t.Errorf("config missing version header, got: %q", string(data)[:40])
	}
}

func TestEnsureLazygitConfig_OverwritesCrewManaged(t *testing.T) {
	tmp := t.TempDir()
	config.ConfigDir = tmp

	dir := LazygitConfigDir()
	os.MkdirAll(dir, 0o755)
	cfgFile := filepath.Join(dir, "config.yml")
	os.WriteFile(cfgFile, []byte("# crew-config v1\nold stuff\n"), 0o644)

	EnsureLazygitConfig()

	data, _ := os.ReadFile(cfgFile)
	if strings.Contains(string(data), "old stuff") {
		t.Error("crew-managed config was not overwritten")
	}
	if !strings.HasPrefix(string(data), "# crew-config v2") {
		t.Errorf("config missing new version header, got: %q", string(data)[:40])
	}
}

func TestEnsureLazygitConfig_LeavesUserCustomized(t *testing.T) {
	tmp := t.TempDir()
	config.ConfigDir = tmp

	dir := LazygitConfigDir()
	os.MkdirAll(dir, 0o755)
	cfgFile := filepath.Join(dir, "config.yml")
	userContent := "gui:\n  theme: dark\n"
	os.WriteFile(cfgFile, []byte(userContent), 0o644)

	EnsureLazygitConfig()

	data, _ := os.ReadFile(cfgFile)
	if string(data) != userContent {
		t.Errorf("user config was modified, got: %q", string(data))
	}
}
