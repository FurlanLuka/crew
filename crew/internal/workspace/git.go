package workspace

import (
	"fmt"

	"github.com/FurlanLuka/crew/crew/internal/exec"
)

// GitSessionName returns the tmux session name for a workspace's git session.
func GitSessionName(wsName string) string {
	return "crew-git-" + wsName
}

// LaunchGitSession creates a tmux session with lazygit windows for each project
// in the workspace, then attaches to it. If the session already exists, it just attaches.
func LaunchGitSession(wsName string) error {
	if !exec.HasLazygit() {
		return fmt.Errorf("lazygit not found — install it first")
	}
	if !exec.HasTmux() {
		return fmt.Errorf("tmux not found — install it first")
	}

	session := GitSessionName(wsName)

	if !exec.TmuxSessionExists(session) {
		ws, err := Load(wsName)
		if err != nil {
			return err
		}
		if len(ws.Projects) == 0 {
			return fmt.Errorf("no projects in workspace")
		}

		exec.EnsureLazygitConfig()
		exec.EnsureTmuxConfig()
		lgCmd := exec.LazygitCommand()

		firstDir := ProjectPath(wsName, ws.Projects[0].Name)
		if err := exec.CreateTmuxSession(session, firstDir); err != nil {
			return fmt.Errorf("failed to create tmux session: %w", err)
		}
		exec.SourceTmuxConfig(session)
		exec.SetTmuxOption(session, "destroy-unattached", "on")
		exec.TmuxSendKeys(session, lgCmd)
		exec.RenameTmuxWindow(session, ws.Projects[0].Name)

		for _, wp := range ws.Projects[1:] {
			dir := ProjectPath(wsName, wp.Name)
			exec.CreateTmuxWindow(session, wp.Name, dir, lgCmd)
		}
	}

	exec.AttachTmuxSessionRaw(session)
	return fmt.Errorf("failed to attach to git session")
}
