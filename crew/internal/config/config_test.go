package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInit(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	os.Unsetenv("CLAUDE_CONFIG_DIR")

	Init()

	home, _ := os.UserHomeDir()

	if ConfigDir != filepath.Join(home, ".crew") {
		t.Errorf("ConfigDir = %q, want %q", ConfigDir, filepath.Join(home, ".crew"))
	}
	if WorkspacesDir != filepath.Join(home, ".crew", "workspaces") {
		t.Errorf("WorkspacesDir = %q, want %q", WorkspacesDir, filepath.Join(home, ".crew", "workspaces"))
	}
	if ClaudeConfigDir != filepath.Join(home, ".claude") {
		t.Errorf("ClaudeConfigDir = %q, want %q", ClaudeConfigDir, filepath.Join(home, ".claude"))
	}
	if UserSetClaudeConfig {
		t.Error("UserSetClaudeConfig should be false when env is unset")
	}
}

func TestInit_WithClaudeConfigDir(t *testing.T) {
	tmp := t.TempDir()
	customDir := filepath.Join(tmp, "custom-claude")

	t.Setenv("CLAUDE_CONFIG_DIR", customDir)

	Init()

	if ClaudeConfigDir != customDir {
		t.Errorf("ClaudeConfigDir = %q, want %q", ClaudeConfigDir, customDir)
	}
	if !UserSetClaudeConfig {
		t.Error("UserSetClaudeConfig should be true when env is set")
	}
}

func TestWorkspaceFile(t *testing.T) {
	tmp := t.TempDir()
	WorkspacesDir = tmp

	tests := []struct {
		name string
		want string
	}{
		{"myws", filepath.Join(tmp, "myws.json")},
		{"test-workspace", filepath.Join(tmp, "test-workspace.json")},
		{"ws--worktree", filepath.Join(tmp, "ws--worktree.json")},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := WorkspaceFile(tt.name)
			if got != tt.want {
				t.Errorf("WorkspaceFile(%q) = %q, want %q", tt.name, got, tt.want)
			}
		})
	}
}
