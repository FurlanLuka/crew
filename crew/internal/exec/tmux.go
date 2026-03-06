package exec

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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

// KillTmuxSession kills a tmux session.
func KillTmuxSession(session string) {
	debug.Log("tmux", "kill-session -t %s", session)
	exec.Command("tmux", "kill-session", "-t", session).Run()
}

// AttachTmuxSessionRaw attaches to a tmux session without iTerm2 integration.
// Windows stay inside the terminal; switch with ctrl-b n/p.
func AttachTmuxSessionRaw(session string) error {
	return attachTmux(session, false)
}

func attachTmux(session string, iterm bool) error {
	debug.Log("tmux", "attach -t %s (iterm=%v)", session, iterm)
	tmuxPath, err := exec.LookPath("tmux")
	if err != nil {
		return err
	}

	args := []string{"tmux"}
	if iterm && os.Getenv("TERM_PROGRAM") == "iTerm.app" {
		args = append(args, "-CC")
	}
	args = append(args, "attach", "-t", session)

	return syscall.Exec(tmuxPath, args, envWithoutTMUX())
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
	cmd.Env = envWithoutTMUX()
	cmd.Run()
	sendCmd := exec.Command("tmux", "send-keys", "-t", session+":"+name, command, "Enter")
	sendCmd.Run()
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
