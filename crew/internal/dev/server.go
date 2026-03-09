package dev

import (
	"fmt"
	"net"
	"os"
	"os/exec"
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

// Start starts dev servers for a workspace and launches the shared proxy.
// projects should already have the correct paths (workspace worktree paths).
func Start(wsName string, projects []DevProject, domain string, proxyPort int) ([]Route, error) {
	// Build new routes
	var newRoutes []Route
	for _, p := range projects {
		for _, ds := range p.DevServers {
			port, err := FindFreePort()
			if err != nil {
				return nil, fmt.Errorf("failed to find free port: %w", err)
			}
			newRoutes = append(newRoutes, Route{
				Subdomain:    wsName,
				ServerName:   ds.Name,
				ExternalPort: ds.Port,
				InternalPort: port,
			})
		}
	}

	if err := SaveRoutes(wsName, newRoutes); err != nil {
		return nil, err
	}

	session := SessionName(wsName)

	// Ensure tmux session exists
	if !tmuxSessionExists(session) {
		if err := createTmuxSession(session); err != nil {
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

			portStr := fmt.Sprintf("%d", route.InternalPort)
			expanded := strings.ReplaceAll(ds.Command, "$PORT", portStr)
			cmd := fmt.Sprintf("PORT=%s %s", portStr, expanded)
			crewExec.CreateTmuxWindow(session, windowName, dir, cmd)
		}
	}

	// Ensure shared proxy is running
	ensureProxy(domain, proxyPort)

	return newRoutes, nil
}

// StopAll kills dev sessions. Empty wsName kills all dev sessions.
// Does NOT manage the shared proxy — callers should call StopProxyIfIdle()
// after an explicit stop, or leave the proxy running for restarts.
func StopAll(wsName string) {
	if wsName != "" {
		killTmuxSession(SessionName(wsName))
		RemoveRoutesFile(wsName)
		return
	}

	for _, session := range listDevSessions() {
		ws := strings.TrimPrefix(session, "crew-dev-")
		killTmuxSession(session)
		RemoveRoutesFile(ws)
	}
	killTmuxSession(ProxySessionName)
}

// StopProxyIfIdle kills the shared proxy if no route files remain.
func StopProxyIfIdle() {
	allRoutes, _ := ListAllRoutes()
	if len(allRoutes) == 0 {
		debug.Log("dev", "no routes left, killing proxy")
		killTmuxSession(ProxySessionName)
	}
}

// FindFreePort finds a free TCP port.
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
	return DetectLANIP()
}

// DetectLANIP returns the machine's LAN IP address.
func DetectLANIP() string {
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

func tmuxSessionExists(session string) bool {
	cmd := exec.Command("tmux", "has-session", "-t", session)
	exists := cmd.Run() == nil
	debug.Log("dev", "has-session -t %s → %v", session, exists)
	return exists
}

func createTmuxSession(session string) error {
	debug.Log("dev", "new-session -d -s %s", session)
	if err := exec.Command("tmux", "new-session", "-d", "-s", session).Run(); err != nil {
		debug.Log("dev", "new-session -s %s → error: %v", session, err)
		return err
	}
	return nil
}

func killTmuxSession(session string) {
	debug.Log("dev", "kill-session -t %s", session)
	exec.Command("tmux", "kill-session", "-t", session).Run()
}

func ensureProxy(domain string, port int) {
	if tmuxSessionExists(ProxySessionName) {
		debug.Log("dev", "proxy already running in %s", ProxySessionName)
		return
	}

	debug.Log("dev", "starting shared proxy on %s:%d", domain, port)
	if err := createTmuxSession(ProxySessionName); err != nil {
		debug.Log("dev", "failed to create proxy session: %v", err)
		return
	}

	crewBin, err := os.Executable()
	if err != nil {
		crewBin = "crew"
	}

	cmd := fmt.Sprintf("%s dev _proxy --domain=%s --port=%d", crewBin, domain, port)
	debug.Log("dev", "proxy cmd: %s", cmd)
	exec.Command("tmux", "send-keys", "-t", ProxySessionName, cmd, "Enter").Run()
}

func listDevSessions() []string {
	out, err := exec.Command("tmux", "list-sessions", "-F", "#{session_name}").Output()
	if err != nil {
		return nil
	}
	var sessions []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if strings.HasPrefix(line, "crew-dev-") && line != ProxySessionName {
			sessions = append(sessions, line)
		}
	}
	return sessions
}
