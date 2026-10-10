package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// The crew pane in a Claude session reads these, as the page reads the
// others: its tests load them from voiceos/testdata.

func goldenResolved() *workspace.Resolved {
	pool := goldenPool()
	ref := workspace.Ref{Workspace: "store-front", Worktree: "main"}
	return &workspace.Resolved{
		Ref:  ref,
		Slug: ref.Slug(),
		Dir:  "/w/store-front/main",
		Projects: []workspace.ResolvedProject{
			{Name: "store-front", Path: "/w/store-front/main/store-front", DevServers: pool[0].DevServers, Bindings: pool[0].Bindings},
			{Name: "store-api", Path: "/w/store-front/main/store-api", DevServers: pool[1].DevServers},
			{Name: "signals", Path: "/w/store-front/main/signals", DevServers: []project.DevServer{{Name: "rtc", Port: 5000, Command: "make rtc"}}},
		},
		Ports: map[string]int{"store-front/web": 54010, "store-api/api": 54012, "signals/rtc": 54014},
	}
}

func goldenURL(r dev.Route) string {
	if !r.Listens() {
		return ""
	}
	return fmt.Sprintf("http://localhost:%d", r.InternalPort)
}

func TestGoldenDevWatch(t *testing.T) {
	routes := []dev.Route{
		{Project: "store-front", ServerName: "web", ExternalPort: 3000, InternalPort: 54010, NoProxy: true, Window: "store-front--main/store-front/web"},
		{Project: "store-api", ServerName: "api", ExternalPort: 4000, InternalPort: 54012, NoProxy: true, Window: "store-front--main/store-api/api"},
		{Project: "store-api", ServerName: "worker", NoProxy: true, Window: "store-front--main/store-api/worker"},
	}
	checks := []workspace.SmokeResult{
		{Project: "store-front", Server: "web", Port: 54010, Alive: true, Listening: true, Referenced: true},
		{Project: "store-api", Server: "api", Port: 54012, Alive: false, Referenced: true, Tail: "Error: Cannot find module 'express'"},
		{Project: "store-api", Server: "worker", Alive: true},
	}
	running := goldenResolved()
	running.Health = &workspace.Health{At: goldenAt, Issues: []workspace.Issue{{Stage: workspace.StageSmoke, Project: "store-api", Server: "api", Reason: workspace.ReasonDied, Detail: "Error: Cannot find module 'express'"}}}
	checkGolden(t, "dev-watch-running.json", buildWatchDoc(watchInputs{
		Res: running, Routes: routes, RoutesAt: goldenAt, Checks: checks, Now: goldenAt.Add(90 * time.Second), URL: goldenURL,
	}))

	installing := workspace.Status{Projects: []workspace.ProjectStatus{
		{Project: "store-front", State: workspace.StateOK, At: goldenAt, TookMs: 42000, Steps: []workspace.RunStep{{Name: "checkout", Status: workspace.StepOK, TookMs: 1200}}},
		{Project: "store-api", State: workspace.StateRunning, At: goldenAt, Steps: []workspace.RunStep{
			{Name: "checkout", Status: workspace.StepOK, TookMs: 900},
			{Name: "pnpm install", Status: workspace.StepRunning, StartedAt: goldenAt},
		}},
	}}
	checkGolden(t, "dev-watch-stopped.json", buildWatchDoc(watchInputs{Res: goldenResolved(), Setup: installing, Now: goldenAt, URL: goldenURL}))
}

func TestGoldenWhich(t *testing.T) {
	checkGolden(t, "which.json", whichOutput{Ref: "store-front/main", Root: "/w/store-front/main", Project: "store-api"})
}

func TestGoldenDevRestart(t *testing.T) {
	checkGolden(t, "dev-restart.json", restartOutput{Ref: "store-front/main", Project: "store-api", Server: "api", Port: 54012})
}

func TestWatchLines(t *testing.T) {
	doc := watchDoc{
		Servers: []workspace.ServerLine{
			{Project: "store-front", Server: "web", URL: "http://localhost:54010", State: workspace.ServerUp},
			{Project: "store-api", Server: "worker", State: workspace.ServerQuiet},
		},
		Setup: watchSetupDoc{Running: true},
	}
	want := "store-front/web\tup\thttp://localhost:54010\nstore-api/worker\tquiet\t\nsetup\trunning\t\n"
	if got := watchLines(doc); got != want {
		t.Errorf("watchLines =\n%q\nwant\n%q", got, want)
	}
}

// The pane's test kit imports code only, never JSON, so the goldens it reads
// are carried into tests/goldens.ts — written from voiceos/testdata, and
// failing here when the two drift.
func TestGoldenPaneFixtures(t *testing.T) {
	var b strings.Builder
	b.WriteString("// Written by crew's Go tests (-update-golden) from voiceos/testdata. Do not edit.\n\n")
	testdata := filepath.Join("..", "voiceos", "testdata")
	for _, f := range []struct{ name, file string }{
		{"devWatchRunning", filepath.Join(testdata, "dev-watch-running.json")},
		{"devWatchStopped", filepath.Join(testdata, "dev-watch-stopped.json")},
		{"which", filepath.Join(testdata, "which.json")},
		{"crewArgv", filepath.Join("..", "tests", "crew-argv.json")},
	} {
		data, err := os.ReadFile(f.file)
		if err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(&b, "export const %s = %s\n", f.name, strings.TrimSpace(string(data)))
	}
	path := filepath.Join("..", "tests", "goldens.ts")
	if *updateGolden {
		if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil || string(want) != b.String() {
		t.Errorf("tests/goldens.ts is stale — run go test -run Golden -update-golden")
	}
}
