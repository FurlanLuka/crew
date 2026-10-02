package main

import (
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// firstProxied decides whether crew dev status warns about a dead proxy.
func TestFirstProxied(t *testing.T) {
	if got := firstProxied(nil); got != "" {
		t.Errorf("no routes → %q", got)
	}
	local := []dev.WsRoutes{{Slug: "ws--a", Routes: []dev.Route{{ServerName: "api", NoProxy: true}}}}
	if got := firstProxied(local); got != "" {
		t.Errorf("localhost only → %q", got)
	}
	// A server with no port has nothing to proxy either.
	worker := append(local, dev.WsRoutes{Slug: "ws--w", Routes: []dev.Route{{ServerName: "worker"}}})
	if got := firstProxied(worker); got != "" {
		t.Errorf("port-less only → %q", got)
	}
	mixed := append(worker, dev.WsRoutes{Slug: "ws--b", Routes: []dev.Route{{ServerName: "api", InternalPort: 54001}}})
	if got := firstProxied(mixed); got != "ws/b" {
		t.Errorf("mixed → %q, want ws/b", got)
	}
}

func TestParseDevAddArgs(t *testing.T) {
	a, err := parseDevAddArgs([]string{"--name=api", "--rename=server", "--port=4000"})
	if err != nil || a.name != "api" || a.rename != "server" || !a.portGiven || a.port != 4000 || a.cmd != "" {
		t.Errorf("rename without --cmd: %+v, %v", a, err)
	}
	if _, err := parseDevAddArgs([]string{"--name=api"}); err == nil {
		t.Error("an add needs --cmd")
	}
	if a, err := parseDevAddArgs([]string{"--name=api", "--rename=server", "--port=0"}); err != nil || !a.portGiven || a.port != 0 {
		t.Errorf("--port=0 is a port given — does not listen: %+v, %v", a, err)
	}
	if a, err := parseDevAddArgs([]string{"--name=jobs", "--rename=worker", "--dir="}); err != nil || !a.dirGiven || a.dir != "" {
		t.Errorf("--dir= is a dir given — empty, which a rename records as cleared: %+v, %v", a, err)
	}
	if _, err := parseDevAddArgs([]string{"--name=api", "--cmd=x", "--port=-1"}); err == nil {
		t.Error("--port must not be negative")
	}
	if _, err := parseDevAddArgs([]string{"--name=api", "--cmd=x", "--nope"}); err == nil {
		t.Error("unknown flag accepted")
	}
}

// A rename records the old server's values, replaced only by what was given:
// an empty --dir= clears the dir, everything else stands.
func TestRenamedServer(t *testing.T) {
	old := project.DevServer{Name: "server", Port: 3000, Command: "pnpm dev", Dir: "apps/api"}

	cleared := renamedServer(old, devAddArgs{name: "api", rename: "server", dirGiven: true, dir: ""})
	if cleared != (project.DevServer{Name: "api", Port: 3000, Command: "pnpm dev", Dir: ""}) {
		t.Errorf("dir cleared: %+v", cleared)
	}
	kept := renamedServer(old, devAddArgs{name: "api", rename: "server"})
	if kept != (project.DevServer{Name: "api", Port: 3000, Command: "pnpm dev", Dir: "apps/api"}) {
		t.Errorf("nothing given: %+v", kept)
	}
}

// An empty --dir= on a rename is stored: the renamed server has no dir.
func TestApplyDevAdd_RenameClearsDir(t *testing.T) {
	useTempConfig(t)
	project.Add(project.Project{Name: "store-api", Path: "/repos/store-api",
		DevServers: []project.DevServer{{Name: "worker", Command: "pnpm worker", Dir: "worker"}}})

	if _, err := applyDevAdd("store-api", devAddArgs{name: "jobs", rename: "worker", dirGiven: true}); err != nil {
		t.Fatal(err)
	}
	p := project.Get("store-api")
	jobs, err := project.FindServer("store-api", p.DevServers, "jobs")
	if err != nil || jobs.Dir != "" || jobs.Command != "pnpm worker" {
		t.Errorf("jobs = %+v, %v", jobs, err)
	}
}

// A rename keeps the server's place in the bindings: the scoped ones are
// re-scoped, the project-wide ones untouched, the old values kept where
// nothing new was given.
func TestApplyDevAdd_RenameRetargetsScopedBindings(t *testing.T) {
	useTempConfig(t)
	project.Add(project.Project{Name: "store-api", Path: "/repos/store-api",
		DevServers: []project.DevServer{{Name: "server", Port: 3000, Command: "pnpm dev", Dir: "apps/api"}, {Name: "worker", Command: "pnpm worker"}},
		Bindings: []project.Binding{
			{Var: "SIGNALS_URL", Value: "{{store-api/worker}}", Server: "server"},
			{Var: "APP_NAME", Value: "{{worktree}}"},
		}})

	line, err := applyDevAdd("store-api", devAddArgs{name: "api", rename: "server", port: 4000, portGiven: true})
	if err != nil {
		t.Fatal(err)
	}
	if line != "Renamed dev server 'server' → 'api' in store-api (:4000); 1 scoped binding(s) follow it" {
		t.Errorf("line = %q", line)
	}
	p := project.Get("store-api")
	api, err := project.FindServer("store-api", p.DevServers, "api")
	if err != nil || api.Command != "pnpm dev" || api.Dir != "apps/api" || api.Port != 4000 {
		t.Errorf("renamed server = %+v, %v", api, err)
	}
	if _, err := project.FindServer("store-api", p.DevServers, "server"); err == nil {
		t.Error("the old name should be gone")
	}
	if p.Bindings[0].Server != "api" || p.Bindings[1].Server != "" {
		t.Errorf("bindings = %+v", p.Bindings)
	}
	if p.DevServers[0].Name != "api" {
		t.Errorf("the renamed server keeps its place: %+v", p.DevServers)
	}

	if _, err := applyDevAdd("store-api", devAddArgs{name: "worker", rename: "api"}); err == nil || !strings.Contains(err.Error(), "already has a server 'worker'") {
		t.Errorf("rename onto a taken name: %v", err)
	}
	if _, err := applyDevAdd("store-api", devAddArgs{name: "web", rename: "gone"}); err == nil || !strings.Contains(err.Error(), "has no dev server 'gone'") {
		t.Errorf("rename of a missing server: %v", err)
	}
	if _, err := applyDevAdd("nope", devAddArgs{name: "web", cmd: "x"}); err == nil {
		t.Error("unknown project")
	}
	// --rename onto its own name edits in place: the given values change,
	// the rest and the server's place stay.
	if _, err := applyDevAdd("store-api", devAddArgs{name: "api", rename: "api", port: 4100, portGiven: true}); err != nil {
		t.Fatal(err)
	}
	p = project.Get("store-api")
	if len(p.DevServers) != 2 || p.DevServers[0].Name != "api" || p.DevServers[1].Name != "worker" {
		t.Errorf("order changed: %+v", p.DevServers)
	}
	if s := p.DevServers[0]; s.Port != 4100 || s.Command != "pnpm dev" || s.Dir != "apps/api" {
		t.Errorf("in-place edit = %+v", s)
	}
	// --port=0 clears the port: the server stops listening.
	if line, err := applyDevAdd("store-api", devAddArgs{name: "api2", rename: "api", portGiven: true}); err != nil || !strings.Contains(line, "(no port)") {
		t.Errorf("cleared port: %q, %v", line, err)
	}
	if s := project.Get("store-api").DevServers[0]; s.Name != "api2" || s.Port != 0 || s.Command != "pnpm dev" {
		t.Errorf("cleared port = %+v", s)
	}
	// An add without --rename still replaces by name.
	if line, err := applyDevAdd("store-api", devAddArgs{name: "worker", cmd: "pnpm jobs"}); err != nil || line != "Added dev server 'worker' to store-api (no port — it does not listen)" {
		t.Errorf("add: %q, %v", line, err)
	}
}

// A rename re-points every binding in the pool that names the server, in
// this project and others, and the line names them.
func TestApplyDevAdd_RenameRewritesTokens(t *testing.T) {
	useTempConfig(t)
	project.Add(project.Project{Name: "store-api", Path: "/repos/store-api",
		DevServers: []project.DevServer{{Name: "server", Port: 3000, Command: "pnpm dev"}, {Name: "worker", Command: "pnpm worker"}},
		Bindings:   []project.Binding{{Var: "SELF_PORT", Value: "{{store-api/server.port}}", Server: "worker"}}})
	project.Add(project.Project{Name: "store-front", Path: "/repos/store-front",
		DevServers: []project.DevServer{{Name: "web", Port: 3100, Command: "pnpm dev"}},
		Bindings:   []project.Binding{{Var: "STORE_API_URL", Value: "{{store-api/server}}/v1"}, {Var: "LEGACY", Value: "{{url:store-api/server}}"}, {Var: "WORKER", Value: "{{store-api/worker.host}}"}}})

	line, err := applyDevAdd("store-api", devAddArgs{name: "api", rename: "server"})
	if err != nil {
		t.Fatal(err)
	}
	want := "Renamed dev server 'server' → 'api' in store-api (:3000)\nRewrote {{store-api/server}} → {{store-api/api}} in: store-api SELF_PORT (worker), store-front STORE_API_URL, store-front LEGACY"
	if line != want {
		t.Errorf("line =\n%s\nwant\n%s", line, want)
	}
	values := map[string]string{}
	for _, name := range []string{"store-api", "store-front"} {
		for _, b := range project.Get(name).Bindings {
			values[b.Var] = b.Value
		}
	}
	for v, want := range map[string]string{
		"SELF_PORT":     "{{store-api/api.port}}",
		"STORE_API_URL": "{{store-api/api}}/v1",
		"LEGACY":        "{{store-api/api}}",
		"WORKER":        "{{store-api/worker.host}}",
	} {
		if values[v] != want {
			t.Errorf("%s = %q, want %q", v, values[v], want)
		}
	}
}

func TestDroppedBindingsLine(t *testing.T) {
	one := droppedBindingsLine("api", []project.Binding{{Var: "STORE_API_URL", Server: "api"}})
	if one != "Removed 1 binding scoped to api: STORE_API_URL" {
		t.Errorf("one: %q", one)
	}
	two := droppedBindingsLine("api", []project.Binding{{Var: "A", Server: "api"}, {Var: "B", Server: "api"}})
	if two != "Removed 2 bindings scoped to api: A, B" {
		t.Errorf("two: %q", two)
	}
}
