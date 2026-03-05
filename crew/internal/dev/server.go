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

// SessionName returns the tmux session name for dev servers.
func SessionName(wsName string) string {
	return "crew-dev-" + wsName
}

// Start starts dev servers for a workspace and updates the proxy.
// projects should already have the correct paths (workspace worktree paths).
func Start(wsName string, projects []DevProject, host string) ([]Route, error) {
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
				ExternalPort: ds.Port,
				InternalPort: port,
			})
		}
	}

	// Load existing routes, replace with new ones
	existing, _ := LoadRoutes(wsName)
	filtered := filterRoutes(existing, wsName)
	allRoutes := append(filtered, newRoutes...)

	if err := SaveRoutes(wsName, allRoutes); err != nil {
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

	// Start/restart proxy window
	restartProxy(session, wsName, host)

	return newRoutes, nil
}

// Stop stops dev servers for a workspace.
func Stop(wsName string) error {
	session := SessionName(wsName)

	// Kill tmux windows for this workspace
	killWindowsWithPrefix(session, wsName+"/")

	// Update routes
	existing, _ := LoadRoutes(wsName)
	filtered := filterRoutes(existing, wsName)

	if len(filtered) == 0 {
		killTmuxSession(session)
		RemoveRoutesFile(wsName)
		return nil
	}

	if err := SaveRoutes(wsName, filtered); err != nil {
		return err
	}

	restartProxy(session, wsName, "")
	return nil
}

// StopAll kills dev sessions. Empty wsName kills all dev sessions.
func StopAll(wsName string) {
	if wsName != "" {
		session := SessionName(wsName)
		killTmuxSession(session)
		RemoveRoutesFile(wsName)
		return
	}

	for _, session := range listDevSessions() {
		ws := strings.TrimPrefix(session, "crew-dev-")
		killTmuxSession(session)
		RemoveRoutesFile(ws)
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

func filterRoutes(routes []Route, subdomain string) []Route {
	var out []Route
	for _, r := range routes {
		if r.Subdomain != subdomain {
			out = append(out, r)
		}
	}
	return out
}

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

func killWindowsWithPrefix(session, prefix string) {
	debug.Log("dev", "kill-windows with prefix %s in %s", prefix, session)
	out, err := exec.Command("tmux", "list-windows", "-t", session, "-F", "#{window_name}").Output()
	if err != nil {
		return
	}
	for _, name := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if strings.HasPrefix(name, prefix) {
			debug.Log("dev", "kill-window -t %s:%s", session, name)
			exec.Command("tmux", "kill-window", "-t", session+":"+name).Run()
		}
	}
}

func restartProxy(session, wsName, host string) {
	debug.Log("dev", "restart proxy for %s (host: %s)", wsName, host)
	exec.Command("tmux", "kill-window", "-t", session+":proxy").Run()

	crewBin, err := os.Executable()
	if err != nil {
		crewBin = "crew"
	}

	cmd := fmt.Sprintf("%s dev _proxy --ws=%s", crewBin, wsName)
	if host != "" {
		cmd += fmt.Sprintf(" --host=%s", host)
	}

	debug.Log("dev", "proxy cmd: %s", cmd)
	exec.Command("tmux", "new-window", "-t", session, "-n", "proxy").Run()
	exec.Command("tmux", "send-keys", "-t", session+":proxy", cmd, "Enter").Run()
}

func listDevSessions() []string {
	out, err := exec.Command("tmux", "list-sessions", "-F", "#{session_name}").Output()
	if err != nil {
		return nil
	}
	var sessions []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if strings.HasPrefix(line, "crew-dev-") {
			sessions = append(sessions, line)
		}
	}
	return sessions
}
