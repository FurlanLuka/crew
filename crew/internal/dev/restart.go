package dev

import (
	"errors"
	"fmt"
	"net"
	"os"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/debug"
	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

// ErrNotRunning: a one-server restart needs the worktree's servers up —
// there is no running set to put the server back into.
var ErrNotRunning = errors.New("not running")

// ErrStartedBefore66: the session named its windows by server alone, so
// one server cannot be found and replaced; a full restart renames them.
var ErrStartedBefore66 = errors.New("started before crew 6.6")

// NotInRunningSetError: the server was added after the worktree started,
// so the running set has no route, port or window for it.
type NotInRunningSetError struct{ Server string }

func (e NotInRunningSetError) Error() string { return e.Server + " is not in the running set" }

// RestartServerParams is one server to restart in a running worktree.
type RestartServerParams struct {
	Slug      Slug
	Workspace string
	Worktree  string
	Projects  []DevProject
	Overrides map[string]string
	Target    ProjectServer
}

// restartTarget finds the server to restart in the running set and the port
// index to resolve against. Ports come from the routes Start wrote, not the
// remembered ones: siblings' bindings already point at the route's port, and
// the env must come out exactly as Start built it. Pure.
func restartTarget(projects []DevProject, routes []Route, target ProjectServer) (PlannedServer, map[ProjectServer]int, error) {
	if len(routes) == 0 {
		return PlannedServer{}, nil, ErrNotRunning
	}
	for _, ps := range PlannedFromRoutes(projects, routes) {
		if ps.Project != target.Project || ps.Server.Name != target.Server {
			continue
		}
		if ps.Route.Window == "" {
			return PlannedServer{}, nil, ErrStartedBefore66
		}
		return ps, IndexRoutePorts(routes), nil
	}
	return PlannedServer{}, nil, NotInRunningSetError{Server: PortKey(target.Project, target.Server)}
}

// RestartServer replaces one server's window on its own port. The routes are
// not rewritten, only their time touched so readers count the server as
// starting — its siblings with it, for one smoke ceiling; a server whose
// window already died just starts.
func RestartServer(p RestartServerParams) (Route, error) {
	routes, err := LoadRoutes(p.Slug)
	if err != nil {
		return Route{}, err
	}
	ps, ports, err := restartTarget(p.Projects, routes, p.Target)
	if err != nil {
		return Route{}, err
	}

	resolutions := ResolveBindings(ResolveParams{
		Projects:  p.Projects,
		Ports:     ports,
		Workspace: p.Workspace,
		Worktree:  p.Worktree,
		Overrides: p.Overrides,
	})
	LogResolutions(p.Slug, resolutions)

	session := SessionName(p.Slug)
	debug.Log("dev", "restart %s in %s", PortKey(ps.Project, ps.Server.Name), session)
	// Never StopWindows: it takes the session down once only idle shells
	// remain, which a one-server worktree always reaches.
	crewExec.KillTmuxWindow(session, ps.Route.Window)
	if ps.Route.Listens() {
		port := map[string]int{PortKey(ps.Project, ps.Server.Name): ps.Route.InternalPort}
		WaitPortsFree(port, 3*time.Second)
		if portHeld(ps.Route.InternalPort) {
			// Starting anyway would fail to bind and read as "died" — a
			// verdict about the wrong thing.
			return ps.Route, fmt.Errorf("port %d is still in use after stopping %s — something else holds it", ps.Route.InternalPort, PortKey(ps.Project, ps.Server.Name))
		}
	}
	if !crewExec.TmuxSessionExists(session) {
		if err := crewExec.CreateTmuxSession(session, ""); err != nil {
			return ps.Route, fmt.Errorf("failed to create tmux session: %w", err)
		}
	}
	if _, err := startPlanned(devLayout(p.Slug, session, []PlannedServer{ps}, resolutions)); err != nil {
		return ps.Route, err
	}
	// Readers count "still starting" from the routes file's time; a restart
	// leaves the file as it was, so it is touched — a server just restarted
	// is starting, not unreached.
	now := time.Now()
	if err := os.Chtimes(RoutesFilePath(p.Slug), now, now); err != nil {
		debug.Log("dev", "touch routes for %s: %v", p.Slug, err)
	}
	return ps.Route, nil
}

// portHeld: something still holds the port. A bind test alone misses a
// holder on 127.0.0.1 — macOS lets the dual-stack bind succeed beside it —
// so a dial that answers counts too.
func portHeld(port int) bool {
	return !PortFree(port) || PortAnswers(port)
}

// PortAnswers: something accepts on the port, on 127.0.0.1 or [::1].
func PortAnswers(port int) bool {
	for _, host := range []string{"127.0.0.1", "[::1]"} {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", host, port), 200*time.Millisecond)
		if err == nil {
			conn.Close()
			return true
		}
	}
	return false
}
