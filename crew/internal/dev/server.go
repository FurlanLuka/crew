package dev

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

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

// ProxySessionName is the proxy's tmux session. A variable, not a const: the
// tmux server is shared with whatever the user runs, so tests point this at
// a name of their own and never touch a live proxy.
var ProxySessionName = "crew-dev-proxy"

// SessionName returns the tmux session name for dev servers.
func SessionName(slug Slug) string {
	return "crew-dev-" + string(slug)
}

// SetupSessionName is the tmux session a worktree's setup runners live in —
// one window per project while it is being created, verified or set up.
func SetupSessionName(slug Slug) string {
	return "crew-setup-" + string(slug)
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
	// Reserved is the port each server got last time, keyed "project/server".
	// A reserved port is reused when still free, so a worktree's ports survive
	// restarts and anything holding a URL from crew env stays valid.
	Reserved  map[string]int
	Domain    string
	ProxyPort int
	NoProxy   bool
}

// StartResult reports what started and what crew has to say about it.
type StartResult struct {
	Routes      []Route
	Resolutions []Resolution
	Conflicts   []Conflict
	// Warnings are facts crew owns that went wrong without stopping the
	// start — today, a proxy session that came up with nothing listening.
	Warnings []string
	// Ports is every server's port as bound, keyed "project/server", for the
	// caller to persist as next time's reservation.
	Ports map[string]int
}

// PortKey is how a server's reservation is keyed.
func PortKey(project, server string) string { return project + "/" + server }

// PlannedFromRoutes rebuilds the planned servers for a worktree from its route
// file, so anything that inspects a running worktree — the worktree page, crew
// env — sees the same shape Start does.
func PlannedFromRoutes(projects []DevProject, routes []Route) []PlannedServer {
	byKey := make(map[ProjectServer]Route, len(routes))
	for _, r := range routes {
		byKey[ProjectServer{Project: r.Project, Server: r.ServerName}] = r
	}

	var planned []PlannedServer
	for _, p := range projects {
		for _, ds := range p.DevServers {
			r, ok := byKey[ProjectServer{Project: p.Name, Server: ds.Name}]
			if !ok {
				continue
			}
			dir := p.Path
			if ds.Dir != "" {
				dir = filepath.Join(p.Path, ds.Dir)
			}
			planned = append(planned, PlannedServer{Project: p.Name, Server: ds, Dir: dir, Route: r})
		}
	}
	return planned
}

// AllocatePorts returns one port per server, in order. A reserved port that
// is still free is kept; anything else gets a fresh free port.
func AllocatePorts(projects []DevProject, reserved map[string]int) ([]int, error) {
	var ports []int
	for _, p := range projects {
		for _, ds := range p.DevServers {
			if want := reserved[PortKey(p.Name, ds.Name)]; want > 0 && PortFree(want) {
				ports = append(ports, want)
				continue
			}
			port, err := FindFreePort()
			if err != nil {
				return nil, fmt.Errorf("failed to find free port: %w", err)
			}
			ports = append(ports, port)
		}
	}
	return ports, nil
}

// WaitPortsFree blocks until every reserved port can be bound, or the timeout
// passes. Used after stopping a session so a restart lands on the same ports.
func WaitPortsFree(reserved map[string]int, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for {
		busy := false
		for _, port := range reserved {
			if port > 0 && !PortFree(port) {
				busy = true
				break
			}
		}
		if !busy || time.Now().After(deadline) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// PortFree reports whether a TCP port can be bound right now.
func PortFree(port int) bool {
	l, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return false
	}
	l.Close()
	return true
}

// Start starts dev servers for one worktree on freshly allocated ports. When
// NoProxy is false it also launches the shared reverse proxy; when true, the
// servers are addressed directly as localhost:<port> and the proxy is skipped.
// Projects should already have the correct paths (worktree paths).
func Start(p StartParams) (StartResult, error) {
	// Allocate every port before starting anything: dev servers reference each
	// other's ports, so allocation has to complete before the first one runs.
	ports, err := AllocatePorts(p.Projects, p.Reserved)
	if err != nil {
		return StartResult{}, err
	}

	planned := PlanServers(p.Projects, ports, p.NoProxy)
	bound := make(map[string]int, len(planned))
	for _, ps := range planned {
		bound[PortKey(ps.Project, ps.Server.Name)] = ps.Route.InternalPort
	}

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
		if err := startServerWindow(session, fmt.Sprintf("%s/%s", p.Slug, ps.Server.Name), LogFile(p.Slug, ps.Server.Name), ps, byProject[ps.Project]); err != nil {
			return StartResult{}, err
		}
	}

	var warnings []string
	if !p.NoProxy {
		if err := EnsureProxy(p.Domain, p.ProxyPort); err != nil {
			return StartResult{}, err
		}
		if w := ProxyWarning(p.ProxyPort); w != "" {
			debug.Log("dev", "%s", w)
			warnings = append(warnings, w)
		}
	}

	return StartResult{
		Routes:      newRoutes,
		Resolutions: resolutions,
		Conflicts:   InspectEnvConflicts(p.Slug, p.Projects, planned, resolutions),
		Warnings:    warnings,
		Ports:       bound,
	}, nil
}

// StopAll kills dev sessions. An empty slug kills every dev session, every
// setup session and the shared proxy with them; a per-slug stop leaves the
// proxy alone — callers call StopProxyIfIdle() after an explicit stop, or
// keep it across a restart.
func StopAll(slug Slug) {
	if slug != "" {
		crewExec.KillTmuxSession(SessionName(slug))
		removeRoutesFile(slug)
		return
	}

	for _, session := range sessionsToStop(crewExec.ListTmuxSessions(), ProxySessionName) {
		crewExec.KillTmuxSession(session)
		if slug, ok := strings.CutPrefix(session, "crew-dev-"); ok {
			removeRoutesFile(Slug(slug))
		}
	}
	StopProxy()
}

// sessionsToStop is every crew session a stop-all takes down: dev
// sessions and setup runners; the proxy has its own stop. Pure.
func sessionsToStop(all []string, proxy string) []string {
	var out []string
	for _, s := range all {
		if s == proxy {
			continue
		}
		if strings.HasPrefix(s, "crew-dev-") || strings.HasPrefix(s, "crew-setup-") {
			out = append(out, s)
		}
	}
	return out
}

// StopSetup kills a worktree's setup session — its runners and whatever
// servers a smoke had up.
func StopSetup(slug Slug) {
	crewExec.KillTmuxSession(SetupSessionName(slug))
}

// ProjectServersParams is what a setup runner needs to smoke one project's
// servers: every project (bindings resolve against siblings), the reserved
// ports the smoke binds, and which project's servers to start.
type ProjectServersParams struct {
	Session   string
	Slug      Slug
	Workspace string
	Worktree  string
	Projects  []DevProject
	Project   string
	Overrides map[string]string
	Ports     map[string]int // "project/server" → port, every server covered
	LogFile   func(server string) string
}

// StartProjectServers starts one project's servers as windows of the given
// session on the ports handed in — no allocation, no routes file, no proxy:
// a smoke is transient and must not look like a dev start to anything that
// reads routes. The env is resolved exactly as Start resolves it. Returns
// the routes for the wait loop and the window names for StopWindows.
func StartProjectServers(p ProjectServersParams) ([]Route, []string, error) {
	var mine []DevProject
	for _, dp := range p.Projects {
		if dp.Name == p.Project {
			mine = append(mine, dp)
		}
	}
	var ports []int
	for _, dp := range mine {
		for _, ds := range dp.DevServers {
			port, ok := p.Ports[PortKey(dp.Name, ds.Name)]
			if !ok || port == 0 {
				return nil, nil, fmt.Errorf("no port reserved for %s", PortKey(dp.Name, ds.Name))
			}
			ports = append(ports, port)
		}
	}
	planned := PlanServers(mine, ports, true)
	if len(planned) == 0 {
		return nil, nil, nil
	}

	resolutions := ResolveBindings(ResolveParams{
		Projects:  p.Projects,
		Ports:     IndexReservedPorts(p.Ports),
		Workspace: p.Workspace,
		Worktree:  p.Worktree,
		Overrides: p.Overrides,
	})
	LogResolutions(p.Slug, resolutions)
	byProject := GroupResolutions(resolutions)

	if !crewExec.TmuxSessionExists(p.Session) {
		if err := crewExec.CreateTmuxSession(p.Session, ""); err != nil {
			return nil, nil, fmt.Errorf("failed to create session: %w", err)
		}
	}
	var routes []Route
	var windows []string
	for _, ps := range planned {
		window := fmt.Sprintf("%s/%s", ps.Project, ps.Server.Name)
		if err := startServerWindow(p.Session, window, p.LogFile(ps.Server.Name), ps, byProject[ps.Project]); err != nil {
			return routes, windows, err
		}
		routes = append(routes, ps.Route)
		windows = append(windows, window)
	}
	return routes, windows, nil
}

// startServerWindow is one dev server as a window: its log truncated and
// piped, then the command sent. The pipe is set before the command so the
// first lines are not lost.
func startServerWindow(session, window, logFile string, ps PlannedServer, resolutions []Resolution) error {
	if err := os.MkdirAll(filepath.Dir(logFile), 0o755); err != nil {
		return fmt.Errorf("failed to create log dir: %w", err)
	}
	if err := os.WriteFile(logFile, nil, 0o644); err != nil {
		return fmt.Errorf("failed to truncate log file: %w", err)
	}
	crewExec.TmuxNewWindow(session, window, ps.Dir)
	crewExec.TmuxPipePaneToFile(session, window, logFile)
	// A failed send-keys is logged by TmuxSendKeys and shows up as a dead
	// pane at the check; the other servers still start.
	_ = crewExec.TmuxSendKeys(session+":"+window, ServerCommand(ps, resolutions))
	return nil
}

// StopWindows kills the named windows of a session, each with the pane
// sweep a session kill does — a smoke's servers leak children otherwise.
// A session left with nothing but idle shells goes too: a runner in its
// own window keeps the session alive, an in-process one has no window
// there and would leave the shell the session was created with.
func StopWindows(session string, windows []string) {
	for _, w := range windows {
		crewExec.KillTmuxWindow(session, w)
	}
	if crewExec.TmuxSessionExists(session) && crewExec.TmuxSessionIdle(session) {
		crewExec.KillTmuxSession(session)
	}
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
	StopProxy()
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

// ProxyStatusURL is the proxy's own page — every proxied URL, served for any
// hostname it does not route. The first thing to open from another device.
func ProxyStatusURL() string {
	return statusURL(ResolveHostIP(), config.LoadSettings().GetProxyPort())
}

func statusURL(host string, port int) string {
	if port != 80 {
		host = fmt.Sprintf("%s:%d", host, port)
	}
	return "http://" + host + "/"
}

// proxyState is what the running proxy was launched with. The proxy matches
// hostnames against the domain it started with, so a settings change
// (server_ip, domain, proxy_port) after it is up would print URLs the proxy
// never answers. EnsureProxy compares against this and relaunches.
type proxyState struct {
	Domain string `json:"domain"`
	Port   int    `json:"port"`
	// Error is why the proxy exited, written by the proxy itself: the pane
	// is not a reliable record (a prompt redraw can clear it).
	Error string `json:"error,omitempty"`
}

func proxyStatePath() string { return filepath.Join(config.ConfigDir, "dev-proxy.json") }

func loadProxyState() (proxyState, bool) {
	data, err := os.ReadFile(proxyStatePath())
	if err != nil {
		return proxyState{}, false
	}
	var st proxyState
	if err := json.Unmarshal(data, &st); err != nil {
		return proxyState{}, false
	}
	return st, true
}

func saveProxyState(st proxyState) error {
	data, err := json.Marshal(st)
	if err != nil {
		return err
	}
	return os.WriteFile(proxyStatePath(), data, 0o644)
}

// RecordProxyError is the proxy's own last word before it exits — a bind
// failure, usually — kept beside its launch settings for the warning.
func RecordProxyError(err error) {
	st, _ := loadProxyState()
	st.Error = err.Error()
	if werr := saveProxyState(st); werr != nil {
		debug.Log("dev", "proxy error not recorded: %v", werr)
	}
}

// StopProxy kills the proxy session and forgets what it was launched with.
func StopProxy() {
	crewExec.KillTmuxSession(ProxySessionName)
	os.Remove(proxyStatePath())
}

// ProxyStatus is the proxy as crew knows it: whether its session is up and
// crew's own proxy answers on its port, and what it was launched with.
type ProxyStatus struct {
	Running   bool   `json:"running"`
	Listening bool   `json:"listening"` // crew's proxy answers, not merely something on the port
	Domain    string `json:"domain,omitempty"`
	Port      int    `json:"port,omitempty"`
	URL       string `json:"url,omitempty"`
	Error     string `json:"error,omitempty"` // why the proxy exited, if it did
}

// InspectProxy reports the running proxy. A session without a listener is
// the failure mode a user cannot see from `crew dev status`: the URLs print,
// nothing answers.
func InspectProxy() ProxyStatus {
	st := ProxyStatus{Running: crewExec.TmuxSessionExists(ProxySessionName)}
	have, ok := loadProxyState()
	if !ok {
		// A session with no record predates the record; the next --proxy
		// start relaunches it, so report the settings it will get.
		settings := config.LoadSettings()
		have = proxyState{Domain: settings.GetDomain(ResolveHostIP()), Port: settings.GetProxyPort()}
	}
	st.Domain, st.Port, st.Error = have.Domain, have.Port, have.Error
	st.URL = statusURL(ResolveHostIP(), have.Port)
	if st.Running {
		st.Listening = proxyAnswers(have.Port, 0)
	}
	return st
}

// proxyAnswers asks loopback:<port> for the proxy's status page, retrying
// for up to wait — the proxy binds a moment after send-keys returns. A
// bare dial would not do: whatever else holds the port (another app on 80)
// answers a dial just as well, and that is exactly the case to catch.
func proxyAnswers(port int, wait time.Duration) bool {
	// No keep-alive: a probe must not hold a connection open to the proxy,
	// and a kept one would keep answering after the listener is gone.
	client := &http.Client{Timeout: 500 * time.Millisecond, Transport: &http.Transport{DisableKeepAlives: true}}
	deadline := time.Now().Add(wait)
	for {
		if isProxyStatusPage(client, port) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func isProxyStatusPage(client *http.Client, port int) bool {
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/", port))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	return strings.Contains(string(body), proxyPageMarker)
}

// ProxyWarning is what a start prints when the proxy session is up but
// crew's proxy does not answer. The reason is what the proxy recorded on
// its way out; the pane is the fallback for a proxy that never got that far.
func ProxyWarning(port int) string {
	if proxyAnswers(port, 2*time.Second) {
		return ""
	}
	if st, ok := loadProxyState(); ok && st.Error != "" {
		return fmt.Sprintf("proxy is not answering on :%d — %s", port, st.Error)
	}
	out, _ := crewExec.CaptureTmuxPane(ProxySessionName, "", 10)
	if reason := paneError(out); reason != "" {
		return fmt.Sprintf("proxy is not answering on :%d — %s", port, reason)
	}
	// No recorded error and a quiet pane: the bind went through but
	// something else answers the port (macOS lets two SO_REUSEADDR
	// listeners share one; the older one gets the connections).
	return fmt.Sprintf("proxy is not answering on :%d — another server holds the port? lsof -nP -iTCP:%d -sTCP:LISTEN", port, port)
}

// paneError is the last line of a pane that reads like an error. After a
// bind failure the process has exited, so the very last line is the shell
// prompt — the error sits above it. "listen" is not a keyword: the proxy's
// own "Listening on" banner would match. Pure.
func paneError(pane string) string {
	lines := strings.Split(pane, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		l := strings.TrimSpace(lines[i])
		low := strings.ToLower(l)
		if strings.Contains(low, "error") || strings.Contains(low, "bind") || strings.Contains(low, "denied") || strings.Contains(low, "in use") {
			return l
		}
	}
	return ""
}

// EnsureProxy starts the shared reverse proxy on domain:port, relaunching a
// running one that was started with different settings.
func EnsureProxy(domain string, port int) error {
	want := proxyState{Domain: domain, Port: port}
	if crewExec.TmuxSessionExists(ProxySessionName) {
		// No record means a proxy from before crew kept one; relaunching is
		// cheaper than guessing what it serves.
		have, ok := loadProxyState()
		switch {
		case ok && have.Error != "":
			debug.Log("dev", "proxy exited (%s) — relaunching", have.Error)
		case ok && have.Domain == want.Domain && have.Port == want.Port:
			debug.Log("dev", "proxy already running in %s", ProxySessionName)
			return nil
		case ok:
			debug.Log("dev", "proxy running with %s:%d, want %s:%d — relaunching", have.Domain, have.Port, domain, port)
		default:
			debug.Log("dev", "proxy running with no launch record — relaunching")
		}
		StopProxy()
	}

	debug.Log("dev", "starting shared proxy on %s:%d", domain, port)
	if err := crewExec.CreateTmuxSession(ProxySessionName, ""); err != nil {
		return fmt.Errorf("failed to create proxy session: %w", err)
	}

	crewBin, err := crewExec.CrewBinary()
	if err != nil {
		crewBin = "crew"
	}

	// The record goes down before the launch: a proxy that fails its bind
	// at once writes its error into it, and a record written afterwards
	// would erase that. A lost record only costs a relaunch next time —
	// warn, never block.
	if err := saveProxyState(want); err != nil {
		debug.Log("dev", "proxy state not saved: %v", err)
	}
	cmd := fmt.Sprintf("%s dev _proxy --domain=%s --port=%d", crewBin, domain, port)
	debug.Log("dev", "proxy cmd: %s", cmd)
	return crewExec.TmuxSendKeys(ProxySessionName, cmd)
}
