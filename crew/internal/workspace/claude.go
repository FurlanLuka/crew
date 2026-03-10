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
func CreateClaudeSession(wsName string, skipPermissions bool) (string, error) {
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

	if _, err := GeneratePrompt(ws); err != nil {
		return "", err
	}
	promptFile := PromptFilePath(wsName)

	session := claudeSessionName(wsName)

	// Build the claude command with env vars inlined
	var parts []string

	if config.UserSetClaudeConfig {
		parts = append(parts, "CLAUDE_CONFIG_DIR="+shellQuote(config.ClaudeConfigDir))
	}

	multiProject := len(ws.Projects) > 1
	workDir := ProjectPath(wsName, ws.Projects[0].Name)

	if multiProject {
		workDir = WorkspaceDir(wsName)
		parts = append(parts, "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1")
	}

	parts = append(parts, "claude")

	if skipPermissions {
		parts = append(parts, "--dangerously-skip-permissions")
	}

	if multiProject {
		for _, wp := range ws.Projects {
			parts = append(parts, "--add-dir", shellQuote(ProjectPath(wsName, wp.Name)))
		}

		// Use $(cat ...) so the shell reads the file rather than inlining
		// multi-line prompt content as tmux keystrokes (which would break on newlines
		// and hit terminal input buffer limits).
		parts = append(parts, "--teammate-mode", "in-process", "--", "\"$(cat "+shellQuote(promptFile)+")\"")
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
