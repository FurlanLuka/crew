package voice

import (
	"os"
	osexec "os/exec"
	"path/filepath"
	"runtime"

	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

// Requirement is something Voice OS cannot run without, and how to get it.
type Requirement struct {
	Name    string `json:"name"`
	Why     string `json:"why"`
	Install string `json:"install"`
}

// UnmetRequirements is checked on every crew voice start, before anything is
// downloaded or asked: a missing piece is named with its fix up front instead
// of surfacing later as a page that cannot start a session.
func UnmetRequirements() []Requirement {
	var unmet []Requirement
	if !crewExec.HasTmux() {
		unmet = append(unmet, Requirement{
			Name:    "tmux",
			Why:     "Voice OS runs in a tmux session crew keeps alive",
			Install: tmuxInstall(),
		})
	}
	if ClaudeBin() == "" {
		unmet = append(unmet, Requirement{
			Name:    "claude",
			Why:     "every session Voice OS runs is Claude Code, on your own login",
			Install: "npm install -g @anthropic-ai/claude-code, then run claude once to sign in (or set VOICEOS_CLAUDE_BIN)",
		})
	}
	return unmet
}

// ClaudeBin is the claude Voice OS will run, resolved here in the caller's
// environment and handed to it: the tmux server's PATH is not the caller's.
// Empty when there is none; an override that does not exist is none too,
// since Voice OS never falls back from it to PATH.
func ClaudeBin() string {
	if bin := os.Getenv("VOICEOS_CLAUDE_BIN"); bin != "" {
		if _, err := os.Stat(bin); err != nil {
			return ""
		}
		abs, err := filepath.Abs(bin)
		if err != nil {
			return bin
		}
		return abs
	}
	path, err := osexec.LookPath("claude")
	if err != nil {
		return ""
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	return abs
}

func tmuxInstall() string {
	if runtime.GOOS == "darwin" {
		return "brew install tmux"
	}
	return "install tmux with your package manager (apt install tmux, dnf install tmux)"
}
