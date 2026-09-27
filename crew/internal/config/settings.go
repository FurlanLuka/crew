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
	// ProxyHTTPSPort is where the proxy also serves TLS: 0 means 443, -1 off.
	ProxyHTTPSPort int    `json:"proxy_https_port,omitempty"`
	Domain         string `json:"domain,omitempty"`
}

// GetDomain returns the configured custom domain, or falls back to
// host-based nip.io domain for local/LAN development.
func (s Settings) GetDomain(host string) string {
	if s.Domain != "" {
		return s.Domain
	}
	return host + ".nip.io"
}

func (s Settings) GetProxyPort() int {
	if s.ProxyPort > 0 {
		return s.ProxyPort
	}
	return 80
}

// GetProxyHTTPSPort is the proxy's TLS port, or 0 when HTTPS is turned off.
func (s Settings) GetProxyHTTPSPort() int {
	switch {
	case s.ProxyHTTPSPort < 0:
		return 0
	case s.ProxyHTTPSPort > 0:
		return s.ProxyHTTPSPort
	}
	return 443
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
