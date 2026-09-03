package dev

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

// Slug identifies one running unit of dev servers. It is the flat form of a
// workspace/worktree pair ("phone-speak--wrk2") and is what every route file,
// log directory, tmux session and proxy subdomain is keyed by.
//
// It is a distinct type because a bare workspace name reaching one of those
// helpers resolves to the wrong file rather than failing — the compiler catches
// that here instead of leaving it to be noticed at runtime.
type Slug string

// DisplayRef renders a slug the way the user writes it: "phone-speak/wrk2".
//
// "/" is the user-facing separator; "--" appears only inside identifiers whose
// rendering crew does not control — tmux session names, hostnames, filenames.
// Anything printed for a human goes through here.
func DisplayRef(slug Slug) string {
	return strings.Replace(string(slug), "--", "/", 1)
}

type Route struct {
	// Project owns this server. Server names are only unique within a project
	// (validServerName is enforced per-project), so without this two projects
	// in one worktree that both expose a server called "api" are
	// indistinguishable — and binding resolution would pick whichever it hit
	// first. Empty when loaded from a route file written before this field.
	Project      string `json:"project,omitempty"`
	ServerName   string `json:"server_name"`
	ExternalPort int    `json:"external_port"`
	// InternalPort is the port the server is actually bound to.
	// When NoProxy is true this is the user-facing port on localhost.
	InternalPort int  `json:"internal_port"`
	NoProxy      bool `json:"no_proxy,omitempty"`
}

// Proxied reports whether the route should be served through the reverse proxy.
func (r Route) Proxied() bool { return !r.NoProxy }

func RoutesFilePath(slug Slug) string {
	return filepath.Join(config.ConfigDir, "dev-routes-"+string(slug)+".json")
}

func LoadRoutes(slug Slug) ([]Route, error) {
	data, err := os.ReadFile(RoutesFilePath(slug))
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

func saveRoutes(slug Slug, routes []Route) error {
	if len(routes) == 0 {
		os.Remove(RoutesFilePath(slug))
		return nil
	}
	data, err := json.MarshalIndent(routes, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(RoutesFilePath(slug), data, 0o644)
}

func removeRoutesFile(slug Slug) {
	os.Remove(RoutesFilePath(slug))
}

// Running reports whether a worktree currently has dev servers up, which is
// exactly whether it has a non-empty route file.
func Running(slug Slug) bool {
	routes, err := LoadRoutes(slug)
	return err == nil && len(routes) > 0
}

// WsRoutes pairs a slug with the routes running under it.
type WsRoutes struct {
	Slug   Slug
	Routes []Route
}

// FormatURL builds a dev server URL, omitting the port for port 80.
func FormatURL(serverName string, slug Slug, domain string, port int) string {
	if port == 80 {
		return fmt.Sprintf("http://%s--%s.%s", serverName, slug, domain)
	}
	return fmt.Sprintf("http://%s--%s.%s:%d", serverName, slug, domain, port)
}

// RouteURL returns the user-facing URL for a route, choosing localhost for
// no-proxy routes and the proxy subdomain otherwise.
func RouteURL(r Route, slug Slug, domain string, proxyPort int) string {
	if r.NoProxy {
		return fmt.Sprintf("http://localhost:%d", r.InternalPort)
	}
	return FormatURL(r.ServerName, slug, domain, proxyPort)
}

// PlansPortFile returns the path to the file storing the plans server's
// internal port when running behind the shared proxy.
func PlansPortFile() string {
	return filepath.Join(config.ConfigDir, "plans-internal-port")
}

// PlansNoProxyPortFile returns the path to the file storing the plans server's
// port when it's running in no-proxy mode (bound to localhost).
func PlansNoProxyPortFile() string {
	return filepath.Join(config.ConfigDir, "plans-no-proxy-port")
}

func readPortFile(path string) int {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	var port int
	if _, err := fmt.Sscanf(strings.TrimSpace(string(data)), "%d", &port); err != nil {
		return 0
	}
	return port
}

// LoadPlansPort reads the plans server's proxy-mode port. Returns 0 when plans
// is not running OR is running in no-proxy mode (the proxy has no business
// routing it in that case).
func LoadPlansPort() int {
	return readPortFile(PlansPortFile())
}

// LoadPlansNoProxyPort reads the plans server's localhost port for no-proxy
// runs. Returns 0 when plans is not running in no-proxy mode.
func LoadPlansNoProxyPort() int {
	return readPortFile(PlansNoProxyPortFile())
}

// SavePlansPort writes the plans server's internal port for proxy-mode runs.
func SavePlansPort(port int) error {
	return os.WriteFile(PlansPortFile(), []byte(fmt.Sprintf("%d", port)), 0o644)
}

// SavePlansNoProxyPort writes the plans server's port for no-proxy runs.
func SavePlansNoProxyPort(port int) error {
	return os.WriteFile(PlansNoProxyPortFile(), []byte(fmt.Sprintf("%d", port)), 0o644)
}

// RemovePlansPort removes both plans port sidecar files.
func RemovePlansPort() {
	os.Remove(PlansPortFile())
	os.Remove(PlansNoProxyPortFile())
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
		name := strings.TrimPrefix(base, "dev-routes-")
		name = strings.TrimSuffix(name, ".json")
		slug := Slug(name)

		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var routes []Route
		if err := json.Unmarshal(data, &routes); err != nil {
			continue
		}
		if len(routes) > 0 {
			result = append(result, WsRoutes{Slug: slug, Routes: routes})
		}
	}
	return result, nil
}
