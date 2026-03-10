package workspace

import (
	"fmt"
	"os/exec"

	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

func gitSessionName(wsName string) string {
	return "crew-git-" + wsName
}

// EnsureGitSession creates a tmux session with lazygit windows for each project
// in the workspace (if it doesn't already exist). Returns the session name.
func EnsureGitSession(wsName string) (string, error) {
	if !crewExec.HasLazygit() {
		return "", fmt.Errorf("lazygit not found — install it first")
	}
	if !crewExec.HasTmux() {
		return "", fmt.Errorf("tmux not found — install it first")
	}

	session := gitSessionName(wsName)

	if !crewExec.TmuxSessionExists(session) {
		ws, err := Load(wsName)
		if err != nil {
			return "", err
		}
		if len(ws.Projects) == 0 {
			return "", fmt.Errorf("no projects in workspace")
		}

		crewExec.EnsureLazygitConfig()
		crewExec.EnsureTmuxConfig()
		lgCmd := crewExec.LazygitCommand()

		firstDir := ProjectPath(wsName, ws.Projects[0].Name)
		if err := crewExec.CreateTmuxSession(session, firstDir); err != nil {
			return "", fmt.Errorf("failed to create tmux session: %w", err)
		}
		crewExec.SourceTmuxConfig(session)
		crewExec.SetTmuxOption(session, "destroy-unattached", "on")
		crewExec.TmuxSendKeys(session, lgCmd)
		crewExec.RenameTmuxWindow(session, ws.Projects[0].Name)

		for _, wp := range ws.Projects[1:] {
			dir := ProjectPath(wsName, wp.Name)
			crewExec.CreateTmuxWindow(session, wp.Name, dir, lgCmd)
		}
	}

	return session, nil
}

// LaunchGitSession creates a tmux session with lazygit windows for each project
// in the workspace, then attaches to it via syscall.Exec (replaces current process).
func LaunchGitSession(wsName string) error {
	session, err := EnsureGitSession(wsName)
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
