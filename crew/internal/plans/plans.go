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

func Start(domain string, proxyPort int) error {
	if !crewExec.HasTmux() {
		return fmt.Errorf("tmux not found — install with: brew install tmux")
	}
	if IsRunning() {
		return fmt.Errorf("plan viewer already running")
	}

	internalPort, err := dev.FindFreePort()
	if err != nil {
		return fmt.Errorf("failed to find free port: %w", err)
	}

	if err := dev.SavePlansPort(internalPort); err != nil {
		return fmt.Errorf("failed to save plans port: %w", err)
	}

	if err := dev.EnsureProxy(domain, proxyPort); err != nil {
		return fmt.Errorf("failed to start proxy: %w", err)
	}

	home, _ := os.UserHomeDir()
	if err := crewExec.CreateTmuxSession(sessionName, home); err != nil {
		dev.RemovePlansPort()
		return fmt.Errorf("failed to create tmux session: %w", err)
	}

	crewBin, err := os.Executable()
	if err != nil {
		crewBin = "crew"
	}
	cmd := fmt.Sprintf("%s plans _serve --port %d", crewBin, internalPort)
	return crewExec.TmuxSendKeys(sessionName, cmd)
}

func Stop() {
	crewExec.KillTmuxSession(sessionName)
	dev.RemovePlansPort()
}

func IsRunning() bool {
	return crewExec.TmuxSessionExists(sessionName)
}

func URL() string {
	settings := config.LoadSettings()
	host := dev.ResolveHostIP()
	domain := settings.GetDomain(host)
	proxyPort := settings.GetProxyPort()
	h := "plans." + domain
	if proxyPort != 80 {
		return fmt.Sprintf("http://%s:%d", h, proxyPort)
	}
	return "http://" + h
}
