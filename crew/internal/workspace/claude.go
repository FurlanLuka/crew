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
// It assumes res has at least one project, and that the prompt file already
// exists when NeedsPrompt(res); ClaudeCommand guarantees both.
//
// A multi-project worktree runs one flat Claude instance at the worktree root
// with every project exposed via --add-dir; a single-project worktree starts
// directly in that project and needs no orientation prompt.
//
// The prompt is passed via $(cat ...) so the shell reads the file rather than
// inlining multi-line content (which would break tmux keystroke sends on
// newlines and hit terminal input buffer limits).
// buildClaudeParts assembles the claude invocation. withPrompt is decided by
// the caller: the orientation prompt is for multi-project and direct-mode
// worktrees, the fix prompt is always passed.
func buildClaudeParts(res *Resolved, withPrompt bool) ([]string, string) {
	multiProject := res.MultiProject()

	parts := []string{"IS_SANDBOX=1"}
	if config.UserSetClaudeConfig {
		parts = append(parts, "CLAUDE_CONFIG_DIR="+crewExec.ShellQuote(config.ClaudeConfigDir))
	}

	workDir := res.Projects[0].Path
	if multiProject {
		workDir = res.Dir
	}

	parts = append(parts, "claude", "--dangerously-skip-permissions")

	if multiProject {
		for _, p := range res.Projects {
			parts = append(parts, "--add-dir", crewExec.ShellQuote(p.Path))
		}
	}

	if withPrompt {
		parts = append(parts, "--", "\"$(cat "+crewExec.ShellQuote(PromptFilePath(res.Ref))+")\"")
	}

	return parts, workDir
}

// ClaudeCommand returns an *exec.Cmd that runs Claude directly in the current
// terminal. Use with tea.ExecProcess from a Bubbletea TUI: the TUI suspends,
// Claude takes over the terminal, and control returns when Claude exits.
// Nothing is tracked — there's no session to reattach to.
func ClaudeCommand(res *Resolved) (*exec.Cmd, error) {
	if NeedsPrompt(res) {
		return claudeCommand(res, func() (string, error) { return GeneratePrompt(res) })
	}
	return claudeCommand(res, nil)
}

// claudeCommand runs claude in the worktree; writePrompt, when given, puts
// the prompt file in place first and the command passes it.
func claudeCommand(res *Resolved, writePrompt func() (string, error)) (*exec.Cmd, error) {
	if !crewExec.HasClaude() {
		return nil, fmt.Errorf("claude not found — install Claude Code first")
	}
	if len(res.Projects) == 0 {
		return nil, fmt.Errorf("workspace '%s' has no projects", res.Ref)
	}
	if writePrompt != nil {
		if _, err := writePrompt(); err != nil {
			return nil, err
		}
	}

	parts, workDir := buildClaudeParts(res, writePrompt != nil)

	cmdStr := strings.Join(parts, " ")
	debug.Log("claude", "direct run in %s → %s", workDir, cmdStr)

	cmd := exec.Command("sh", "-c", cmdStr)
	cmd.Dir = workDir
	return cmd, nil
}
