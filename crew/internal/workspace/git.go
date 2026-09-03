package workspace

import (
	"fmt"
	"os/exec"

	"github.com/FurlanLuka/crew/crew/internal/dev"
	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

func gitSessionName(slug dev.Slug) string {
	return "crew-git-" + string(slug)
}

// EnsureGitSession creates a tmux session with lazygit windows for each project
// in the workspace (if it doesn't already exist). Returns the session name.
func EnsureGitSession(res *Resolved) (string, error) {
	if !crewExec.HasLazygit() {
		return "", fmt.Errorf("lazygit not found — install it first")
	}
	if !crewExec.HasTmux() {
		return "", fmt.Errorf("tmux not found — install it first")
	}

	session := gitSessionName(res.Slug)

	if !crewExec.TmuxSessionExists(session) {
		if len(res.Projects) == 0 {
			return "", fmt.Errorf("no projects in workspace")
		}

		crewExec.EnsureLazygitConfig()
		crewExec.EnsureTmuxConfig()
		lgCmd := crewExec.LazygitCommand()

		firstDir := res.Projects[0].Path
		if err := crewExec.CreateTmuxSession(session, firstDir); err != nil {
			return "", fmt.Errorf("failed to create tmux session: %w", err)
		}
		crewExec.SourceTmuxConfig(session)
		crewExec.SetTmuxOption(session, "destroy-unattached", "on")
		crewExec.TmuxSendKeys(session, lgCmd)
		crewExec.RenameTmuxWindow(session, res.Projects[0].Name)

		for _, p := range res.Projects[1:] {
			crewExec.CreateTmuxWindow(session, p.Name, p.Path, lgCmd)
		}
	}

	return session, nil
}

// LaunchGitSession creates a tmux session with lazygit windows for each project
// in the workspace, then attaches to it via syscall.Exec (replaces current process).
func LaunchGitSession(res *Resolved) error {
	session, err := EnsureGitSession(res)
	if err != nil {
		return err
	}
	if err := crewExec.AttachTmuxSessionRaw(session); err != nil {
		return fmt.Errorf("failed to attach to git session: %w", err)
	}
	return nil
}

// GitAttachCmd returns an *exec.Cmd that attaches to the git tmux session.
// Use with tea.ExecProcess from Bubbletea TUI.
func GitAttachCmd(session string) *exec.Cmd {
	cmd := exec.Command("tmux", "attach", "-t", session)
	cmd.Env = crewExec.EnvWithoutTMUX()
	return cmd
}
