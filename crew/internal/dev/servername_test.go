package dev

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

var twoWebs = []DevProject{
	{Name: "store-api", DevServers: []DevServerConfig{{Name: "web"}, {Name: "worker"}}},
	{Name: "store-front", DevServers: []DevServerConfig{{Name: "web"}}},
	{Name: "admin", DevServers: []DevServerConfig{{Name: "panel"}}},
}

func TestResolveServerName(t *testing.T) {
	cases := []struct {
		arg     string
		want    ProjectServer
		wantErr string
	}{
		{"panel", ProjectServer{"admin", "panel"}, ""},
		{"worker", ProjectServer{"store-api", "worker"}, ""},
		{"store-front/web", ProjectServer{"store-front", "web"}, ""},
		{"store-api/web", ProjectServer{"store-api", "web"}, ""},
		{"web", ProjectServer{}, `"web" is a server in 2 projects — name one: store-api/web, store-front/web`},
		{"nope", ProjectServer{}, `no dev server "nope" in this worktree (servers: store-api/web, store-api/worker, store-front/web, admin/panel)`},
		{"admin/web", ProjectServer{}, `project 'admin' has no dev server 'web' (has: panel)`},
		{"ghost/web", ProjectServer{}, `no project "ghost" in this worktree`},
		{"store-api/", ProjectServer{}, `expected <server> or <project>/<server>`},
	}
	for _, c := range cases {
		got, err := ResolveServerName(twoWebs, c.arg)
		if c.wantErr != "" {
			if err == nil || !strings.HasPrefix(err.Error(), c.wantErr) {
				t.Errorf("%q: err = %v, want prefix %q", c.arg, err, c.wantErr)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("%q = %+v, %v; want %+v", c.arg, got, err, c.want)
		}
	}
}

// A route file from before 6.6 has no Window: its session named windows,
// and its servers logs, by server alone.
func TestRouteWindowAndLog_PreAndPost66(t *testing.T) {
	setupTestConfig(t)
	slug := Slug("store--wt1")
	current := Route{Project: "store-api", ServerName: "web", Window: DevWindow(slug, "store-api", "web")}
	legacy := Route{Project: "store-api", ServerName: "web"}

	if got := RouteWindow(slug, current); got != "store--wt1/store-api/web" {
		t.Errorf("current window = %q", got)
	}
	if got := RouteWindow(slug, legacy); got != "store--wt1/web" {
		t.Errorf("legacy window = %q", got)
	}
	if got := filepath.Base(RouteLogFile(slug, current)); got != "store-api-web.log" {
		t.Errorf("current log = %q", got)
	}
	if got := filepath.Base(RouteLogFile(slug, legacy)); got != "web.log" {
		t.Errorf("legacy log = %q", got)
	}
}

func TestExistingLogFile_FallsBackToTheLegacyFile(t *testing.T) {
	setupTestConfig(t)
	slug := Slug("store--wt1")
	os.MkdirAll(LogDir(slug), 0o755)

	if got := filepath.Base(ExistingLogFile(slug, "store-api", "web")); got != "store-api-web.log" {
		t.Errorf("neither exists → %q, want its own path", got)
	}
	os.WriteFile(filepath.Join(LogDir(slug), "web.log"), []byte("old\n"), 0o644)
	if got := filepath.Base(ExistingLogFile(slug, "store-api", "web")); got != "web.log" {
		t.Errorf("only legacy → %q", got)
	}
	os.WriteFile(LogFile(slug, "store-api", "web"), []byte("new\n"), 0o644)
	if got := filepath.Base(ExistingLogFile(slug, "store-api", "web")); got != "store-api-web.log" {
		t.Errorf("both → %q, want the current file", got)
	}
}

// The collision LogFileFor exists for: two projects' "web", each to its own
// file; a legacy route with no project falls back to the shared old name.
func TestLogFileFor_TwoWebs(t *testing.T) {
	setupTestConfig(t)
	slug := Slug("store--wt1")
	routes := []Route{
		{Project: "store-api", ServerName: "web", Window: DevWindow(slug, "store-api", "web")},
		{Project: "store-front", ServerName: "web", Window: DevWindow(slug, "store-front", "web")},
	}
	if got := filepath.Base(LogFileFor(slug, routes, ProjectServer{"store-front", "web"})); got != "store-front-web.log" {
		t.Errorf("store-front/web → %q", got)
	}
	if got := WindowFor(slug, routes, ProjectServer{"store-api", "web"}); got != "store--wt1/store-api/web" {
		t.Errorf("store-api/web window → %q", got)
	}
	legacy := []Route{{ServerName: "web"}}
	if got := filepath.Base(LogFileFor(slug, legacy, ProjectServer{"store-api", "web"})); got != "web.log" {
		t.Errorf("legacy → %q", got)
	}
	if got := WindowFor(slug, legacy, ProjectServer{"store-api", "web"}); got != "store--wt1/web" {
		t.Errorf("legacy window → %q", got)
	}
}

func TestLogFileFor_PrefersTheRunningRoute(t *testing.T) {
	setupTestConfig(t)
	slug := Slug("store--wt1")
	routes := []Route{{Project: "store-front", ServerName: "web"}}
	target := ProjectServer{Project: "store-front", Server: "web"}
	if got := filepath.Base(LogFileFor(slug, routes, target)); got != "web.log" {
		t.Errorf("legacy running route → %q", got)
	}
	other := ProjectServer{Project: "store-api", Server: "web"}
	if got := filepath.Base(LogFileFor(slug, routes, other)); got != "store-api-web.log" {
		t.Errorf("not running → %q", got)
	}
}

// Two projects each running "web" used to share one window name and one
// log file; now each has its own, and the routes file says which.
func TestStart_TwoProjectsShareAServerName(t *testing.T) {
	if !crewExec.HasTmux() {
		t.Skip("tmux not available")
	}
	setupTestConfig(t)
	slug := Slug("ws--twin")
	t.Cleanup(func() { crewExec.KillTmuxSession(SessionName(slug)) })

	_, err := Start(StartParams{
		Slug: slug, Workspace: "ws", Worktree: "twin", NoProxy: true,
		Projects: []DevProject{
			{Name: "api", Path: t.TempDir(), DevServers: []DevServerConfig{{Name: "web", Port: 3000, Command: "echo api-says; sleep 30"}}},
			{Name: "front", Path: t.TempDir(), DevServers: []DevServerConfig{{Name: "web", Port: 3001, Command: "echo front-says; sleep 30"}}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	routes, _ := LoadRoutes(slug)
	if len(routes) != 2 || routes[0].Window != "ws--twin/api/web" || routes[1].Window != "ws--twin/front/web" {
		t.Fatalf("routes = %+v", routes)
	}
	wait := func(project, want string) {
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			data, _ := os.ReadFile(LogFile(slug, project, "web"))
			if strings.Contains(string(data), want+"\r\n") || strings.Contains(string(data), want+"\n") {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		data, _ := os.ReadFile(LogFile(slug, project, "web"))
		t.Fatalf("%s's log never showed %q:\n%s", project, want, data)
	}
	wait("api", "api-says")
	wait("front", "front-says")
	if !crewExec.TmuxPaneBusy(SessionName(slug), "ws--twin/api/web") || !crewExec.TmuxPaneBusy(SessionName(slug), "ws--twin/front/web") {
		t.Error("both windows should be running")
	}
}

func TestRouteFor(t *testing.T) {
	routes := []Route{
		{Project: "store-api", ServerName: "web", InternalPort: 1},
		{ServerName: "panel", InternalPort: 2},
	}
	if r, ok := RouteFor(routes, ProjectServer{"store-api", "web"}); !ok || r.InternalPort != 1 {
		t.Errorf("own project → %+v %v", r, ok)
	}
	if _, ok := RouteFor(routes, ProjectServer{"store-front", "web"}); ok {
		t.Error("a route with a project matches only that project")
	}
	if r, ok := RouteFor(routes, ProjectServer{"admin", "panel"}); !ok || r.InternalPort != 2 {
		t.Errorf("a pre-6.6 route with no project matches by server: %+v %v", r, ok)
	}
	if _, ok := RouteFor(routes, ProjectServer{"admin", "nope"}); ok {
		t.Error("no route → false")
	}
}
