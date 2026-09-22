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

func TestUnder(t *testing.T) {
	root := t.TempDir()
	for path, want := range map[string]bool{
		root + "/api":         true,
		root + "/api/deep":    true,
		root:                  false,
		root + "/":            false,
		root + "-old/api":     false,
		root + "/api/../../x": false,
		"/tmp":                false,
	} {
		if got := Under(path, root); got != want {
			t.Errorf("Under(%s, root) = %v, want %v", path, got, want)
		}
	}
	if Under(root+"/api", "") {
		t.Error("an empty root holds nothing")
	}
}

func TestExpandHome(t *testing.T) {
	home, _ := os.UserHomeDir()
	for in, want := range map[string]string{
		"~/x":     filepath.Join(home, "x"),
		"~/a/b":   filepath.Join(home, "a", "b"),
		"~":       "~",
		"~user/x": "~user/x",
		"/abs":    "/abs",
		"rel":     "rel",
		"":        "",
	} {
		if got := ExpandHome(in); got != want {
			t.Errorf("ExpandHome(%q) = %q, want %q", in, got, want)
		}
	}
}

// Tildify is ExpandHome the other way.
func TestTildify(t *testing.T) {
	home, _ := os.UserHomeDir()
	if got := Tildify(filepath.Join(home, ".crew", "projects", "api")); got != "~/.crew/projects/api" {
		t.Errorf("%q", got)
	}
	if got := Tildify("/opt/api"); got != "/opt/api" {
		t.Errorf("outside home stays: %q", got)
	}
	if got := Tildify(home); got != home {
		t.Errorf("the home dir itself is not a child of it: %q", got)
	}
}
