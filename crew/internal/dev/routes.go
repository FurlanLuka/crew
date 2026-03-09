package dev

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

type Route struct {
	Subdomain    string `json:"subdomain"`
	ServerName   string `json:"server_name"`
	ExternalPort int    `json:"external_port"`
	InternalPort int    `json:"internal_port"`
}

func RoutesFilePath(wsName string) string {
	return filepath.Join(config.ConfigDir, "dev-routes-"+wsName+".json")
}

func LoadRoutes(wsName string) ([]Route, error) {
	data, err := os.ReadFile(RoutesFilePath(wsName))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var routes []Route
	if err := json.Unmarshal(data, &routes); err != nil {
		return nil, err
	}
	return routes, nil
}

func saveRoutes(wsName string, routes []Route) error {
	if len(routes) == 0 {
		os.Remove(RoutesFilePath(wsName))
		return nil
	}
	data, err := json.MarshalIndent(routes, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(RoutesFilePath(wsName), data, 0o644)
}

func removeRoutesFile(wsName string) {
	os.Remove(RoutesFilePath(wsName))
}

// WsRoutes pairs a workspace name with its routes.
type WsRoutes struct {
	Workspace string
	Routes    []Route
}

// FormatURL builds a dev server URL, omitting the port for port 80.
func FormatURL(serverName, wsName, domain string, port int) string {
	if port == 80 {
		return fmt.Sprintf("http://%s--%s.%s", serverName, wsName, domain)
	}
	return fmt.Sprintf("http://%s--%s.%s:%d", serverName, wsName, domain, port)
}

// ListAllRoutes scans all dev-routes-*.json files and returns routes grouped by workspace.
func ListAllRoutes() ([]WsRoutes, error) {
	pattern := filepath.Join(config.ConfigDir, "dev-routes-*.json")
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return nil, err
	}

	var result []WsRoutes
	for _, path := range matches {
		base := filepath.Base(path)
		// "dev-routes-<wsName>.json"
		name := strings.TrimPrefix(base, "dev-routes-")
		name = strings.TrimSuffix(name, ".json")

		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var routes []Route
		if err := json.Unmarshal(data, &routes); err != nil {
			continue
		}
		if len(routes) > 0 {
			result = append(result, WsRoutes{Workspace: name, Routes: routes})
		}
	}
	return result, nil
}
