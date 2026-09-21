package workspace

import (
	"strings"
	"testing"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

func TestSmokeResult_State(t *testing.T) {
	for _, tt := range []struct {
		r      SmokeResult
		want   SmokeState
		failed bool
	}{
		{SmokeResult{Alive: false}, SmokeDied, true},
		{SmokeResult{Alive: true, Listening: true}, SmokeOK, false},
		{SmokeResult{Alive: true, Listening: false, Referenced: true}, SmokeUnreached, true},
		{SmokeResult{Alive: true, Listening: false, Referenced: false}, SmokeIdle, false}, // an unreferenced worker
	} {
		if got := tt.r.State(); got != tt.want || tt.r.Failed() != tt.failed {
			t.Errorf("%+v → state %v failed %v", tt.r, got, tt.r.Failed())
		}
	}
}

func TestSmokeNotesAndIssues(t *testing.T) {
	results := []SmokeResult{
		{Project: "api", Server: "api", Port: 54001, Alive: true, Listening: true},
		{Project: "api", Server: "worker", Port: 54002, Alive: true, Listening: false},
		{Project: "web", Server: "web", Port: 54003, Alive: true, Listening: false, Referenced: true, Evidence: "vite v5\nready"},
		{Project: "db", Server: "db", Port: 54004, Alive: false, Evidence: "no such file"},
	}
	notes := SmokeNotes(results)
	if len(notes) != 1 || notes[0] != "api/worker running, not listening on :54002 — nothing points at it" {
		t.Errorf("notes = %q", notes)
	}
	issues := smokeIssues(results)
	if len(issues) != 2 {
		t.Fatalf("issues = %+v", issues)
	}
	if issues[0].Reason != ReasonNotListening || issues[0].Summary() != "server not listening: web/web" ||
		!strings.HasPrefix(issues[0].Detail, "running but nothing listens on :54003\n") ||
		!strings.HasSuffix(issues[0].Detail, "ready") {
		t.Errorf("not-listening issue = %+v", issues[0])
	}
	if issues[1].Reason != ReasonDied || issues[1].Summary() != "server died: db/db" || issues[1].Detail != "no such file" {
		t.Errorf("died issue = %+v", issues[1])
	}
}

// Nothing wrong → no health, or the page would offer f on a healthy worktree.
func TestCheckHealth_NilWhenAllPass(t *testing.T) {
	if h := CheckHealth([]SmokeResult{{Alive: true, Listening: true}, {Alive: true, Listening: false}}); h != nil {
		t.Errorf("CheckHealth = %+v", h)
	}
}

func TestReferencedIn(t *testing.T) {
	pool := []project.Project{
		{Name: "api", DevServers: []project.DevServer{{Name: "api", Port: 3000}, {Name: "worker", Port: 3001}},
			Bindings: []project.Binding{{Var: "WEB_URL", Value: "{{web}}"}, {Var: "LK", Value: "ws://{{livekit/rtc.host}}/x"}, {Var: "BAD", Value: "{{nope}}"}}},
		{Name: "web", DevServers: []project.DevServer{{Name: "web", Port: 5173}},
			Bindings: []project.Binding{{Var: "API_URL", Value: "{{api/api}}"}, {Var: "AMBIG", Value: "{{api}}"}, {Var: "NAME", Value: "{{worktree}}"}}},
		{Name: "livekit", DevServers: []project.DevServer{{Name: "rtc", Port: 7880}, {Name: "ingress", Port: 7881}}},
	}
	got := referencedIn(pool)
	want := map[string]bool{"web/web": true, "livekit/rtc": true, "api/api": true}
	if len(got) != len(want) {
		t.Fatalf("referenced = %v, want %v", got, want)
	}
	for k := range want {
		if !got[k] {
			t.Errorf("missing %s in %v", k, got)
		}
	}
}

// The loop, pure over a scripted look: a listener passes the moment it
// answers, a dead pane fails at once, an unreferenced worker is done when
// alive, and only a referenced non-listener waits for the ceiling.
func TestWaitForServers(t *testing.T) {
	routes := []dev.Route{
		{Project: "api", ServerName: "api", InternalPort: 1},
		{Project: "web", ServerName: "web", InternalPort: 2},
		{Project: "w", ServerName: "worker", InternalPort: 3},
		{Project: "db", ServerName: "db", InternalPort: 4},
	}
	referenced := map[string]bool{"api/api": true, "web/web": true}
	calls := map[string]int{}
	look := func(r dev.Route) (bool, bool) {
		calls[r.ServerName]++
		switch r.ServerName {
		case "api": // listens on the third look
			return true, calls["api"] >= 3
		case "web": // never listens
			return true, false
		case "worker": // alive, never listens, nobody points at it
			return true, false
		default: // dead from the start
			return false, false
		}
	}
	start := time.Now()
	got := waitForServers(routes, referenced, look, smokeTiming{ceiling: 200 * time.Millisecond, tick: 10 * time.Millisecond})
	if took := time.Since(start); took < 200*time.Millisecond || took > time.Second {
		t.Errorf("loop ran %s; should end at the ceiling set by web", took)
	}
	states := map[string]SmokeState{}
	for _, r := range got {
		states[r.Server] = r.State()
	}
	if states["api"] != SmokeOK || states["web"] != SmokeUnreached || states["worker"] != SmokeIdle || states["db"] != SmokeDied {
		t.Errorf("states = %v", states)
	}
	if calls["api"] != 3 || calls["worker"] != 1 || calls["db"] != 1 {
		t.Errorf("decided servers must not be looked at again: %v", calls)
	}
	if calls["web"] < 10 {
		t.Errorf("web should have been polled through the ceiling: %d looks", calls["web"])
	}
	// Verdict times: early ones early, the ceiling one at the ceiling.
	for _, r := range got {
		switch r.Server {
		case "db", "worker":
			if r.TookMs > 50 {
				t.Errorf("%s decided late: %dms", r.Server, r.TookMs)
			}
		case "web":
			if r.TookMs < 200 {
				t.Errorf("web decided before the ceiling: %dms", r.TookMs)
			}
		}
	}
}

// Everything decided at once: no tick is slept.
func TestWaitForServers_AllDecidedReturnsAtOnce(t *testing.T) {
	routes := []dev.Route{{Project: "api", ServerName: "api", InternalPort: 1}}
	start := time.Now()
	got := waitForServers(routes, map[string]bool{"api/api": true}, func(dev.Route) (bool, bool) { return true, true }, smokeTiming{ceiling: 10 * time.Second, tick: time.Second})
	if time.Since(start) > 500*time.Millisecond || got[0].State() != SmokeOK {
		t.Errorf("took %s, state %v", time.Since(start), got[0].State())
	}
}

// A pane not yet busy right after a start is not dead until the grace has
// passed; one that was busy and is not any more is dead at once.
func TestWaitForServers_DeadGrace(t *testing.T) {
	routes := []dev.Route{
		{Project: "slow", ServerName: "slow", InternalPort: 1},
		{Project: "crash", ServerName: "crash", InternalPort: 2},
		{Project: "never", ServerName: "never", InternalPort: 3},
	}
	looks := map[string]int{}
	look := func(r dev.Route) (bool, bool) {
		looks[r.ServerName]++
		switch r.ServerName {
		case "slow": // shell still launching for two looks, then up and listening
			return looks["slow"] >= 3, looks["slow"] >= 3
		case "crash": // ran once, then gone
			return looks["crash"] == 1, false
		default: // never starts at all
			return false, false
		}
	}
	got := waitForServers(routes, map[string]bool{"slow/slow": true, "crash/crash": true, "never/never": true}, look, smokeTiming{ceiling: time.Second, tick: 10 * time.Millisecond, grace: 100 * time.Millisecond})
	states := map[string]SmokeState{}
	for _, r := range got {
		states[r.Server] = r.State()
	}
	if states["slow"] != SmokeOK || states["crash"] != SmokeDied || states["never"] != SmokeDied {
		t.Errorf("states = %v", states)
	}
	if looks["crash"] != 2 {
		t.Errorf("a pane seen busy then idle is dead on the next look, got %d looks", looks["crash"])
	}
	for _, r := range got {
		if r.Server == "never" && (r.TookMs < 100 || r.TookMs > 500) {
			t.Errorf("never should be dead right after the grace, took %dms", r.TookMs)
		}
	}
}

func TestHasVerdict(t *testing.T) {
	for _, tt := range []struct {
		alive, listening, referenced, seenAlive, withinGrace bool
		want                                                 bool
	}{
		{alive: true, listening: true, want: true},                       // listens
		{alive: false, seenAlive: true, want: true},                      // was up, gone
		{alive: false, seenAlive: false, withinGrace: true, want: false}, // not launched yet
		{alive: false, seenAlive: false, withinGrace: false, want: true}, // never came up
		{alive: true, listening: false, referenced: true, want: false},   // still starting
		{alive: true, listening: false, referenced: false, want: true},   // idle worker
	} {
		if got := hasVerdict(tt.alive, tt.listening, tt.referenced, tt.seenAlive, tt.withinGrace); got != tt.want {
			t.Errorf("%+v → %v", tt, got)
		}
	}
}

func TestWithoutStarting(t *testing.T) {
	ok := SmokeResult{Alive: true, Listening: true}
	starting := SmokeResult{Alive: true, Referenced: true}
	if got := withoutStarting([]SmokeResult{ok, starting}); len(got) != 1 || got[0] != ok {
		t.Errorf("one starting → %+v", got)
	}
	if got := withoutStarting([]SmokeResult{ok}); len(got) != 1 {
		t.Errorf("all decided → %+v", got)
	}
	if got := withoutStarting(nil); got != nil {
		t.Errorf("empty → %+v", got)
	}
}

// A zero ceiling is one look and no sleep — what CheckServers and every
// page refresh rely on.
func TestWaitForServers_ZeroCeilingIsOneLook(t *testing.T) {
	routes := []dev.Route{{Project: "api", ServerName: "api", InternalPort: 1}}
	looks := 0
	look := func(dev.Route) (bool, bool) { looks++; return true, false }
	start := time.Now()
	got := waitForServers(routes, map[string]bool{"api/api": true}, look, smokeTiming{ceiling: 0, tick: time.Second})
	if looks != 1 || time.Since(start) > 200*time.Millisecond || got[0].State() != SmokeUnreached {
		t.Errorf("looks=%d took=%s state=%v", looks, time.Since(start), got[0].State())
	}
}
