package dev

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/FurlanLuka/homebrew-tap/crew/internal/config"
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
