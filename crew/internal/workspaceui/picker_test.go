package workspaceui

import (
	"reflect"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/projectui"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

func pickerPool() []project.Project {
	return []project.Project{
		{Name: "store-front", Path: "/repos/store-front", DevServers: []project.DevServer{{Name: "web", Port: 3000, Command: "next dev"}},
			Bindings: []project.Binding{{Var: "STORE_API_URL", Value: "{{store-api}}"}, {Var: "SIGNALS_URL", Value: "{{signals}}"}, {Var: "SELF", Value: "{{store-front}}"}, {Var: "WT", Value: "{{worktree}}"}, {Var: "OUT", Value: "{{nope}}"}, {Var: "BAD", Value: "{{store-api."}}},
		{Name: "store-api", Path: "/repos/store-api", DevServers: []project.DevServer{{Name: "api", Port: 4000, Command: "make dev"}, {Name: "worker", Command: "make worker"}},
			Bindings: []project.Binding{{Var: "SIGNALS_URL", Value: "{{signals/api}}"}, {Var: "SIGNALS_HOST", Value: "{{signals.host}}"}}},
		{Name: "signals", Path: "/repos/signals"},
		{Name: "infra-ops", Path: "/repos/infra-ops"},
	}
}

func TestPickerRows(t *testing.T) {
	f := pickerFacts{Pool: pickerPool(), Exclude: map[string]bool{"signals": true}, Refusals: map[string]string{"infra-ops": "held by ops"}}
	got := pickerRows(f)
	want := []pickRow{
		{Name: "store-front", Mode: "worktree", Servers: "web :3000 next dev"},
		{Name: "store-api", Mode: "worktree", Servers: "api :4000 make dev, worker no port make worker"},
		{Name: "infra-ops", Mode: "worktree", Refusal: "held by ops", Servers: "no servers"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("pickerRows =\n%+v\nwant\n%+v", got, want)
	}
	if rows := pickerRows(pickerFacts{}); len(rows) != 0 {
		t.Errorf("empty pool: %+v", rows)
	}
	// The empty list says which kind of empty it is.
	var b strings.Builder
	p := newPicker("ws")
	p.reload(pickerFacts{})
	p.render(&b)
	if !strings.Contains(b.String(), "no projects yet — a clones or adopts one") {
		t.Errorf("empty pool copy:\n%s", b.String())
	}
	b.Reset()
	p.reload(pickerFacts{Pool: pickerPool(), Exclude: map[string]bool{"store-front": true, "store-api": true, "signals": true, "infra-ops": true}})
	p.render(&b)
	if !strings.Contains(b.String(), "every project in the pool is here already") {
		t.Errorf("all members copy:\n%s", b.String())
	}
}

func TestBindingLines(t *testing.T) {
	pool := pickerPool()
	got := bindingLines(pool, map[string]bool{"store-front": true, "store-api": true}, map[string]bool{"signals": true})
	want := []bindingLine{
		{Var: "STORE_API_URL", From: "store-front", To: "store-api", OK: true},
		{Var: "SIGNALS_URL", From: "store-front", To: "signals", OK: true}, // a member counts
		{Var: "SIGNALS_URL", From: "store-api", To: "signals", OK: true},
		{Var: "SIGNALS_HOST", From: "store-api", To: "signals", OK: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("lines =\n%+v\nwant\n%+v", got, want)
	}
	// Not ticked, not a member: the wire is missing.
	got = bindingLines(pool, map[string]bool{"store-front": true}, nil)
	if len(got) != 2 || got[1].OK || got[1].To != "signals" {
		t.Errorf("unticked target: %+v", got)
	}
	if got := bindingLines(pool, map[string]bool{"signals": true}, nil); len(got) != 0 {
		t.Errorf("no bindings, no lines: %+v", got)
	}
	// The card caps the list.
	many := make([]bindingLine, 5)
	for i := range many {
		many[i] = bindingLine{Var: "V", From: "a", To: "b", OK: true}
	}
	if out := plain(renderBindingLines(many)); strings.Count(out, "\n") != 4 || !strings.Contains(out, "+2 more") {
		t.Errorf("cap:\n%s", out)
	}
	if renderBindingLines(nil) != "" {
		t.Error("no lines renders nothing")
	}
}

func TestPicker_Keys(t *testing.T) {
	p := newPicker("feature-auth")
	p.reload(pickerFacts{Pool: pickerPool(), Refusals: map[string]string{"infra-ops": "project 'infra-ops' is already attached to workspace 'ops' in direct mode"}})
	if _, err := p.picked(); err == nil || !strings.Contains(err.Error(), "space ticks the row under the cursor") {
		t.Errorf("nothing ticked: %v", err)
	}
	step := func(k string) {
		var handled bool
		p, _, handled = p.handleKey(keyMsgOf(k))
		if !handled {
			t.Fatalf("%s not handled", k)
		}
	}
	step(" ")    // store-front
	step("down") // store-api
	step("m")    // direct
	step("down") // signals
	step("down") // infra-ops
	step("m")    // refused
	if p.err == nil || !strings.Contains(p.err.Error(), "workspace 'ops'") || p.rows[3].Mode != workspace.ModeWorktree {
		t.Errorf("m on a refused row: err=%v mode=%s", p.err, p.rows[3].Mode)
	}
	step(" ") // ticks infra-ops, clears the error
	if p.err != nil {
		t.Error("space clears the error")
	}
	want := []workspace.ProjectSpec{{Name: "store-front", Mode: "worktree"}, {Name: "infra-ops", Mode: "worktree"}}
	if got := p.specs(); !reflect.DeepEqual(got, want) {
		t.Errorf("specs = %+v", got)
	}
	step("up")
	step("up")
	step(" ") // store-api, now direct
	if got := p.specs(); len(got) != 3 || got[1] != (workspace.ProjectSpec{Name: "store-api", Mode: workspace.ModeDirect}) {
		t.Errorf("specs with a direct pick = %+v", got)
	}
	step("m") // back to worktree
	if p.rows[1].Mode != workspace.ModeWorktree {
		t.Error("m toggles back")
	}
	_, cmd, _ := p.handleKey(keyMsgOf("a"))
	if _, ok := pushedPage(runNav(cmd)).(projectui.Wizard); !ok {
		t.Error("a pushes the add-project wizard")
	}
	if _, _, handled := p.handleKey(keyMsgOf("enter")); handled {
		t.Error("enter is the host's")
	}
}

// A reload keeps ticks and modes by name; a name the picker never saw
// — added through a meanwhile — comes back ticked.
func TestPicker_ReloadTicksNewNames(t *testing.T) {
	p := newPicker("ws")
	pool := pickerPool()
	p.reload(pickerFacts{Pool: pool})
	if p.specs() != nil {
		t.Error("the first load ticks nothing")
	}
	p.rows[1].Ticked, p.rows[1].Mode = true, workspace.ModeDirect
	pool = append(pool, project.Project{Name: "checkout-api", Path: "/repos/checkout-api"})
	p.reload(pickerFacts{Pool: pool})
	got := p.specs()
	want := []workspace.ProjectSpec{{Name: "store-api", Mode: workspace.ModeDirect}, {Name: "checkout-api", Mode: "worktree"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("after reload = %+v, want %+v", got, want)
	}
	// A project that vanished drops out; the cursor stays on a row.
	p.cursor = 4
	p.reload(pickerFacts{Pool: pool[:2]})
	if len(p.rows) != 2 || p.cursor != 1 {
		t.Errorf("rows=%d cursor=%d", len(p.rows), p.cursor)
	}
}
