package workspace

import (
	"fmt"
	"os/exec"
	"strings"

	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
)

// buildClaudeParts builds the shell-command tokens (env assignments inlined,
// followed by `claude` and its flags) plus the directory Claude should start in.
//
// When noTeams is true and the workspace has multiple projects, Claude runs as a
// single flat instance at the workspace root with every worktree exposed via
// --add-dir — no agent-team coordination. Otherwise multi-project workspaces
// launch in agent-team mode.
//
// The prompt is passed via $(cat ...) so the shell reads the file rather than
// inlining multi-line content (which would break tmux keystroke sends on
// newlines and hit terminal input buffer limits).
func buildClaudeParts(wsName string, skipPermissions, noTeams bool) ([]string, string, error) {
	ws, err := Load(wsName)
	if err != nil {
		return nil, "", err
	}
	if len(ws.Projects) == 0 {
		return nil, "", fmt.Errorf("workspace '%s' has no projects", wsName)
	}

	multiProject := len(ws.Projects) > 1
	teams := multiProject && !noTeams

	var parts []string

	if skipPermissions {
		parts = append(parts, "IS_SANDBOX=1")
	}
	if config.UserSetClaudeConfig {
		parts = append(parts, "CLAUDE_CONFIG_DIR="+shellQuote(config.ClaudeConfigDir))
	}

	workDir := ResolvePath(wsName, ws.Projects[0])
	if multiProject {
		workDir = WorkspaceDir(wsName)
	}
	if teams {
		parts = append(parts, "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1")
	}

	parts = append(parts, "claude")

	if skipPermissions {
		parts = append(parts, "--dangerously-skip-permissions")
	}

	if multiProject {
		for _, wp := range ws.Projects {
			parts = append(parts, "--add-dir", shellQuote(ResolvePath(wsName, wp)))
		}
	}

	switch {
	case teams:
		if _, err := GeneratePrompt(ws); err != nil {
			return nil, "", err
		}
		parts = append(parts, "--teammate-mode", "in-process", "--", "\"$(cat "+shellQuote(PromptFilePath(wsName))+")\"")
	case multiProject && noTeams:
		if _, err := GenerateNoTeamsPrompt(ws); err != nil {
			return nil, "", err
		}
		parts = append(parts, "--", "\"$(cat "+shellQuote(NoTeamsPromptFilePath(wsName))+")\"")
	}

	return parts, workDir, nil
}

// ClaudeCommand returns an *exec.Cmd that runs Claude directly in the current
// terminal. Use with tea.ExecProcess from a Bubbletea TUI: the TUI suspends,
// Claude takes over the terminal, and control returns when Claude exits.
// Nothing is tracked — there's no session to reattach to.
func ClaudeCommand(wsName string, skipPermissions, noTeams bool) (*exec.Cmd, error) {
	if !crewExec.HasClaude() {
		return nil, fmt.Errorf("claude not found — install Claude Code first")
	}

	parts, workDir, err := buildClaudeParts(wsName, skipPermissions, noTeams)
	if err != nil {
		return nil, err
	}

	cmdStr := strings.Join(parts, " ")
	debug.Log("claude", "direct run in %s → %s", workDir, cmdStr)

	cmd := exec.Command("sh", "-c", cmdStr)
	cmd.Dir = workDir
	return cmd, nil
}

// shellQuote wraps a string in single quotes, escaping embedded single quotes.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'"
}
