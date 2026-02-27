package profile

import (
	"os"
	"path/filepath"

	"github.com/FurlanLuka/homebrew-tap/crew/internal/config"
	"github.com/FurlanLuka/homebrew-tap/crew/internal/registry"
)

func Path() string {
	return filepath.Join(config.ClaudeConfigDir, "CLAUDE.md")
}

func IsInstalled() bool {
	_, err := os.Stat(Path())
	return err == nil
}

func Content() (string, error) {
	data, err := os.ReadFile(Path())
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func Install() error {
	content, err := registry.FetchRaw(config.RegistryBase + "/profile/CLAUDE.md")
	if err != nil {
		return err
	}
	os.MkdirAll(config.ClaudeConfigDir, 0o755)
	return os.WriteFile(Path(), []byte(content), 0o644)
}

func Remove() error {
	return os.Remove(Path())
}

func Update() (bool, error) {
	localData, err := os.ReadFile(Path())
	if err != nil {
		return false, err
	}

	remote, err := registry.FetchRaw(config.RegistryBase + "/profile/CLAUDE.md")
	if err != nil {
		return false, err
	}

	if registry.ContentHash(string(localData)) == registry.ContentHash(remote) {
		return false, nil
	}

	err = os.WriteFile(Path(), []byte(remote), 0o644)
	return err == nil, err
}
