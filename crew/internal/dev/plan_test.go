package dev

import (
	"os"
	"testing"
)

func twoProjects() []DevProject {
	return []DevProject{
		{
			Name: "speak-api",
			Path: "/wt/speak-api",
			DevServers: []DevServerConfig{
				{Name: "api", Port: 3000, Command: "npm start"},
			},
		},
		{
			Name: "mumbo",
			Path: "/wt/mumbo",
			DevServers: []DevServerConfig{
				{Name: "api", Port: 3100, Command: "pnpm dev", Dir: "backend"},
				{Name: "homepage", Port: 3001, Command: "pnpm dev", Dir: "homepage"},
			},
		},
	}
}

func TestPlanServers_PairsPortsInOrder(t *testing.T) {
	planned := PlanServers(twoProjects(), []int{54001, 54002, 54003}, false)

	if len(planned) != 3 {
		t.Fatalf("planned %d servers, want 3", len(planned))
	}

	want := []struct {
		project  string
		server   string
		internal int
		external int
	}{
		{"speak-api", "api", 54001, 3000},
		{"mumbo", "api", 54002, 3100},
		{"mumbo", "homepage", 54003, 3001},
	}
	for i, w := range want {
		got := planned[i]
		if got.Project != w.project || got.Server.Name != w.server {
			t.Errorf("[%d] = %s/%s, want %s/%s", i, got.Project, got.Server.Name, w.project, w.server)
		}
		if got.Route.InternalPort != w.internal || got.Route.ExternalPort != w.external {
			t.Errorf("[%d] ports = (%d, %d), want (%d, %d)",
				i, got.Route.InternalPort, got.Route.ExternalPort, w.internal, w.external)
		}
	}
}

// Two projects in one worktree both exposing a server named "api" is legal —
// validServerName is enforced per-project. Without Route.Project the two are
// indistinguishable once they reach a route file.
func TestPlanServers_SameServerNameAcrossProjectsStaysDistinct(t *testing.T) {
	planned := PlanServers(twoProjects(), []int{54001, 54002, 54003}, false)

	var apis []PlannedServer
	for _, ps := range planned {
		if ps.Server.Name == "api" {
			apis = append(apis, ps)
		}
	}
	if len(apis) != 2 {
		t.Fatalf("found %d servers named api, want 2", len(apis))
	}
	if apis[0].Route.Project == apis[1].Route.Project {
		t.Fatalf("both api routes claim project %q", apis[0].Route.Project)
	}
	if apis[0].Route.InternalPort == apis[1].Route.InternalPort {
		t.Errorf("both api routes got port %d", apis[0].Route.InternalPort)
	}
}

// Ports are allocated whether or not the proxy runs. Binding to the
// configured port in no-proxy mode is how two worktrees could never run at
// once, and how a stale env pointing at :3000 reached another workspace.
func TestPlanServers_NoProxyStillAllocates(t *testing.T) {
	planned := PlanServers(twoProjects(), []int{54001, 54002, 54003}, true)

	for i, ps := range planned {
		if ps.Route.InternalPort != []int{54001, 54002, 54003}[i] {
			t.Errorf("%s/%s: bound %d, want the allocated port", ps.Project, ps.Server.Name, ps.Route.InternalPort)
		}
		if ps.Route.InternalPort == ps.Server.Port {
			t.Errorf("%s/%s: bound the configured port %d in no-proxy mode", ps.Project, ps.Server.Name, ps.Server.Port)
		}
		if ps.Route.ExternalPort != ps.Server.Port {
			t.Errorf("%s/%s: ExternalPort = %d, want the configured %d kept for reference", ps.Project, ps.Server.Name, ps.Route.ExternalPort, ps.Server.Port)
		}
		if !ps.Route.NoProxy {
			t.Errorf("%s/%s: NoProxy = false", ps.Project, ps.Server.Name)
		}
	}
}

func TestPlanServers_JoinsServerDir(t *testing.T) {
	planned := PlanServers(twoProjects(), []int{1, 2, 3}, false)

	if planned[0].Dir != "/wt/speak-api" {
		t.Errorf("empty Dir should stay at project root, got %q", planned[0].Dir)
	}
	if planned[1].Dir != "/wt/mumbo/backend" {
		t.Errorf("Dir = %q, want /wt/mumbo/backend", planned[1].Dir)
	}
	if planned[2].Dir != "/wt/mumbo/homepage" {
		t.Errorf("Dir = %q, want /wt/mumbo/homepage", planned[2].Dir)
	}
}

func TestPlanServers_NoServers(t *testing.T) {
	if planned := PlanServers(nil, nil, false); len(planned) != 0 {
		t.Errorf("planned %d servers for no projects", len(planned))
	}
}

func planned(command string, port int) PlannedServer {
	return PlannedServer{
		Project: "speak-api",
		Server:  DevServerConfig{Name: "api", Command: command},
		Route:   Route{Project: "speak-api", ServerName: "api", InternalPort: port},
	}
}

func TestServerCommand(t *testing.T) {
	tests := []struct {
		name    string
		command string
		port    int
		want    string
	}{
		{"plain command", "npm run start", 54021, "PORT=54021 npm run start"},
		{"expands $PORT", "uvicorn --port $PORT", 54021, "PORT=54021 uvicorn --port 54021"},
		{"expands every $PORT", "a $PORT b $PORT", 8000, "PORT=8000 a 8000 b 8000"},
		{"chained command", "cd worker && npm start", 3000, "PORT=3000 cd worker && npm start"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// No resolutions: the line must be byte-identical to what crew built
			// before bindings existed.
			if got := ServerCommand(planned(tt.command, tt.port), nil); got != tt.want {
				t.Errorf("ServerCommand = %q, want %q", got, tt.want)
			}
		})
	}
}

// The only place resolution reaches a process. Exports go first, so a chained
// configured command still sees them; unresolved variables are absent.
func TestServerCommand_PrefixesResolvedVars(t *testing.T) {
	got := ServerCommand(planned("npm run start", 54021), []Resolution{
		{Project: "speak-api", Var: "TUTOR_URL", Value: "http://localhost:54088", Source: SourceBinding},
		{Project: "speak-api", Var: "GONE", Source: SourceUnresolved},
		{Project: "speak-api", Var: "AGENT", Value: "wrk 2", Source: SourceOverride},
	})

	want := "export TUTOR_URL='http://localhost:54088'; export AGENT='wrk 2'; PORT=54021 npm run start"
	if got != want {
		t.Errorf("ServerCommand =\n%q\nwant\n%q", got, want)
	}
}

// Start keys the prefix by project; a server must not carry another
// project's variables.
func TestServerCommand_UsesOnlyThisProjectsResolutions(t *testing.T) {
	all := []Resolution{
		{Project: "speak-api", Var: "A", Value: "1", Source: SourceBinding},
		{Project: "mumbo", Var: "B", Value: "2", Source: SourceBinding},
	}
	byProject := GroupResolutions(all)

	got := ServerCommand(planned("npm start", 3000), byProject["speak-api"])
	if got != "export A='1'; PORT=3000 npm start" {
		t.Errorf("ServerCommand = %q, want only speak-api's vars", got)
	}
}

// A route file written before Route.Project existed must still load, with the
// project simply unknown rather than the read failing.
func TestLoadRoutes_LegacyFileWithoutProject(t *testing.T) {
	setupTestConfig(t)

	legacy := `[{"subdomain":"ws","server_name":"api","external_port":3000,"internal_port":54001}]`
	if err := os.WriteFile(RoutesFilePath("legacy"), []byte(legacy), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	routes, err := LoadRoutes("legacy")
	if err != nil {
		t.Fatalf("LoadRoutes: %v", err)
	}
	if len(routes) != 1 {
		t.Fatalf("got %d routes, want 1", len(routes))
	}
	if routes[0].Project != "" {
		t.Errorf("Project = %q, want empty for a legacy file", routes[0].Project)
	}
	if routes[0].ServerName != "api" || routes[0].InternalPort != 54001 {
		t.Errorf("route = %+v, want api on 54001", routes[0])
	}
}
