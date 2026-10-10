package workspace

import (
	"fmt"
	"testing"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/dev"
)

func TestServerLines(t *testing.T) {
	start := time.Date(2026, 10, 2, 9, 0, 0, 0, time.UTC)
	projects := []dev.DevProject{
		{Name: "store-front", DevServers: []dev.DevServerConfig{{Name: "web", Port: 3000}}},
		{Name: "store-api", DevServers: []dev.DevServerConfig{{Name: "api", Port: 4000}, {Name: "worker"}, {Name: "docs", Port: 4100}}},
	}
	routes := []dev.Route{
		{Project: "store-front", ServerName: "web", InternalPort: 54010},
		{Project: "store-api", ServerName: "api", InternalPort: 54012},
		{Project: "store-api", ServerName: "worker"},
	}
	url := func(r dev.Route) string {
		if !r.Listens() {
			return ""
		}
		return fmt.Sprintf("http://localhost:%d", r.InternalPort)
	}
	checks := []SmokeResult{
		{Project: "store-front", Server: "web", Port: 54010, Alive: true, Referenced: true},
		{Project: "store-api", Server: "api", Port: 54012, Alive: false, Referenced: true, Tail: "Error: Cannot find module 'express'"},
		{Project: "store-api", Server: "worker", Alive: true},
	}
	params := ServerLinesParams{Projects: projects, Routes: routes, Checks: checks, Reserved: map[string]int{"store-api/docs": 54013}, StartedAt: start, Now: start.Add(5 * time.Second), URL: url}

	lines := ServerLines(params)
	want := []ServerLine{
		{Project: "store-front", Server: "web", Port: 54010, URL: "http://localhost:54010", State: ServerStarting},
		{Project: "store-api", Server: "api", Port: 54012, URL: "http://localhost:54012", State: ServerDied, Tail: "Error: Cannot find module 'express'"},
		{Project: "store-api", Server: "worker", Port: 0, URL: "", State: ServerQuiet},
		{Project: "store-api", Server: "docs", Port: 54013, State: ServerStopped},
	}
	if len(lines) != len(want) {
		t.Fatalf("lines = %+v", lines)
	}
	for i := range want {
		if lines[i] != want[i] {
			t.Errorf("line %d = %+v, want %+v", i, lines[i], want[i])
		}
	}

	// A pane whose shell has not taken the command reads as dead to one
	// look; for deadGrace that is a start, not a death.
	params.Now = start.Add(time.Second)
	if got := ServerLines(params)[1]; got.State != ServerStarting || got.Tail != "" {
		t.Errorf("dead one second after the start → %+v, want starting with no tail", got)
	}

	params.Now = start.Add(SmokeCeiling + time.Second)
	if got := ServerLines(params)[0]; got.State != ServerUnreached {
		t.Errorf("past the ceiling, a referenced server nobody answers is unreached, got %s", got.State)
	}
	params.Checks[0].Listening = true
	if got := ServerLines(params)[0]; got.State != ServerUp {
		t.Errorf("listening → up, got %s", got.State)
	}
}

// Nothing runs: `dev check` would print [], yet every declared server is a
// line, stopped, so a reader can offer to start them.
// A route the look has no verdict for (it raced the start) is not running
// as far as the reader knows.
func TestServerLines_RouteWithNoCheck(t *testing.T) {
	projects := []dev.DevProject{{Name: "store-front", DevServers: []dev.DevServerConfig{{Name: "web", Port: 3000}}}}
	lines := ServerLines(ServerLinesParams{Projects: projects, Routes: []dev.Route{{Project: "store-front", ServerName: "web", InternalPort: 54010}}})
	if lines[0].State != ServerStopped {
		t.Errorf("route with no check → %s", lines[0].State)
	}
}

func TestServerLines_NothingRuns(t *testing.T) {
	projects := []dev.DevProject{{Name: "store-front", DevServers: []dev.DevServerConfig{{Name: "web", Port: 3000}}}}
	lines := ServerLines(ServerLinesParams{Projects: projects, Reserved: map[string]int{"store-front/web": 54010}})
	if len(lines) != 1 || lines[0].State != ServerStopped || lines[0].Port != 54010 || lines[0].URL != "" {
		t.Errorf("lines = %+v", lines)
	}
	if got := ServerLines(ServerLinesParams{}); got == nil || len(got) != 0 {
		t.Errorf("no servers → %v, want an empty list, never null", got)
	}
}
