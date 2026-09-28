package exec

import (
	"os/exec"
	"runtime"

	"github.com/FurlanLuka/crew/crew/internal/debug"
)

// HasGit reports whether a usable git is installed. On macOS /usr/bin/git is
// a stub that only offers to install the Command Line Tools, so it counts
// once xcode-select knows where they are.
func HasGit() bool {
	path, err := exec.LookPath("git")
	if err != nil {
		return false
	}
	if runtime.GOOS == "darwin" && path == "/usr/bin/git" {
		debug.Log("requirements", "xcode-select -p")
		return exec.Command("xcode-select", "-p").Run() == nil
	}
	return true
}

// TmuxInstallHint, GitInstallHint and ClaudeInstallHint are the one wording of
// how to get each tool, said by crew doctor and by crew voice alike.
func TmuxInstallHint() string {
	if runtime.GOOS == "darwin" {
		return "brew install tmux"
	}
	return "install tmux with your package manager (apt install tmux, dnf install tmux)"
}

func GitInstallHint() string {
	if runtime.GOOS == "darwin" {
		return "xcode-select --install"
	}
	return "install git with your package manager (apt install git, dnf install git)"
}

func ClaudeInstallHint() string {
	return "curl -fsSL https://claude.ai/install.sh | bash, then run claude once to sign in"
}
