package profile

import (
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

func TestPath(t *testing.T) {
	setupTestConfig(t)

	got := Path()
	want := filepath.Join(config.ClaudeConfigDir, "CLAUDE.md")
	if got != want {
		t.Errorf("Path() = %q, want %q", got, want)
	}
}

func TestIsInstalled(t *testing.T) {
	setupTestConfig(t)

	if IsInstalled() {
		t.Error("IsInstalled should be false before install")
	}

	// Manually create the file
	os.WriteFile(Path(), []byte("# Profile"), 0o644)

	if !IsInstalled() {
		t.Error("IsInstalled should be true after file exists")
	}
}

func TestInstallAndContent(t *testing.T) {
	setupTestConfig(t)

	// We can't test Install() directly since it calls FetchRaw (network).
	// Instead, test the Content() function with a manually created file.
	content := "# Test Profile\n\nSome instructions here."
	os.WriteFile(Path(), []byte(content), 0o644)

	got, err := Content()
	if err != nil {
		t.Fatalf("Content: %v", err)
	}
	if got != content {
		t.Errorf("Content = %q, want %q", got, content)
	}
}

func TestRemove(t *testing.T) {
	setupTestConfig(t)

	os.WriteFile(Path(), []byte("# Profile"), 0o644)
	if !IsInstalled() {
		t.Fatal("profile should be installed")
	}

	if err := Remove(); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	if IsInstalled() {
		t.Error("IsInstalled should be false after Remove")
	}
}
