package dev

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

type Route struct {
	Subdomain    string `json:"subdomain"`
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

func SaveRoutes(wsName string, routes []Route) error {
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

func RemoveRoutesFile(wsName string) {
	os.Remove(RoutesFilePath(wsName))
}

// WsRoutes pairs a workspace name with its routes.
type WsRoutes struct {
	Workspace string
	Routes    []Route
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
