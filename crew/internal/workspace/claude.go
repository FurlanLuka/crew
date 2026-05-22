package workspace

import (
	"fmt"
	"os/exec"
	"strings"

	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
)

func claudeSessionName(wsName string) string {
	return "crew-claude-" + wsName
}

// ClaudeSessionExists checks if a Claude tmux session exists for the workspace.
func ClaudeSessionExists(wsName string) bool {
	return crewExec.TmuxSessionExists(claudeSessionName(wsName))
}

// KillClaudeSession kills the Claude tmux session for the workspace.
func KillClaudeSession(wsName string) {
	crewExec.KillTmuxSession(claudeSessionName(wsName))
}

// CreateClaudeSession creates a tmux session running Claude for the workspace.
// Returns the session name.
//
// When noTeams is true and the workspace has multiple projects, Claude runs as a
// single flat instance at the workspace root with every worktree exposed via
// --add-dir — no agent-team coordination. Otherwise multi-project workspaces
// launch in agent-team mode.
func CreateClaudeSession(wsName string, skipPermissions, noTeams bool) (string, error) {
	if !crewExec.HasClaude() {
		return "", fmt.Errorf("claude not found — install Claude Code first")
	}
	if !crewExec.HasTmux() {
		return "", fmt.Errorf("tmux not found — install it first")
	}

	ws, err := Load(wsName)
	if err != nil {
		return "", err
	}
	if len(ws.Projects) == 0 {
		return "", fmt.Errorf("workspace '%s' has no projects", wsName)
	}

	session := claudeSessionName(wsName)
	multiProject := len(ws.Projects) > 1
	teams := multiProject && !noTeams

	// Build the claude command with env vars inlined
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

	// Use $(cat ...) so the shell reads the file rather than inlining multi-line
	// prompt content as tmux keystrokes (which would break on newlines and hit
	// terminal input buffer limits).
	switch {
	case teams:
		if _, err := GeneratePrompt(ws); err != nil {
			return "", err
		}
		parts = append(parts, "--teammate-mode", "in-process", "--", "\"$(cat "+shellQuote(PromptFilePath(wsName))+")\"")
	case multiProject && noTeams:
		if _, err := GenerateNoTeamsPrompt(ws); err != nil {
			return "", err
		}
		parts = append(parts, "--", "\"$(cat "+shellQuote(NoTeamsPromptFilePath(wsName))+")\"")
	}

	crewExec.EnsureTmuxConfig()

	if err := crewExec.CreateTmuxSession(session, workDir); err != nil {
		return "", fmt.Errorf("failed to create tmux session: %w", err)
	}
	crewExec.SourceTmuxConfig(session)
	// No destroy-unattached — sessions persist after detach so users can reattach.

	cmd := strings.Join(parts, " ")
	debug.Log("claude", "tmux session %s → %s", session, cmd)

	if err := crewExec.TmuxSendKeys(session, cmd); err != nil {
		crewExec.KillTmuxSession(session)
		return "", fmt.Errorf("failed to send claude command: %w", err)
	}

	return session, nil
}

// ClaudeAttachCmd returns an *exec.Cmd that attaches to the Claude tmux session.
// Use with tea.ExecProcess from Bubbletea TUI.
func ClaudeAttachCmd(session string) *exec.Cmd {
	cmd := exec.Command("tmux", "attach", "-t", session)
	cmd.Env = crewExec.EnvWithoutTMUX()
	return cmd
}

// shellQuote wraps a string in single quotes, escaping embedded single quotes.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'"
}
