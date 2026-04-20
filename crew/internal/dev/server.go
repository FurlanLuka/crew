package dev

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

// DevProject is the data Start needs per project.
// Kept separate from workspace types to avoid import cycles.
type DevProject struct {
	Path       string
	DevServers []DevServerConfig
}

type DevServerConfig struct {
	Name    string
	Port    int
	Command string
	Dir     string
}

const ProxySessionName = "crew-dev-proxy"

// SessionName returns the tmux session name for dev servers.
func SessionName(wsName string) string {
	return "crew-dev-" + wsName
}

// LogDir returns the directory holding dev server log files for a workspace.
func LogDir(wsName string) string {
	return filepath.Join(config.ConfigDir, "logs", wsName)
}

// LogFile returns the log file path for a specific dev server.
func LogFile(wsName, serverName string) string {
	return filepath.Join(LogDir(wsName), serverName+".log")
}

// Start starts dev servers for a workspace. When noProxy is false it also
// launches the shared reverse proxy; when true, each server binds to its
// configured Port on localhost and the proxy is skipped.
// projects should already have the correct paths (workspace worktree paths).
func Start(wsName string, projects []DevProject, domain string, proxyPort int, noProxy bool) ([]Route, error) {
	var newRoutes []Route
	for _, p := range projects {
		for _, ds := range p.DevServers {
			port := ds.Port
			if !noProxy {
				freePort, err := FindFreePort()
				if err != nil {
					return nil, fmt.Errorf("failed to find free port: %w", err)
				}
				port = freePort
			}
			newRoutes = append(newRoutes, Route{
				Subdomain:    wsName,
				ServerName:   ds.Name,
				ExternalPort: ds.Port,
				InternalPort: port,
				NoProxy:      noProxy,
			})
		}
	}

	if err := saveRoutes(wsName, newRoutes); err != nil {
		return nil, err
	}

	session := SessionName(wsName)

	// Ensure tmux session exists
	if !crewExec.TmuxSessionExists(session) {
		if err := crewExec.CreateTmuxSession(session, ""); err != nil {
			return nil, fmt.Errorf("failed to create tmux session: %w", err)
		}
	}

	// Start dev server windows
	routeIdx := 0
	for _, p := range projects {
		for _, ds := range p.DevServers {
			route := newRoutes[routeIdx]
			routeIdx++

			windowName := fmt.Sprintf("%s/%s", wsName, ds.Name)
			dir := p.Path
			if ds.Dir != "" {
				dir = filepath.Join(p.Path, ds.Dir)
			}

			logFile := LogFile(wsName, ds.Name)
			if err := os.MkdirAll(filepath.Dir(logFile), 0o755); err != nil {
				return nil, fmt.Errorf("failed to create log dir: %w", err)
			}
			if err := os.WriteFile(logFile, nil, 0o644); err != nil {
				return nil, fmt.Errorf("failed to truncate log file: %w", err)
			}

			portStr := fmt.Sprintf("%d", route.InternalPort)
			expanded := strings.ReplaceAll(ds.Command, "$PORT", portStr)
			cmd := fmt.Sprintf("PORT=%s %s", portStr, expanded)
			crewExec.TmuxNewWindow(session, windowName, dir)
			crewExec.TmuxPipePaneToFile(session, windowName, logFile)
			_ = crewExec.TmuxSendKeys(session+":"+windowName, cmd)
		}
	}

	if !noProxy {
		if err := EnsureProxy(domain, proxyPort); err != nil {
			return nil, err
		}
	}

	return newRoutes, nil
}

// StopAll kills dev sessions. Empty wsName kills all dev sessions.
// Does NOT manage the shared proxy — callers should call StopProxyIfIdle()
// after an explicit stop, or leave the proxy running for restarts.
func StopAll(wsName string) {
	if wsName != "" {
		crewExec.KillTmuxSession(SessionName(wsName))
		removeRoutesFile(wsName)
		return
	}

	for _, session := range listDevSessions() {
		ws := strings.TrimPrefix(session, "crew-dev-")
		crewExec.KillTmuxSession(session)
		removeRoutesFile(ws)
	}
	crewExec.KillTmuxSession(ProxySessionName)
}

// StopProxyIfIdle kills the shared proxy if no proxied routes remain.
// No-proxy routes don't count — they're served on localhost, not via the proxy.
func StopProxyIfIdle() {
	allRoutes, _ := ListAllRoutes()
	for _, wr := range allRoutes {
		for _, r := range wr.Routes {
			if r.Proxied() {
				return
			}
		}
	}
	debug.Log("dev", "no proxied routes left, killing proxy")
	crewExec.KillTmuxSession(ProxySessionName)
}

// FindFreePort returns a random available TCP port.
func FindFreePort() (int, error) {
	l, err := net.Listen("tcp", ":0")
	if err != nil {
		return 0, err
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port, nil
}

// ResolveHostIP returns the configured server IP from settings,
// falling back to auto-detected LAN IP.
func ResolveHostIP() string {
	if ip := config.LoadSettings().ServerIP; ip != "" {
		return ip
	}
	return detectLANIP()
}

func detectLANIP() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "127.0.0.1"
	}
	for _, addr := range addrs {
		if ipNet, ok := addr.(*net.IPNet); ok && !ipNet.IP.IsLoopback() && ipNet.IP.To4() != nil {
			return ipNet.IP.String()
		}
	}
	return "127.0.0.1"
}

// --- helpers ---

// EnsureProxy starts the shared reverse proxy if it's not already running.
func EnsureProxy(domain string, port int) error {
	if crewExec.TmuxSessionExists(ProxySessionName) {
		debug.Log("dev", "proxy already running in %s", ProxySessionName)
		return nil
	}

	debug.Log("dev", "starting shared proxy on %s:%d", domain, port)
	if err := crewExec.CreateTmuxSession(ProxySessionName, ""); err != nil {
		return fmt.Errorf("failed to create proxy session: %w", err)
	}

	crewBin, err := os.Executable()
	if err != nil {
		crewBin = "crew"
	}

	cmd := fmt.Sprintf("%s dev _proxy --domain=%s --port=%d", crewBin, domain, port)
	debug.Log("dev", "proxy cmd: %s", cmd)
	return crewExec.TmuxSendKeys(ProxySessionName, cmd)
}

func listDevSessions() []string {
	var sessions []string
	for _, s := range crewExec.ListTmuxSessions() {
		if strings.HasPrefix(s, "crew-dev-") && s != ProxySessionName {
			sessions = append(sessions, s)
		}
	}
	return sessions
}
