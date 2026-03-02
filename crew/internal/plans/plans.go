package plans

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

const sessionName = "crew-plans"

type Config struct {
	Enabled bool `json:"enabled"`
	Port    int  `json:"port"`
}

func configPath() string {
	return filepath.Join(config.ConfigDir, "plans.json")
}

func LoadConfig() Config {
	data, err := os.ReadFile(configPath())
	if err != nil {
		return Config{Port: 80}
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{Port: 80}
	}
	if cfg.Port == 0 {
		cfg.Port = 80
	}
	return cfg
}

func SaveConfig(cfg Config) error {
	os.MkdirAll(config.ConfigDir, 0o755)
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath(), append(data, '\n'), 0o644)
}

func IsInstalled() bool {
	_, err := exec.LookPath("claude-plan-viewer")
	return err == nil
}

func Install() error {
	if _, err := exec.LookPath("npm"); err != nil {
		return fmt.Errorf("npm not found — install Node.js first")
	}
	cmd := exec.Command("npm", "install", "-g", "claude-plan-viewer")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func Start(port int) error {
	if !crewExec.HasTmux() {
		return fmt.Errorf("tmux not found — install with: brew install tmux")
	}
	if !IsInstalled() {
		return fmt.Errorf("claude-plan-viewer not installed — enable first")
	}
	if IsRunning() {
		return fmt.Errorf("plan viewer already running")
	}

	home, _ := os.UserHomeDir()
	if err := crewExec.CreateTmuxSession(sessionName, home); err != nil {
		return fmt.Errorf("failed to create tmux session: %w", err)
	}

	cmd := fmt.Sprintf("sudo claude-plan-viewer --port %d --host 0.0.0.0 --claude-dir %s", port, config.ClaudeConfigDir)
	return crewExec.TmuxSendKeys(sessionName, cmd)
}

func Stop() {
	crewExec.KillTmuxSession(sessionName)
}

func IsRunning() bool {
	return crewExec.TmuxSessionExists(sessionName)
}

func URL() string {
	return "http://plans." + dev.DetectLANIP() + ".nip.io"
}
 