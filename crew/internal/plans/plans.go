package plans

import (
	"encoding/json"
	"fmt"
	"os"
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
		return Config{Port: 3080}
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{Port: 3080}
	}
	if cfg.Port == 0 || cfg.Port == 80 {
		cfg.Port = 3080
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

func Start(port int) error {
	if !crewExec.HasTmux() {
		return fmt.Errorf("tmux not found — install with: brew install tmux")
	}
	if IsRunning() {
		return fmt.Errorf("plan viewer already running")
	}

	home, _ := os.UserHomeDir()
	if err := crewExec.CreateTmuxSession(sessionName, home); err != nil {
		return fmt.Errorf("failed to create tmux session: %w", err)
	}

	cmd := fmt.Sprintf("crew plans _serve --port %d", port)
	return crewExec.TmuxSendKeys(sessionName, cmd)
}

func Stop() {
	crewExec.KillTmuxSession(sessionName)
}

func IsRunning() bool {
	return crewExec.TmuxSessionExists(sessionName)
}

func URL() string {
	cfg := LoadConfig()
	host := "plans." + dev.ResolveHostIP() + ".nip.io"
	if cfg.Port != 80 {
		return fmt.Sprintf("http://%s:%d", host, cfg.Port)
	}
	return "http://" + host
}
