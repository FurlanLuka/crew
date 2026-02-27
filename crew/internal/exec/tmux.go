package exec

import (
	"os"
	"os/exec"
	"strings"
	"syscall"
)

// HasTmux checks if tmux is available.
func HasTmux() bool {
	_, err := exec.LookPath("tmux")
	return err == nil
}

// TmuxSessionExists checks if a tmux session exists.
func TmuxSessionExists(session string) bool {
	cmd := exec.Command("tmux", "has-session", "-t", session)
	return cmd.Run() == nil
}

// CreateTmuxSession creates a new tmux session.
func CreateTmuxSession(session, dir string) error {
	cmd := exec.Command("tmux", "new-session", "-d", "-s", session, "-c", dir)
	return cmd.Run()
}

// TmuxSendKeys sends keys to a tmux session.
func TmuxSendKeys(session, keys string) error {
	cmd := exec.Command("tmux", "send-keys", "-t", session, keys, "Enter")
	return cmd.Run()
}

// KillTmuxSession kills a tmux session.
func KillTmuxSession(session string) {
	exec.Command("tmux", "kill-session", "-t", session).Run()
}

// AttachTmuxSession attaches to a tmux session via syscall.Exec (replaces process).
func AttachTmuxSession(session string) error {
	tmuxPath, err := exec.LookPath("tmux")
	if err != nil {
		return err
	}

	// Use -CC for iTerm2
	args := []string{"tmux"}
	if os.Getenv("TERM_PROGRAM") == "iTerm.app" {
		args = append(args, "-CC")
	}
	args = append(args, "attach", "-t", session)

	return syscall.Exec(tmuxPath, args, os.Environ())
}

// ListCrewSessions returns all tmux sessions starting with "crew-".
func ListCrewSessions() []string {
	cmd := exec.Command("tmux", "list-sessions", "-F", "#{session_name}")
	out, err := cmd.Output()
	if err != nil {
		return nil
	}

	var sessions []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if strings.HasPrefix(line, "crew-") {
			sessions = append(sessions, line)
		}
	}
	return sessions
}
