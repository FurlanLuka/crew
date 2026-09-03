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
	Name       string
	Path       string
	DevServers []DevServerConfig
	Bindings   []Binding
}

type DevServerConfig struct {
	Name    string
	Port    int
	Command string
	Dir     string
}

const ProxySessionName = "crew-dev-proxy"

// SessionName returns the tmux session name for dev servers.
func SessionName(slug Slug) string {
	return "crew-dev-" + string(slug)
}

// LogDir returns the directory holding dev server log files for a worktree.
func LogDir(slug Slug) string {
	return filepath.Join(config.ConfigDir, "logs", string(slug))
}

// LogFile returns the log file path for a specific dev server.
func LogFile(slug Slug, serverName string) string {
	return filepath.Join(LogDir(slug), serverName+".log")
}

// PlannedServer is one dev server with its port already allocated and its
// working directory already joined — the pairing of project, server and route
// that Start's two passes would otherwise have to rebuild positionally.
type PlannedServer struct {
	Project string
	Server  DevServerConfig
	Dir     string
	Route   Route
}

// PlanServers pairs each configured dev server with one allocated port.
// Pure: ports are allocated by the caller and handed in, in order.
//
// The port is always the allocated one, proxy or not. The configured port is
// reference only — binding to it would mean two worktrees of the same project
// cannot run at once, and it is how an env file pointing at localhost:3000
// ended up talking to another workspace's homepage. NoProxy only decides
// whether the route is served through the proxy or addressed as localhost.
func PlanServers(projects []DevProject, ports []int, noProxy bool) []PlannedServer {
	var planned []PlannedServer
	i := 0
	for _, p := range projects {
		for _, ds := range p.DevServers {
			port := ds.Port
			if i < len(ports) {
				port = ports[i]
			}
			i++

			dir := p.Path
			if ds.Dir != "" {
				dir = filepath.Join(p.Path, ds.Dir)
			}

			planned = append(planned, PlannedServer{
				Project: p.Name,
				Server:  ds,
				Dir:     dir,
				Route: Route{
					Project:      p.Name,
					ServerName:   ds.Name,
					ExternalPort: ds.Port,
					InternalPort: port,
					NoProxy:      noProxy,
				},
			})
		}
	}
	return planned
}

// countServers returns how many ports Start needs to allocate.
func countServers(projects []DevProject) int {
	n := 0
	for _, p := range projects {
		n += len(p.DevServers)
	}
	return n
}

// ServerCommand assembles the shell line for one dev server: exports for
// this project's resolved variables, then PORT, then the configured command
// with $PORT expanded. Pure, so the exact string can be asserted — it is sent
// to tmux and never returned, and it is the only place resolution reaches a
// process.
func ServerCommand(ps PlannedServer, resolutions []Resolution) string {
	portStr := fmt.Sprintf("%d", ps.Route.InternalPort)
	return EnvPrefix(resolutions) + "PORT=" + portStr + " " + strings.ReplaceAll(ps.Server.Command, "$PORT", portStr)
}

// StartParams is everything Start needs for one worktree.
type StartParams struct {
	Slug      Slug
	Workspace string
	Worktree  string
	Projects  []DevProject
	Overrides map[string]string
	Domain    string
	ProxyPort int
	NoProxy   bool
}

// StartResult reports what started and what crew has to say about it.
type StartResult struct {
	Routes      []Route
	Resolutions []Resolution
	Conflicts   []Conflict
}

// Start starts dev servers for one worktree on freshly allocated ports. When
// NoProxy is false it also launches the shared reverse proxy; when true, the
// servers are addressed directly as localhost:<port> and the proxy is skipped.
// Projects should already have the correct paths (worktree paths).
func Start(p StartParams) (StartResult, error) {
	// Allocate every port before starting anything: dev servers reference each
	// other's ports, so allocation has to complete before the first one runs.
	var ports []int
	for range countServers(p.Projects) {
		freePort, err := FindFreePort()
		if err != nil {
			return StartResult{}, fmt.Errorf("failed to find free port: %w", err)
		}
		ports = append(ports, freePort)
	}

	planned := PlanServers(p.Projects, ports, p.NoProxy)

	newRoutes := make([]Route, 0, len(planned))
	for _, ps := range planned {
		newRoutes = append(newRoutes, ps.Route)
	}

	if err := saveRoutes(p.Slug, newRoutes); err != nil {
		return StartResult{}, err
	}

	resolutions := ResolveBindings(ResolveParams{
		Projects:  p.Projects,
		Ports:     IndexPorts(planned),
		Workspace: p.Workspace,
		Worktree:  p.Worktree,
		Overrides: p.Overrides,
	})
	LogResolutions(p.Slug, resolutions)

	byProject := GroupResolutions(resolutions)
	session := SessionName(p.Slug)

	// Kill any existing session first so Start is idempotent. Without this, a
	// second start while servers are already running would append duplicate
	// windows (and duplicate dev-server process trees) to the live session,
	// while saveRoutes above has already orphaned the old routes — the old
	// servers keep running untracked and leak. KillTmuxSession tree-kills.
	crewExec.KillTmuxSession(session)

	if !crewExec.TmuxSessionExists(session) {
		if err := crewExec.CreateTmuxSession(session, ""); err != nil {
			return StartResult{}, fmt.Errorf("failed to create tmux session: %w", err)
		}
	}

	for _, ps := range planned {
		windowName := fmt.Sprintf("%s/%s", p.Slug, ps.Server.Name)

		logFile := LogFile(p.Slug, ps.Server.Name)
		if err := os.MkdirAll(filepath.Dir(logFile), 0o755); err != nil {
			return StartResult{}, fmt.Errorf("failed to create log dir: %w", err)
		}
		if err := os.WriteFile(logFile, nil, 0o644); err != nil {
			return StartResult{}, fmt.Errorf("failed to truncate log file: %w", err)
		}

		crewExec.TmuxNewWindow(session, windowName, ps.Dir)
		crewExec.TmuxPipePaneToFile(session, windowName, logFile)
		_ = crewExec.TmuxSendKeys(session+":"+windowName, ServerCommand(ps, byProject[ps.Project]))
	}

	if !p.NoProxy {
		if err := EnsureProxy(p.Domain, p.ProxyPort); err != nil {
			return StartResult{}, err
		}
	}

	return StartResult{
		Routes:      newRoutes,
		Resolutions: resolutions,
		Conflicts:   InspectEnvConflicts(p.Slug, p.Projects, resolutions),
	}, nil
}

// StopAll kills dev sessions. An empty slug kills all dev sessions.
// Does NOT manage the shared proxy — callers should call StopProxyIfIdle()
// after an explicit stop, or leave the proxy running for restarts.
func StopAll(slug Slug) {
	if slug != "" {
		crewExec.KillTmuxSession(SessionName(slug))
		removeRoutesFile(slug)
		return
	}

	for _, session := range listDevSessions() {
		crewExec.KillTmuxSession(session)
		removeRoutesFile(Slug(strings.TrimPrefix(session, "crew-dev-")))
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
