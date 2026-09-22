package workspace

import (
	"os"
	"path/filepath"
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
	got := waitForServers(routes, referenced, look, nil, smokeTiming{ceiling: 200 * time.Millisecond, tick: 10 * time.Millisecond})
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
	got := waitForServers(routes, map[string]bool{"api/api": true}, func(dev.Route) (bool, bool) { return true, true }, nil, smokeTiming{ceiling: 10 * time.Second, tick: time.Second})
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
	got := waitForServers(routes, map[string]bool{"slow/slow": true, "crash/crash": true, "never/never": true}, look, nil, smokeTiming{ceiling: time.Second, tick: 10 * time.Millisecond, grace: 100 * time.Millisecond})
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
	got := waitForServers(routes, map[string]bool{"api/api": true}, look, nil, smokeTiming{ceiling: 0, tick: time.Second})
	if looks != 1 || time.Since(start) > 200*time.Millisecond || got[0].State() != SmokeUnreached {
		t.Errorf("looks=%d took=%s state=%v", looks, time.Since(start), got[0].State())
	}
}

// A quiet pane — nothing in its log yet — is a shell still starting: it
// gets no verdict however long that takes, and its dead-grace runs from
// its first output. A pane whose log has content is judged as before.
func TestWaitForServers_QuietPaneIsStillStarting(t *testing.T) {
	routes := []dev.Route{
		{Project: "slow", ServerName: "slow", InternalPort: 1},
		{Project: "crash", ServerName: "crash", InternalPort: 2},
	}
	start := time.Now()
	quiet := func(r dev.Route) bool {
		// The slow shell prints nothing for 300 ms — three graces.
		return r.Project == "slow" && time.Since(start) < 300*time.Millisecond
	}
	look := func(r dev.Route) (bool, bool) {
		if r.Project == "slow" {
			// The prompt's precmd runs git at 150–250 ms (busy while still
			// quiet); busy for real from 350 ms, the command forked 50 ms
			// after the shell took it.
			since := time.Since(start)
			return (since > 150*time.Millisecond && since < 250*time.Millisecond) || since > 350*time.Millisecond, false
		}
		return false, false
	}
	got := waitForServers(routes, map[string]bool{}, look, quiet, smokeTiming{ceiling: time.Second, tick: 10 * time.Millisecond, grace: 100 * time.Millisecond})
	if got[0].State() != SmokeIdle {
		t.Errorf("slow: %v — a quiet pane must not be dead, whatever its shell ran meanwhile, and its grace starts when the shell took the command", got[0].State())
	}
	if got[1].State() != SmokeDied || got[1].TookMs > 500 {
		t.Errorf("crash: %v after %d ms — a pane with output and no process is dead after the grace", got[1].State(), got[1].TookMs)
	}
}

// The pty echoes the sent command before the shell is ready; the shell's
// own echo ends a second line. Fewer than two newlines: still starting.
func TestShellNotReady(t *testing.T) {
	dir := t.TempDir()
	write := func(content string) string {
		p := filepath.Join(dir, "log")
		os.WriteFile(p, []byte(content), 0o644)
		return p
	}
	for content, want := range map[string]bool{
		"":                       true,
		"PORT=3000 sleep 30\r\n": true,
		"PORT=3000 sleep 30\r\n\x1b[1m➜ api \x1b[K":                          true,
		"PORT=3000 sleep 30\r\n➜ api PORT=3000 sleep 30\r\r\n":               false,
		"PORT=3000 sh -c 'exit 1'\r\n➜ api PORT=3000 sh -c 'exit 1'\r\r\n➜ ": false,
	} {
		if got := shellNotReady(write(content)); got != want {
			t.Errorf("%q → %v, want %v", content, got, want)
		}
	}
	if shellNotReady(filepath.Join(dir, "missing")) {
		t.Error("no log at all is not a starting shell")
	}
}

// A pane quiet all the way — a shell that never took the command — is died,
// referenced or not, at the hard cap of twice the ceiling; on a single look
// (ceiling 0) it is died too, which the page's Settling window hides.
func TestWaitForServers_QuietPastTheCapIsDied(t *testing.T) {
	routes := []dev.Route{
		{Project: "ref", ServerName: "ref", InternalPort: 1},
		{Project: "idle", ServerName: "idle", InternalPort: 2},
	}
	never := func(dev.Route) (bool, bool) { return false, false }
	always := func(dev.Route) bool { return true }
	got := waitForServers(routes, map[string]bool{"ref/ref": true}, never, always, smokeTiming{ceiling: 50 * time.Millisecond, tick: 10 * time.Millisecond, grace: time.Second})
	for i, r := range got {
		if r.State() != SmokeDied || r.TookMs < 100 || r.TookMs > 300 {
			t.Errorf("%s: %v after %d ms, want died at twice the ceiling", routes[i].Project, r.State(), r.TookMs)
		}
	}
	got = waitForServers(routes[:1], map[string]bool{"ref/ref": true}, never, always, smokeTiming{ceiling: 0, tick: time.Second, grace: time.Second})
	if got[0].State() != SmokeDied {
		t.Errorf("one look at a quiet pane: %v", got[0].State())
	}
}

// A pane's log carries CSI colours, OSC cwd reports and screen's title
// sequence around a server's output; the evidence is the output alone.
func TestStripANSI(t *testing.T) {
	for in, want := range map[string]string{
		"\x1b[01;31mError\x1b[0m: x":        "Error: x",
		"\x1b]7;file://host/dir\x1b\\Ready": "Ready",
		"\x1bksh\x1b\\boom":                 "boom",
		"\x1b]0;title\x07plain":             "plain",
		"no escapes":                        "no escapes",
	} {
		if got := stripANSI(in); got != want {
			t.Errorf("%q → %q, want %q", in, got, want)
		}
	}
}

// The ceiling is a running server's time to listen: a shell that takes a
// while to start does not spend it. A referenced server whose shell is
// quiet for 200 ms gets its 100 ms ceiling after that, not before.
func TestWaitForServers_CeilingRunsFromReadiness(t *testing.T) {
	routes := []dev.Route{{Project: "ref", ServerName: "ref", InternalPort: 1}}
	start := time.Now()
	quiet := func(dev.Route) bool { return time.Since(start) < 150*time.Millisecond }
	look := func(dev.Route) (bool, bool) { return time.Since(start) >= 150*time.Millisecond, false }
	got := waitForServers(routes, map[string]bool{"ref/ref": true}, look, quiet, smokeTiming{ceiling: 100 * time.Millisecond, tick: 10 * time.Millisecond, grace: time.Second})
	if got[0].State() != SmokeUnreached || got[0].TookMs < 250 {
		t.Errorf("%v after %d ms — the ceiling should start when the shell took the command", got[0].State(), got[0].TookMs)
	}
}
