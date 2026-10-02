package workspace

import (
	"reflect"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/project"
)

func wiresPool() []project.Project {
	return []project.Project{
		{Name: "store-front", Path: "/repos/store-front", DevServers: []project.DevServer{{Name: "web", Port: 3000, Command: "next dev"}},
			Bindings: []project.Binding{{Var: "STORE_API_URL", Value: "{{store-api}}"}, {Var: "SIGNALS_URL", Value: "{{signals}}"}, {Var: "SELF", Value: "{{store-front}}"}, {Var: "WT", Value: "{{worktree}}"}, {Var: "OUT", Value: "{{nope}}"}, {Var: "BAD", Value: "{{store-api."}}},
		{Name: "store-api", Path: "/repos/store-api", DevServers: []project.DevServer{{Name: "api", Port: 4000, Command: "make dev"}, {Name: "worker", Command: "make worker"}},
			Bindings: []project.Binding{{Var: "SIGNALS_URL", Value: "{{signals/api}}"}, {Var: "SIGNALS_HOST", Value: "{{signals.host}}"}}},
		{Name: "signals", Path: "/repos/signals"},
		{Name: "infra-ops", Path: "/repos/infra-ops"},
	}
}

func TestBindingWires(t *testing.T) {
	pool := wiresPool()
	got := BindingWires(pool, map[string]bool{"store-front": true, "store-api": true}, map[string]bool{"signals": true})
	want := []BindingWire{
		{Var: "STORE_API_URL", From: "store-front", To: "store-api", OK: true},
		{Var: "SIGNALS_URL", From: "store-front", To: "signals", OK: true}, // a member counts
		{Var: "SIGNALS_URL", From: "store-api", To: "signals", OK: true},
		{Var: "SIGNALS_HOST", From: "store-api", To: "signals", OK: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("wires =\n%+v\nwant\n%+v", got, want)
	}
	// Not picked, not a member: the wire is missing.
	got = BindingWires(pool, map[string]bool{"store-front": true}, nil)
	if len(got) != 2 || got[1].OK || got[1].To != "signals" {
		t.Errorf("unpicked target: %+v", got)
	}
	if got := BindingWires(pool, map[string]bool{"signals": true}, nil); len(got) != 0 || got == nil {
		t.Errorf("no bindings, an empty list (never null): %#v", got)
	}
}

func TestMemberWires(t *testing.T) {
	ws := &Workspace{Name: "store-front", Projects: []WorkspaceProject{{Name: "store-front"}, {Name: "signals"}}}
	got := MemberWires(wiresPool(), ws)
	want := []BindingWire{
		{Var: "STORE_API_URL", From: "store-front", To: "store-api", OK: false},
		{Var: "SIGNALS_URL", From: "store-front", To: "signals", OK: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("wires =\n%+v\nwant\n%+v", got, want)
	}
}
