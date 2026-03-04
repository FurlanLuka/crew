package exec

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/debug"
)

// HasTmux checks if tmux is available.
func HasTmux() bool {
	_, err := exec.LookPath("tmux")
	return err == nil
}

// TmuxSessionExists checks if a tmux session exists.
func TmuxSessionExists(session string) bool {
	cmd := exec.Command("tmux", "has-session", "-t", session)
	exists := cmd.Run() == nil
	debug.Log("tmux", "has-session -t %s → %v", session, exists)
	return exists
}

// CreateTmuxSession creates a new detached tmux session.
// Unsets $TMUX so this works even when called from inside an existing session.
func CreateTmuxSession(session, dir string) error {
	debug.Log("tmux", "new-session -d -s %s -c %s", session, dir)
	cmd := exec.Command("tmux", "new-session", "-d", "-s", session, "-c", dir)
	cmd.Env = envWithoutTMUX()
	if err := cmd.Run(); err != nil {
		debug.Log("tmux", "new-session -s %s → error: %v", session, err)
		return err
	}
	return nil
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
	debug.Log("tmux", "send-keys -t %s %s", session, keys)
	cmd := exec.Command("tmux", "send-keys", "-t", session, keys, "Enter")
	if err := cmd.Run(); err != nil {
		debug.Log("tmux", "send-keys -t %s → error: %v", session, err)
		return err
	}
	return nil
}

// KillTmuxSession kills a tmux session.
func KillTmuxSession(session string) {
	debug.Log("tmux", "kill-session -t %s", session)
	exec.Command("tmux", "kill-session", "-t", session).Run()
}

// AttachTmuxSession attaches to a tmux session via syscall.Exec (replaces process).
func AttachTmuxSession(session string) error {
	debug.Log("tmux", "attach -t %s", session)
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
	debug.Log("tmux", "list-sessions (detailed)")
	cmd := exec.Command("tmux", "list-sessions", "-F", "#{session_name}\t#{session_created}")
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	sessions := parseCrewSessionsOutput(string(out))
	debug.Log("tmux", "list-sessions → %d crew sessions", len(sessions))
	return sessions
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

// CaptureTmuxPane captures the output of a tmux pane.
// Returns empty string (no error) if the session/window doesn't exist.
func CaptureTmuxPane(session, window string, lines int) (string, error) {
	target := session + ":" + window
	debug.Log("tmux", "capture-pane -t %s -S -%d", target, lines)
	cmd := exec.Command("tmux", "capture-pane", "-t", target, "-p", "-S", fmt.Sprintf("-%d", lines))
	out, err := cmd.Output()
	if err != nil {
		return "", nil
	}
	return string(out), nil
}

// ListCrewSessions returns all tmux sessions starting with "crew-".
func ListCrewSessions() []string {
	debug.Log("tmux", "list-sessions")
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
	debug.Log("tmux", "list-sessions → %d crew sessions", len(sessions))
	return sessions
}
