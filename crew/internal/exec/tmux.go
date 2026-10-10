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

// TmuxSessionExists checks if a tmux session exists. The "=" makes tmux match
// the name exactly: a bare -t also accepts a prefix, so a stopped
// crew-dev-ws--main would read as running while crew-dev-ws--main2 runs.
func TmuxSessionExists(session string) bool {
	cmd := exec.Command("tmux", "has-session", "-t", "="+session)
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

// TmuxSendKeys sends keys to a tmux session. The logged line carries the
// variable names of any exports, never their values: a dev server's command
// exports its resolved bindings, and those carry URLs and can carry
// credentials.
func TmuxSendKeys(session, keys string) error {
	debug.Log("tmux", "send-keys -t %s %s", session, RedactExports(keys))
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
	// Exact target: a prefix match would sweep and kill a different session
	// (crew-dev-ws--main2) when the one named here is already gone.
	target := "=" + session
	killPaneProcesses("-s", "-t", target)
	debug.Log("tmux", "kill-session -t %s", target)
	exec.Command("tmux", "kill-session", "-t", target).Run()
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

// TmuxRunInSession runs command as its own window of session, creating the
// session around it when there is none — no shell underneath, so the window
// closes when the command exits and the session goes with its last window.
// That is the runner shape: "session exists" means "something still runs".
func TmuxRunInSession(session, name, dir, command string) error {
	args := []string{"new-session", "-d", "-s", session}
	if TmuxSessionExists(session) {
		args = []string{"new-window", "-d", "-t", session}
	}
	args = append(args, "-n", name, "-c", dir, command)
	debug.Log("tmux", "%s", strings.Join(args, " "))
	cmd := exec.Command("tmux", args...)
	cmd.Env = EnvWithoutTMUX()
	// A new server daemonizes from here; anchored outside the workspace
	// tree like CreateTmuxSession.
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}
	if err := cmd.Run(); err != nil {
		debug.Log("tmux", "%s → error: %v", args[0], err)
		return err
	}
	return nil
}

// KillTmuxWindow kills one window and the processes of its pane, with the
// same sweep KillTmuxSession does and for the same reason: a dev server's
// detached children outlive a plain kill-window.
func KillTmuxWindow(session, window string) {
	target := session + ":" + window
	killPaneProcesses("-t", target)
	debug.Log("tmux", "kill-window -t %s", target)
	exec.Command("tmux", "kill-window", "-t", target).Run()
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

// TmuxSessionIdle reports whether every pane of a session runs nothing but
// its shell — a session with no work left in it.
func TmuxSessionIdle(session string) bool {
	out, err := exec.Command("tmux", "list-panes", "-s", "-t", session, "-F", "#{pane_current_command}").Output()
	if err != nil {
		return false
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if !isShell(strings.TrimSpace(line)) {
			return false
		}
	}
	return true
}

func isShell(command string) bool {
	switch command {
	case "", "zsh", "bash", "sh", "fish":
		return true
	}
	return false
}

// TmuxPaneBusy reports whether a window's pane is still running something
// other than its shell — the process crew started is alive.
func TmuxPaneBusy(session, window string) bool {
	target := session + ":" + window
	out, err := exec.Command("tmux", "display-message", "-p", "-t", target, "#{window_name}\t#{pane_current_command}").Output()
	if err != nil {
		return false
	}
	return paneBusy(window, string(out))
}

// paneBusy reads display-message's answer. A window that no longer exists
// is not an error to tmux: it answers for the session's current window
// instead, so the name it reports must be the one asked for. Pure.
func paneBusy(window, answer string) bool {
	name, command, ok := strings.Cut(strings.TrimSpace(answer), "\t")
	if !ok || name != window {
		return false
	}
	return !isShell(command)
}

// RedactExports replaces the value of every `export NAME=<word>` in a
// shell line with "…", keeping the name. The word is read the way the shell
// reads it — quoted runs ('…', "…" with \-escapes) and bare characters up to
// whitespace or a ; & | — so ShellQuote's '\” joins stay inside it. Pure.
func RedactExports(line string) string {
	var out strings.Builder
	i := 0
	for i < len(line) {
		j := strings.Index(line[i:], "export ")
		if j < 0 || (i+j > 0 && !isShellBoundary(line[i+j-1])) {
			if j < 0 {
				out.WriteString(line[i:])
				break
			}
			out.WriteString(line[i : i+j+len("export ")])
			i += j + len("export ")
			continue
		}
		start := i + j + len("export ")
		out.WriteString(line[i:start])
		name := start
		for name < len(line) && isNameByte(line[name], name == start) {
			name++
		}
		if name == start || name >= len(line) || line[name] != '=' {
			i = start
			continue
		}
		out.WriteString(line[start : name+1])
		end := skipShellWord(line, name+1)
		if end > name+1 {
			out.WriteString("…")
		}
		i = end
	}
	return out.String()
}

func isShellBoundary(c byte) bool {
	return c == ' ' || c == '\t' || c == ';' || c == '&' || c == '|' || c == '(' || c == '\n'
}

func isNameByte(c byte, first bool) bool {
	return c == '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (!first && c >= '0' && c <= '9')
}

// skipShellWord returns where the shell word starting at i ends.
func skipShellWord(s string, i int) int {
	for i < len(s) {
		switch c := s[i]; {
		case c == '\'':
			if k := strings.IndexByte(s[i+1:], '\''); k >= 0 {
				i += k + 2
			} else {
				return len(s)
			}
		case c == '"':
			i++
			for i < len(s) && s[i] != '"' {
				if s[i] == '\\' {
					i++
				}
				i++
			}
			i++
		case c == '\\':
			i += 2
		case isShellBoundary(c) || c == '\r':
			return i
		default:
			i++
		}
	}
	if i > len(s) {
		return len(s)
	}
	return i
}
