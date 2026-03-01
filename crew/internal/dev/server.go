package dev

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// DevProject is the data StartWorktree needs per project.
// Kept separate from workspace.Project to avoid import cycles.
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

// StartWorktree starts dev servers for a worktree and updates the proxy.
// projects should already have the correct paths (worktree paths if applicable).
func StartWorktree(baseWsName string, projects []DevProject, worktreeName, host string) ([]Route, error) {
	subdomain := worktreeName
	if subdomain == "" {
		subdomain = "main"
	}

	// Build new routes
	var newRoutes []Route
	for _, p := range projects {
		for _, ds := range p.DevServers {
			port, err := FindFreePort()
			if err != nil {
				return nil, fmt.Errorf("failed to find free port: %w", err)
			}
			newRoutes = append(newRoutes, Route{
				Subdomain:    subdomain,
				ExternalPort: ds.Port,
				InternalPort: port,
			})
		}
	}

	// Load existing routes, append new ones
	existing, _ := LoadRoutes(baseWsName)
	filtered := filterRoutes(existing, subdomain)
	allRoutes := append(filtered, newRoutes...)

	if err := SaveRoutes(baseWsName, allRoutes); err != nil {
		return nil, err
	}

	session := SessionName(baseWsName)

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

			windowName := fmt.Sprintf("%s/%s", subdomain, ds.Name)
			dir := p.Path
			if ds.Dir != "" {
				dir = filepath.Join(p.Path, ds.Dir)
			}

			cmd := fmt.Sprintf("PORT=%d %s", route.InternalPort, ds.Command)
			createTmuxWindow(session, windowName, dir, cmd)
		}
	}

	// Start/restart proxy window
	restartProxy(session, baseWsName, host)

	return newRoutes, nil
}

// StopWorktree stops dev servers for a specific worktree.
func StopWorktree(baseWsName, worktreeName string) error {
	subdomain := worktreeName
	if subdomain == "" {
		subdomain = "main"
	}

	session := SessionName(baseWsName)

	// Kill tmux windows for this worktree
	killWindowsWithPrefix(session, subdomain+"/")

	// Update routes
	existing, _ := LoadRoutes(baseWsName)
	filtered := filterRoutes(existing, subdomain)

	if len(filtered) == 0 {
		killTmuxSession(session)
		RemoveRoutesFile(baseWsName)
		return nil
	}

	if err := SaveRoutes(baseWsName, filtered); err != nil {
		return err
	}

	restartProxy(session, baseWsName, "")
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
	return cmd.Run() == nil
}

func createTmuxSession(session string) error {
	return exec.Command("tmux", "new-session", "-d", "-s", session).Run()
}

func killTmuxSession(session string) {
	exec.Command("tmux", "kill-session", "-t", session).Run()
}

func createTmuxWindow(session, name, dir, command string) {
	exec.Command("tmux", "new-window", "-t", session, "-n", name, "-c", dir).Run()
	exec.Command("tmux", "send-keys", "-t", session+":"+name, command, "Enter").Run()
}

func killWindowsWithPrefix(session, prefix string) {
	out, err := exec.Command("tmux", "list-windows", "-t", session, "-F", "#{window_name}").Output()
	if err != nil {
		return
	}
	for _, name := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if strings.HasPrefix(name, prefix) {
			exec.Command("tmux", "kill-window", "-t", session+":"+name).Run()
		}
	}
}

func restartProxy(session, wsName, host string) {
	exec.Command("tmux", "kill-window", "-t", session+":proxy").Run()

	crewBin, err := os.Executable()
	if err != nil {
		crewBin = "crew"
	}

	cmd := fmt.Sprintf("%s dev _proxy --ws=%s", crewBin, wsName)
	if host != "" {
		cmd += fmt.Sprintf(" --host=%s", host)
	}

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
