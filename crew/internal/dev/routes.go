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
	// InternalPort is the port the server is actually bound to.
	// When NoProxy is true this is the user-facing port on localhost.
	InternalPort int  `json:"internal_port"`
	NoProxy      bool `json:"no_proxy,omitempty"`
}

// Proxied reports whether the route should be served through the reverse proxy.
func (r Route) Proxied() bool { return !r.NoProxy }

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

// RouteURL returns the user-facing URL for a route, choosing localhost for
// no-proxy routes and the proxy subdomain otherwise.
func RouteURL(r Route, wsName, domain string, proxyPort int) string {
	if r.NoProxy {
		return fmt.Sprintf("http://localhost:%d", r.InternalPort)
	}
	return FormatURL(r.ServerName, wsName, domain, proxyPort)
}

// PlansPortFile returns the path to the file storing the plans server's internal port.
func PlansPortFile() string {
	return filepath.Join(config.ConfigDir, "plans-internal-port")
}

// LoadPlansPort reads the plans server's internal port. Returns 0 if not running.
func LoadPlansPort() int {
	data, err := os.ReadFile(PlansPortFile())
	if err != nil {
		return 0
	}
	var port int
	if _, err := fmt.Sscanf(strings.TrimSpace(string(data)), "%d", &port); err != nil {
		return 0
	}
	return port
}

// SavePlansPort writes the plans server's internal port to disk.
func SavePlansPort(port int) error {
	return os.WriteFile(PlansPortFile(), []byte(fmt.Sprintf("%d", port)), 0o644)
}

// RemovePlansPort removes the plans port file.
func RemovePlansPort() {
	os.Remove(PlansPortFile())
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
