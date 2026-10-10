package exec

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/debug"
)

// HasClaude checks if claude CLI is available.
func HasClaude() bool {
	_, err := exec.LookPath("claude")
	return err == nil
}

// InstalledPlugin is one row of `claude plugin list --json`.
type InstalledPlugin struct {
	ID      string `json:"id"`
	Version string `json:"version"`
	Scope   string `json:"scope"`
	Enabled bool   `json:"enabled"`
}

// ClaudePlugins lists the plugins Claude Code has installed, with the same
// config dir crew launches it with. Five seconds at most: it runs before a
// launch, and a hung claude must not hold one up.
func ClaudePlugins(claudeBin, configDir string) ([]InstalledPlugin, error) {
	out, err := claudeOutput(claudeBin, configDir, "plugin", "list", "--json")
	if err != nil {
		return nil, err
	}
	return ParsePlugins(out)
}

// ParsePlugins reads `claude plugin list --json`. Pure.
func ParsePlugins(data []byte) ([]InstalledPlugin, error) {
	var list []InstalledPlugin
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, fmt.Errorf("claude plugin list: %w", err)
	}
	return list, nil
}

// ClaudeVersion is the version `claude --version` reports ("2.1.295").
func ClaudeVersion(claudeBin string) (string, error) {
	out, err := claudeOutput(claudeBin, "", "--version")
	if err != nil {
		return "", err
	}
	fields := strings.Fields(string(out))
	if len(fields) == 0 {
		return "", fmt.Errorf("claude --version printed nothing")
	}
	return fields[0], nil
}

func claudeOutput(claudeBin, configDir string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	debug.Log("claude", "%s %s", claudeBin, strings.Join(args, " "))
	cmd := exec.CommandContext(ctx, claudeBin, args...)
	if configDir != "" {
		cmd.Env = append(os.Environ(), "CLAUDE_CONFIG_DIR="+configDir)
	}
	out, err := cmd.Output()
	if err != nil {
		debug.Log("claude", "%s → error: %v", args[0], err)
	}
	return out, err
}

// ClaudeBinary is claude's absolute path, or "" when it is not on PATH.
func ClaudeBinary() string {
	path, err := exec.LookPath("claude")
	if err != nil {
		return ""
	}
	if abs, err := filepath.Abs(path); err == nil {
		return abs
	}
	return path
}
