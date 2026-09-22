package config

import (
	"os"
	"path/filepath"
	"strings"
)

// Repo is where releases come from, for `crew update`.
const Repo = "FurlanLuka/crew"

var (
	ConfigDir       string
	WorkspacesDir   string
	ClaudeConfigDir string
	// TrashDir holds removed checkouts until a background delete clears them;
	// same volume as WorkspacesDir so the move there is a rename.
	TrashDir string
	// ProjectsDir holds the canonical clones crew made itself from a URL —
	// the one place besides WorkspacesDir crew is allowed to remove from.
	ProjectsDir string

	// Whether the user explicitly set CLAUDE_CONFIG_DIR
	UserSetClaudeConfig bool
)

func Init() {
	home, _ := os.UserHomeDir()

	ConfigDir = filepath.Join(home, ".crew")
	WorkspacesDir = filepath.Join(ConfigDir, "workspaces")
	TrashDir = filepath.Join(ConfigDir, "trash")
	ProjectsDir = filepath.Join(ConfigDir, "projects")

	raw := os.Getenv("CLAUDE_CONFIG_DIR")
	UserSetClaudeConfig = raw != ""
	if raw != "" {
		ClaudeConfigDir = raw
	} else {
		ClaudeConfigDir = filepath.Join(home, ".claude")
	}

	os.MkdirAll(WorkspacesDir, 0o755)
}

func WorkspaceFile(name string) string {
	return filepath.Join(WorkspacesDir, name+".json")
}

// Under: path is strictly inside root — never the root itself, never a
// sibling that shares its prefix ("projects-old" beside "projects"). The
// one spelling of the guard every removal checks against.
func Under(path, root string) bool {
	if root == "" {
		return false
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	return strings.HasPrefix(abs, rootAbs+string(filepath.Separator))
}
