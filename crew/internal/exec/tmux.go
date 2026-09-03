package exec

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/FurlanLuka/crew/crew/internal/config"
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
	args := []string{"new-session", "-d", "-s", session}
	if dir != "" {
		args = append(args, "-c", dir)
	}
	debug.Log("tmux", "new-session -d -s %s -c %s", session, dir)
	cmd := exec.Command("tmux", args...)
	cmd.Env = EnvWithoutTMUX()
	// When no server is running this client daemonizes into one, inheriting
	// crew's working directory. Anchoring it outside the workspace tree keeps
	// the server from resembling an abandoned workspace process to any sweep.
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}
	if err := cmd.Run(); err != nil {
		debug.Log("tmux", "new-session -s %s → error: %v", session, err)
		return err
	}
	return nil
}

// EnvWithoutTMUX returns os.Environ() with $TMUX removed.
func EnvWithoutTMUX() []string {
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

// TmuxConfigPath returns the path to crew's tmux config.
func TmuxConfigPath() string {
	return filepath.Join(config.ConfigDir, "tmux.conf")
}

const defaultTmuxConfig = `# crew-config v2
set -g status-style 'bg=#1e1e2e fg=#cdd6f4'
set -g status-left '#{?client_prefix,#[bg=#f38ba8 fg=#1e1e2e bold] PREFIX ,#[bg=#313244 fg=#cdd6f4]  tmux  }'
set -g status-left-length 20
set -g window-status-current-style 'bg=#45475a fg=#cdd6f4 bold'
set -g window-status-style 'bg=#1e1e2e fg=#585b70'
set -g window-status-format ' #I:#W '
set -g window-status-current-format ' #I:#W '
set -g status-right ''
setw -g mouse on
`

// EnsureTmuxConfig writes the default tmux config.
// If the file doesn't exist, it creates it.
// If the file exists and is crew-managed (first line starts with "# crew"), it overwrites.
// If the file exists and was user-customized, it leaves it alone.
func EnsureTmuxConfig() {
	cfgFile := TmuxConfigPath()
	data, err := os.ReadFile(cfgFile)
	if err != nil {
		// File doesn't exist — write it
		os.WriteFile(cfgFile, []byte(defaultTmuxConfig), 0o644)
		return
	}
	firstLine, _, _ := strings.Cut(string(data), "\n")
	if strings.HasPrefix(firstLine, "# crew") {
		os.WriteFile(cfgFile, []byte(defaultTmuxConfig), 0o644)
	}
}

// SourceTmuxConfig loads crew's tmux config into a session.
func SourceTmuxConfig(session string) {
	cfgFile := TmuxConfigPath()
	if _, err := os.Stat(cfgFile); err != nil {
		return
	}
	debug.Log("tmux", "source-file %s", cfgFile)
	exec.Command("tmux", "source-file", cfgFile).Run()
}

// ListTmuxSessions returns the names of all active tmux sessions.
func ListTmuxSessions() []string {
	debug.Log("tmux", "list-sessions")
	out, err := exec.Command("tmux", "list-sessions", "-F", "#{session_name}").Output()
	if err != nil {
		return nil
	}
	var sessions []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line != "" {
			sessions = append(sessions, line)
		}
	}
	return sessions
}

// TmuxRestartLastCommand restarts whatever command was last run in a tmux target.
// It first kills the running command's processes (C-c alone only signals the
// foreground group; bundler workers/file-watchers that setsid() into their own
// group escape it and orphan), then C-c clears the prompt and Up+Enter re-runs
// the command. The pane's own shell is preserved so Up+Enter has something to
// re-run — see killPaneProcesses for what is and isn't killed.
func TmuxRestartLastCommand(target string) {
	debug.Log("tmux", "restart-last-command -t %s", target)
	killPaneProcesses("-t", target)
	exec.Command("tmux", "send-keys", "-t", target, "C-c").Run()
	exec.Command("tmux", "send-keys", "-t", target, "Up", "Enter").Run()
}

// KillTmuxSession kills a tmux session and the processes of every pane.
// tmux kill-session only SIGHUPs each pane's direct process, so dev-server
// children that detached into their own session survive and orphan to PID 1 —
// repeated restarts pile up hundreds and exhaust the per-user process limit.
//
// The sweep must stay before kill-session: a pane's tty is released when the
// pane dies and the slot can be reused by an unrelated terminal, so resolving
// ttys afterwards would risk killing someone else's processes.
func KillTmuxSession(session string) {
	killPaneProcesses("-s", "-t", session)
	debug.Log("tmux", "kill-session -t %s", session)
	exec.Command("tmux", "kill-session", "-t", session).Run()
}

// killPaneProcesses kills the processes running in every pane matched by the
// given `tmux list-panes` selector (e.g. "-s","-t",session for a whole session,
// or "-t",session:window for one window). The pane's own shell is left running.
//
// Victim selection is selectVictims; it needs the pane tty as well as the pane
// pid, because processes orphaned to PID 1 are unreachable through ppid alone.
func killPaneProcesses(selector ...string) {
	args := append([]string{"list-panes", "-F", "#{pane_pid} #{pane_tty}"}, selector...)
	debug.Log("tmux", "%s", strings.Join(args, " "))
	out, err := exec.Command("tmux", args...).Output()
	if err != nil {
		debug.Log("tmux", "list-panes %s → error: %v", strings.Join(selector, " "), err)
		return
	}

	panes := parsePaneRefs(string(out))
	if len(panes) == 0 {
		debug.Log("tmux", "list-panes %s → no panes", strings.Join(selector, " "))
		return
	}

	rows, err := snapshotProcs()
	if err != nil {
		return
	}
	protected := protectedPIDs(rows)

	for _, pane := range panes {
		for _, pid := range selectVictims(rows, pane, protected) {
			debug.Log("tmux", "pane-sweep SIGKILL %d", pid)
			syscall.Kill(pid, syscall.SIGKILL)
		}
	}
}

// paneRef is one pane's pid and controlling tty.
type paneRef struct {
	pid int
	tty string
}

// parsePaneRefs parses `tmux list-panes -F '#{pane_pid} #{pane_tty}'` output.
// A pane whose tty is missing or unusable is still returned with an empty tty
// rather than dropped, so it keeps the ppid-graph sweep.
func parsePaneRefs(out string) []paneRef {
	var panes []paneRef
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil || pid <= 0 {
			continue
		}
		tty := ""
		if len(fields) > 1 {
			tty = normalizeTTY(fields[1])
		}
		panes = append(panes, paneRef{pid: pid, tty: tty})
	}
	return panes
}

// AttachTmuxSessionRaw attaches to a tmux session.
// Windows stay inside the terminal; switch with ctrl-b n/p.
func AttachTmuxSessionRaw(session string) error {
	debug.Log("tmux", "attach -t %s", session)
	tmuxPath, err := exec.LookPath("tmux")
	if err != nil {
		return err
	}

	args := []string{"tmux", "attach", "-t", session}
	return syscall.Exec(tmuxPath, args, EnvWithoutTMUX())
}

// SetTmuxOption sets a tmux session option.
func SetTmuxOption(session, option, value string) {
	debug.Log("tmux", "set-option -t %s %s %s", session, option, value)
	exec.Command("tmux", "set-option", "-t", session, option, value).Run()
}

// RenameTmuxWindow renames the current window in a tmux session.
func RenameTmuxWindow(session, name string) {
	debug.Log("tmux", "rename-window -t %s %s", session, name)
	cmd := exec.Command("tmux", "rename-window", "-t", session, name)
	cmd.Run()
}

// CreateTmuxWindow creates a named window in a tmux session and sends a command.
func CreateTmuxWindow(session, name, dir, command string) {
	debug.Log("tmux", "new-window -t %s -n %s -c %s → %s", session, name, dir, command)
	cmd := exec.Command("tmux", "new-window", "-t", session, "-n", name, "-c", dir)
	cmd.Env = EnvWithoutTMUX()
	cmd.Run()
	sendCmd := exec.Command("tmux", "send-keys", "-t", session+":"+name, command, "Enter")
	sendCmd.Run()
}

// TmuxNewWindow creates a named window in a tmux session without running any command.
// Use this when you need to configure the pane (e.g. pipe-pane) before sending a command.
func TmuxNewWindow(session, name, dir string) {
	debug.Log("tmux", "new-window -t %s -n %s -c %s", session, name, dir)
	cmd := exec.Command("tmux", "new-window", "-t", session, "-n", name, "-c", dir)
	cmd.Env = EnvWithoutTMUX()
	cmd.Run()
}

// TmuxPipePaneToFile enables pipe-pane on the target window, appending pane output to the file.
// Calling pipe-pane a second time replaces any prior pipe on the same pane.
func TmuxPipePaneToFile(session, window, file string) {
	target := session + ":" + window
	cmd := "cat >> " + ShellQuote(file)
	debug.Log("tmux", "pipe-pane -t %s %s", target, cmd)
	exec.Command("tmux", "pipe-pane", "-t", target, cmd).Run()
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
