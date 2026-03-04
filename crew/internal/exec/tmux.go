package exec

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
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

// CreateTmuxSession creates a new detached tmux session.
// Unsets $TMUX so this works even when called from inside an existing session.
func CreateTmuxSession(session, dir string) error {
	cmd := exec.Command("tmux", "new-session", "-d", "-s", session, "-c", dir)
	cmd.Env = envWithoutTMUX()
	return cmd.Run()
}

// envWithoutTMUX returns os.Environ() with $TMUX removed.
func envWithoutTMUX() []string {
	var env []string
	for _, e := range os.Environ() {
		if !strings.HasPrefix(e, "TMUX=") {
			env = append(env, e)
		}
	}
	return env
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

	return syscall.Exec(tmuxPath, args, envWithoutTMUX())
}

// CrewSession holds a crew tmux session with its creation time.
type CrewSession struct {
	Name      string
	CreatedAt time.Time
}

// ListCrewSessionsDetailed returns all crew tmux sessions with creation timestamps.
func ListCrewSessionsDetailed() []CrewSession {
	cmd := exec.Command("tmux", "list-sessions", "-F", "#{session_name}\t#{session_created}")
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	return parseCrewSessionsOutput(string(out))
}

// parseCrewSessionsOutput parses tmux list-sessions output (tab-separated name + unix timestamp)
// and returns only sessions with the "crew-" prefix.
func parseCrewSessionsOutput(output string) []CrewSession {
	var sessions []CrewSession
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) != 2 || !strings.HasPrefix(parts[0], "crew-") {
			continue
		}
		ts, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil {
			continue
		}
		sessions = append(sessions, CrewSession{
			Name:      parts[0],
			CreatedAt: time.Unix(ts, 0),
		})
	}
	return sessions
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
