package workspace

import (
	"fmt"
	"os/exec"
	"strings"

	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
)

// buildClaudeParts assembles the claude invocation. withPrompt is decided by
// the caller, which has written PromptFilePath(res.Ref) first: the
// orientation prompt for multi-project and direct-mode worktrees, the fix
// prompt always.
func buildClaudeParts(res *Resolved, withPrompt bool) ([]string, string) {
	multiProject := res.MultiProject()

	parts := []string{"IS_SANDBOX=1"}
	if config.UserSetClaudeConfig {
		parts = append(parts, "CLAUDE_CONFIG_DIR="+crewExec.ShellQuote(config.ClaudeConfigDir))
	}

	// A project whose checkout failed has no directory: start in the
	// worktree root then, and only hand claude the checkouts that were made.
	missing := res.missingCheckouts()
	workDir := res.Projects[0].Path
	if multiProject || missing[res.Projects[0].Name] {
		workDir = res.Dir
	}

	parts = append(parts, "claude", "--dangerously-skip-permissions")

	if multiProject {
		for _, p := range res.Projects {
			if !missing[p.Name] {
				parts = append(parts, "--add-dir", crewExec.ShellQuote(p.Path))
			}
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
