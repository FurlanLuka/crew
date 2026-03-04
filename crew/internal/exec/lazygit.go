package exec

import (
	"os"
	"os/exec"
	"path/filepath"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

// HasLazygit checks if lazygit CLI is available.
func HasLazygit() bool {
	_, err := exec.LookPath("lazygit")
	return err == nil
}

// LazygitConfigDir returns the crew-managed lazygit config directory.
func LazygitConfigDir() string {
	return filepath.Join(config.ConfigDir, "lazygit")
}

const defaultLazygitConfig = `gui:
  theme:
    activeBorderColor:
      - "#ff79c6"
      - bold
    inactiveBorderColor:
      - "#6272a4"
    selectedLineBgColor:
      - "#44475a"
    cherryPickedCommitFgColor:
      - "#bd93f9"
    cherryPickedCommitBgColor:
      - "#44475a"
    unstagedChangesColor:
      - "#ff5555"
    defaultFgColor:
      - "#f8f8f2"
    searchingActiveBorderColor:
      - "#50fa7b"
      - bold
git:
  pagers:
    - pager: delta --dark --paging=never --side-by-side --line-numbers --syntax-theme Dracula
customCommands:
  - key: ')'
    command: 'tmux next-window'
    context: 'global'
    output: 'none'
  - key: '('
    command: 'tmux previous-window'
    context: 'global'
    output: 'none'
`

// EnsureLazygitConfig creates the default lazygit config if it doesn't exist.
func EnsureLazygitConfig() {
	dir := LazygitConfigDir()
	cfgFile := filepath.Join(dir, "config.yml")
	if _, err := os.Stat(cfgFile); err == nil {
		return
	}
	os.MkdirAll(dir, 0o755)
	os.WriteFile(cfgFile, []byte(defaultLazygitConfig), 0o644)
}

// LazygitCommand returns the shell command to launch lazygit with crew's config.
func LazygitCommand() string {
	return "LG_CONFIG_DIR=" + LazygitConfigDir() + " lazygit"
}
