package exec

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"

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

const defaultLazygitConfig = `# crew-config v2
gui:
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
`

// EnsureLazygitConfig writes the default lazygit config.
// If the file doesn't exist, it creates it.
// If the file exists and is crew-managed (first line starts with "# crew"), it overwrites.
// If the file exists and was user-customized, it leaves it alone.
func EnsureLazygitConfig() {
	dir := LazygitConfigDir()
	cfgFile := filepath.Join(dir, "config.yml")
	data, err := os.ReadFile(cfgFile)
	if err != nil {
		// File doesn't exist — write it
		os.MkdirAll(dir, 0o755)
		os.WriteFile(cfgFile, []byte(defaultLazygitConfig), 0o644)
		return
	}
	firstLine, _, _ := strings.Cut(string(data), "\n")
	if strings.HasPrefix(firstLine, "# crew") {
		os.WriteFile(cfgFile, []byte(defaultLazygitConfig), 0o644)
	}
}

// LazygitCommand returns the shell command to launch lazygit with crew's config.
func LazygitCommand() string {
	return "lazygit --use-config-dir=" + LazygitConfigDir()
}
