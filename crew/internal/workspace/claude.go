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
// It assumes ws has at least one project, and that the prompt file already
// exists when needsPrompt(ws); ClaudeCommand guarantees both.
//
// A multi-project workspace runs one flat Claude instance at the workspace root
// with every project exposed via --add-dir; a single-project workspace starts
// directly in that project and needs no orientation prompt.
//
// The prompt is passed via $(cat ...) so the shell reads the file rather than
// inlining multi-line content (which would break tmux keystroke sends on
// newlines and hit terminal input buffer limits).
func buildClaudeParts(ws *Workspace) ([]string, string) {
	multiProject := len(ws.Projects) > 1

	parts := []string{"IS_SANDBOX=1"}
	if config.UserSetClaudeConfig {
		parts = append(parts, "CLAUDE_CONFIG_DIR="+crewExec.ShellQuote(config.ClaudeConfigDir))
	}

	workDir := ResolvePath(ws.Name, ws.Projects[0])
	if multiProject {
		workDir = WorkspaceDir(ws.Name)
	}

	parts = append(parts, "claude", "--dangerously-skip-permissions")

	if multiProject {
		for _, wp := range ws.Projects {
			parts = append(parts, "--add-dir", crewExec.ShellQuote(ResolvePath(ws.Name, wp)))
		}
	}

	if needsPrompt(ws) {
		parts = append(parts, "--", "\"$(cat "+crewExec.ShellQuote(PromptFilePath(ws.Name))+")\"")
	}

	return parts, workDir
}

// ClaudeCommand returns an *exec.Cmd that runs Claude directly in the current
// terminal. Use with tea.ExecProcess from a Bubbletea TUI: the TUI suspends,
// Claude takes over the terminal, and control returns when Claude exits.
// Nothing is tracked — there's no session to reattach to.
func ClaudeCommand(wsName string) (*exec.Cmd, error) {
	if !crewExec.HasClaude() {
		return nil, fmt.Errorf("claude not found — install Claude Code first")
	}

	ws, err := Load(wsName)
	if err != nil {
		return nil, err
	}
	if len(ws.Projects) == 0 {
		return nil, fmt.Errorf("workspace '%s' has no projects", wsName)
	}
	if needsPrompt(ws) {
		if _, err := GeneratePrompt(ws); err != nil {
			return nil, err
		}
	}

	parts, workDir := buildClaudeParts(ws)

	cmdStr := strings.Join(parts, " ")
	debug.Log("claude", "direct run in %s → %s", workDir, cmdStr)

	cmd := exec.Command("sh", "-c", cmdStr)
	cmd.Dir = workDir
	return cmd, nil
}
