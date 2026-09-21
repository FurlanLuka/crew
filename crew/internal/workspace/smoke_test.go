package workspace

import (
	"strings"
	"testing"

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
