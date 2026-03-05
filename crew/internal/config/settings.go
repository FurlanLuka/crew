package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type Settings struct {
	ServerIP  string `json:"server_ip,omitempty"`
	SSHHost   string `json:"ssh_host,omitempty"`
	ProxyPort int    `json:"proxy_port,omitempty"`
}

const DefaultProxyPort = 8080

func (s Settings) GetProxyPort() int {
	if s.ProxyPort > 0 {
		return s.ProxyPort
	}
	return DefaultProxyPort
}

func SettingsFilePath() string {
	return filepath.Join(ConfigDir, "config.json")
}

func LoadSettings() Settings {
	data, err := os.ReadFile(SettingsFilePath())
	if err != nil {
		return Settings{}
	}
	var s Settings
	if err := json.Unmarshal(data, &s); err != nil {
		return Settings{}
	}
	return s
}

func SaveSettings(s Settings) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(SettingsFilePath(), data, 0o644)
}
