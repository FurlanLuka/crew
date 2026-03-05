package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type Settings struct {
	ServerIP string `json:"server_ip,omitempty"`
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
