package config

import (
	"os"
	"path/filepath"
)

const (
	RegistryRepo   = "FurlanLuka/homebrew-tap"
	RegistryBranch = "main"
	RegistryBase   = "registry"
)

var (
	ConfigDir      string
	WorkspacesDir  string
	ClaudeConfigDir string

	// Whether the user explicitly set CLAUDE_CONFIG_DIR
	UserSetClaudeConfig bool
)

func Init() {
	home, _ := os.UserHomeDir()

	ConfigDir = filepath.Join(home, ".crew")
	WorkspacesDir = filepath.Join(ConfigDir, "workspaces")

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
