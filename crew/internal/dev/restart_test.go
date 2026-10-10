package dev

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

func TestRestartTarget(t *testing.T) {
	projects := []DevProject{
		{Name: "api", Path: "/w/api", DevServers: []DevServerConfig{{Name: "web", Port: 3000}, {Name: "worker"}}},
		{Name: "front", Path: "/w/front", DevServers: []DevServerConfig{{Name: "web", Port: 3001}, {Name: "late", Port: 3002}}},
	}
	routes := []Route{
		{Project: "api", ServerName: "web", InternalPort: 51000, Window: "s/api/web"},
		{Project: "api", ServerName: "worker", Window: "s/api/worker"},
		{Project: "front", ServerName: "web", InternalPort: 51001, Window: "s/front/web"},
	}

	ps, ports, err := restartTarget(projects, routes, ProjectServer{"front", "web"})
	if err != nil || ps.Route.InternalPort != 51001 || ps.Dir != "/w/front" || ps.Route.Window != "s/front/web" {
		t.Fatalf("front/web = %+v, %v", ps, err)
	}
	if ports[ProjectServer{"api", "web"}] != 51000 || len(ports) != 2 {
		t.Errorf("port index = %v, want the two listening routes", ports)
	}

	if ps, _, err := restartTarget(projects, routes, ProjectServer{"api", "worker"}); err != nil || ps.Route.Listens() {
		t.Errorf("a server with no port restarts without one: %+v, %v", ps, err)
	}
	if _, _, err := restartTarget(projects, nil, ProjectServer{"api", "web"}); !errors.Is(err, ErrNotRunning) {
		t.Errorf("no routes → %v, want ErrNotRunning", err)
	}
	var notIn NotInRunningSetError
	if _, _, err := restartTarget(projects, routes, ProjectServer{"front", "late"}); !errors.As(err, &notIn) || notIn.Server != "front/late" {
		t.Errorf("added after the start → %v", err)
	}
	legacy := []Route{{Project: "api", ServerName: "web", InternalPort: 51000}}
	if _, _, err := restartTarget(projects, legacy, ProjectServer{"api", "web"}); !errors.Is(err, ErrStartedBefore66) {
		t.Errorf("pre-6.6 session → %v", err)
	}
}

func TestRoutesProxied(t *testing.T) {
	if RoutesProxied([]Route{{InternalPort: 1, NoProxy: true}, {InternalPort: 0}}) {
		t.Error("no-proxy routes and a portless one are not proxied")
	}
	if !RoutesProxied([]Route{{InternalPort: 1, NoProxy: true}, {InternalPort: 2}}) {
		t.Error("one proxied route makes the worktree proxied")
	}
}

func requireNC(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("nc"); err != nil {
		t.Skip("nc not available")
	}
}

func panePID(t *testing.T, session, window string) string {
	t.Helper()
	out, err := exec.Command("tmux", "display-message", "-p", "-t", session+":"+window, "#{pane_pid}").Output()
	if err != nil {
		t.Fatalf("pane pid of %s: %v", window, err)
	}
	return strings.TrimSpace(string(out))
}

func waitListening(t *testing.T, port int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		// A dial, not PortFree: macOS lets a second listener bind a port
		// another process already holds on a different address family.
		if conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 200*time.Millisecond); err == nil {
			conn.Close()
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("nothing listened on %d", port)
}

// listenCommand keeps a port open the way a dev server would, with tools
// every test machine has.
const listenCommand = `nc -lk $PORT`

// The restarted server comes back on its own port and its sibling's
// process is never touched.
func TestRestartServer_KeepsPortAndSibling(t *testing.T) {
	if !crewExec.HasTmux() {
		t.Skip("tmux not available")
	}
	requireNC(t)
	setupTestConfig(t)
	slug := Slug("ws--rs")
	t.Cleanup(func() { crewExec.KillTmuxSession(SessionName(slug)) })
	projects := []DevProject{
		{Name: "api", Path: t.TempDir(), DevServers: []DevServerConfig{{Name: "web", Port: 3000, Command: listenCommand}},
			Bindings: []Binding{{Var: "FRONT_URL", Value: "{{front/web}}"}}},
		{Name: "front", Path: t.TempDir(), DevServers: []DevServerConfig{{Name: "web", Port: 3001, Command: listenCommand}}},
	}
	res, err := Start(StartParams{Slug: slug, Workspace: "ws", Worktree: "rs", NoProxy: true, Projects: projects})
	if err != nil {
		t.Fatal(err)
	}
	apiPort, frontPort := res.Ports["api/web"], res.Ports["front/web"]
	waitListening(t, apiPort)
	waitListening(t, frontPort)
	frontPID := panePID(t, SessionName(slug), "ws--rs/front/web")
	apiPID := panePID(t, SessionName(slug), "ws--rs/api/web")

	before, _ := os.Stat(RoutesFilePath(slug))
	time.Sleep(20 * time.Millisecond)
	route, err := RestartServer(RestartServerParams{Slug: slug, Workspace: "ws", Worktree: "rs", Projects: projects, Target: ProjectServer{"api", "web"}})
	if err != nil {
		t.Fatal(err)
	}
	if after, _ := os.Stat(RoutesFilePath(slug)); !after.ModTime().After(before.ModTime()) {
		t.Error("a restart touches the routes file, so readers see the server as starting")
	}
	if route.InternalPort != apiPort {
		t.Errorf("restarted on %d, want its own port %d", route.InternalPort, apiPort)
	}
	waitListening(t, apiPort)
	// The restarted window gets the env Start gave it: its binding still
	// resolves to the sibling's running port.
	deadline := time.Now().Add(10 * time.Second)
	want := fmt.Sprintf("FRONT_URL=http://localhost:%d", frontPort)
	for {
		data, _ := os.ReadFile(LogFile(slug, "api", "web"))
		if strings.Contains(string(data), want) || strings.Contains(string(data), fmt.Sprintf("FRONT_URL='http://localhost:%d'", frontPort)) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("restarted api/web never showed %s:\n%s", want, data)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if got := panePID(t, SessionName(slug), "ws--rs/api/web"); got == apiPID {
		t.Error("api/web's pane should be new")
	}
	if got := panePID(t, SessionName(slug), "ws--rs/front/web"); got != frontPID {
		t.Errorf("front/web's pane changed (%s → %s); a sibling must be left alone", frontPID, got)
	}
}

// StopWindows would kill a session left with only idle shells, which is
// every one-server worktree; the restart must survive that and a dead window.
func TestRestartServer_OneServerAndDeadWindow(t *testing.T) {
	if !crewExec.HasTmux() {
		t.Skip("tmux not available")
	}
	requireNC(t)
	setupTestConfig(t)
	slug := Slug("ws--solo")
	t.Cleanup(func() { crewExec.KillTmuxSession(SessionName(slug)) })
	projects := []DevProject{{Name: "api", Path: t.TempDir(), DevServers: []DevServerConfig{{Name: "web", Port: 3000, Command: listenCommand}}}}
	res, err := Start(StartParams{Slug: slug, Workspace: "ws", Worktree: "solo", NoProxy: true, Projects: projects})
	if err != nil {
		t.Fatal(err)
	}
	port := res.Ports["api/web"]
	waitListening(t, port)

	params := RestartServerParams{Slug: slug, Workspace: "ws", Worktree: "solo", Projects: projects, Target: ProjectServer{"api", "web"}}
	if _, err := RestartServer(params); err != nil {
		t.Fatal(err)
	}
	waitListening(t, port)

	crewExec.KillTmuxWindow(SessionName(slug), "ws--solo/api/web")
	if _, err := RestartServer(params); err != nil {
		t.Fatalf("a dead window should just start: %v", err)
	}
	waitListening(t, port)
}

// A port something else holds is refused by name: starting anyway would
// fail to bind and read as "died".
func TestRestartServer_RefusesABusyPort(t *testing.T) {
	if !crewExec.HasTmux() {
		t.Skip("tmux not available")
	}
	setupTestConfig(t)
	slug := Slug("ws--busy")
	t.Cleanup(func() { crewExec.KillTmuxSession(SessionName(slug)) })
	projects := []DevProject{{Name: "api", Path: t.TempDir(), DevServers: []DevServerConfig{{Name: "web", Port: 3000, Command: "sleep 60"}}}}
	res, err := Start(StartParams{Slug: slug, Workspace: "ws", Worktree: "busy", NoProxy: true, Projects: projects})
	if err != nil {
		t.Fatal(err)
	}
	port := res.Ports["api/web"]
	// An IPv4-only holder: the kind a dev server's surviving child leaves,
	// and the one a bind test alone misses on macOS.
	l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()

	_, err = RestartServer(RestartServerParams{Slug: slug, Workspace: "ws", Worktree: "busy", Projects: projects, Target: ProjectServer{"api", "web"}})
	if err == nil || !strings.Contains(err.Error(), fmt.Sprintf("port %d is still in use", port)) {
		t.Errorf("err = %v, want the busy port named", err)
	}
}
