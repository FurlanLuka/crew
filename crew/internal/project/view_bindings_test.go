package project

import (
	"regexp"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/dev"
)

var ansi = regexp.MustCompile(`\x1b\[[0-9;]*m`)

func TestRenderTokenLegend_Golden(t *testing.T) {
	targets := []Project{
		{Name: "store-api", DevServers: []DevServer{{Name: "store-api", Port: 3000}}},
		{Name: "checkout-api", DevServers: []DevServer{{Name: "api", Port: 8000}, {Name: "worker", Port: 8001}}},
	}

	var b strings.Builder
	renderTokenLegend(&b, targets)
	got := ansi.ReplaceAllString(b.String(), "")

	want := strings.Join([]string{
		"  Tokens",
		"    {{store-api}}                  http://localhost:54494   URL of its one server",
		"    {{store-api.host}}             localhost:54494          ws://{{store-api.host}}/rtc",
		"    {{store-api.port}}             54494",
		"    {{checkout-api/worker}}        http://localhost:54497   a named server",
		"    {{checkout-api/worker.port}}   54497                    .host / .port go after the server",
		"    {{worktree}}                   wrk1                     this worktree's name",
		"    {{workspace}}                  store-front              this workspace's name",
		"    Name the server only when the project has more than one. No tokens = used as-is.",
		"",
		"  Projects",
		"    store-api     store-api :3000",
		"    checkout-api  api :8000  worker :8001",
		"",
	}, "\n")

	if got != want {
		t.Errorf("legend =\n%s\nwant\n%s", got, want)
	}
}

func TestRenderTokenLegend_NoTargets(t *testing.T) {
	var b strings.Builder
	renderTokenLegend(&b, nil)
	got := ansi.ReplaceAllString(b.String(), "")
	if !strings.Contains(got, "none with dev servers yet") {
		t.Errorf("legend without targets =\n%s", got)
	}
}

func TestDraftState(t *testing.T) {
	tests := []struct {
		name        string
		draft       Binding
		previewable bool
		wantErr     string
	}{
		{name: "complete", draft: Binding{Var: "A", Value: "{{store-api}}"}, previewable: true},
		{name: "literal", draft: Binding{Var: "A", Value: "x"}, previewable: true},
		{name: "var not yet valid", draft: Binding{Var: "not-a-var", Value: "{{store-api}}"}},
		{name: "empty value", draft: Binding{Var: "A"}},
		{name: "malformed token", draft: Binding{Var: "A", Value: "{{store-api.foo}}"}, wantErr: "a server is written"},
		{name: "malformed token beats missing var", draft: Binding{Value: "{{}}"}, wantErr: "expected"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			previewable, err := draftState(tt.draft)
			if previewable != tt.previewable {
				t.Errorf("previewable = %v, want %v", previewable, tt.previewable)
			}
			if tt.wantErr == "" && err != nil {
				t.Errorf("err = %v, want nil", err)
			}
			if tt.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tt.wantErr)) {
				t.Errorf("err = %v, want it to mention %q", err, tt.wantErr)
			}
		})
	}
}

func TestCompleteVar(t *testing.T) {
	v := BindingsView{
		envKeys:  []string{"SIGNALS_AGENT_NAME", "SIGNALS_URL", "STORE_API_URL"},
		bindings: []Binding{{Var: "SIGNALS_AGENT_NAME", Value: "{{worktree}}"}},
	}
	tests := map[string]string{
		"":              "",
		"sig":           "SIGNALS_URL", // SIGNALS_AGENT_NAME is already bound
		"SIGNALS_U":     "SIGNALS_URL",
		"store":         "STORE_API_URL",
		"NOPE":          "",
		"STORE_API_URL": "STORE_API_URL",
	}
	for prefix, want := range tests {
		if got := v.completeVar(prefix); got != want {
			t.Errorf("completeVar(%q) = %q, want %q", prefix, got, want)
		}
	}
}

func TestRenderList_MarksLegacyForm(t *testing.T) {
	v := BindingsView{bindings: []Binding{
		{Var: "OLD", Value: "{{url:store-api}}"},
		{Var: "NEW", Value: "{{store-api}}"},
	}}
	var b strings.Builder
	v.renderList(&b)
	lines := strings.Split(ansi.ReplaceAllString(b.String(), ""), "\n")

	if !strings.Contains(lines[0], "OLD") || !strings.Contains(lines[0], "· old form") {
		t.Errorf("legacy row = %q, want the old-form marker", lines[0])
	}
	if strings.Contains(lines[1], "old form") {
		t.Errorf("modern row = %q, want no marker", lines[1])
	}
}

func TestRenderEdit_MalformedTokenShowsOneError(t *testing.T) {
	prev := Previewer
	Previewer = func(string, Binding) []BindingPreview { return nil }
	t.Cleanup(func() { Previewer = prev })

	v := NewBindingsView("checkout-api")
	v.editIdx = -1
	v.varInput.SetValue("A")
	v.valueInput.SetValue("{{store-api.foo}}")
	v.syncDraft()

	var b strings.Builder
	v.renderEdit(&b)
	got := ansi.ReplaceAllString(b.String(), "")

	if strings.Count(got, "a server is written") != 1 {
		t.Errorf("want the parse error exactly once:\n%s", got)
	}
	if strings.Contains(got, "not in any worktree yet") || strings.Contains(got, "→") {
		t.Errorf("malformed draft must not preview:\n%s", got)
	}

	// Fixing the token clears the error and falls back to the no-worktree hint.
	v.valueInput.SetValue("{{store-api}}")
	v.syncDraft()
	b.Reset()
	v.renderEdit(&b)
	got = ansi.ReplaceAllString(b.String(), "")
	if strings.Contains(got, "a server is written") || !strings.Contains(got, "not in any worktree yet") {
		t.Errorf("valid draft:\n%s", got)
	}
}

func press(v BindingsView, k string) BindingsView {
	m, _ := v.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)})
	return m.(BindingsView)
}

func pressKey(v BindingsView, k tea.KeyType) BindingsView {
	m, _ := v.Update(tea.KeyMsg{Type: k})
	return m.(BindingsView)
}

// A scoped row reads VAR (server), aligned by label, with its own preview —
// a project-wide binding on the same var is another row.
func TestRenderList_ScopedRowsLabelled(t *testing.T) {
	v := BindingsView{
		bindings: []Binding{{Var: "A", Value: "{{store-api}}"}, {Var: "A", Value: "{{admin/homepage}}", Server: "backend"}},
		previews: map[dev.BindingKey][]BindingPreview{
			{Var: "A"}:                    {{Ref: "ws/wrk1", Value: "http://localhost:1", Resolved: true, Running: true}},
			{Var: "A", Server: "backend"}: {{Ref: "ws/wrk1", Value: "http://localhost:2", Resolved: true, Running: true}},
		},
	}
	var b strings.Builder
	v.renderList(&b)
	lines := strings.Split(ansi.ReplaceAllString(b.String(), ""), "\n")
	if strings.Contains(lines[0], "(") || !strings.Contains(lines[0], "http://localhost:1") {
		t.Errorf("project-wide row = %q", lines[0])
	}
	if !strings.Contains(lines[1], "A (backend)") || !strings.Contains(lines[1], "http://localhost:2") {
		t.Errorf("scoped row = %q", lines[1])
	}
	v.cursor = 1
	v.state = bindingStateConfirmRemove
	if got := ansi.ReplaceAllString(v.View(), ""); !strings.Contains(got, "Remove binding 'A (backend)'?") {
		t.Errorf("confirm names the scope: %q", got)
	}
}

// The scope field exists only when the project has two or more servers;
// ←/→ cycle all / each server, tab moves on to the value.
func TestRenderEdit_ScopeField(t *testing.T) {
	prev := Previewer
	Previewer = nil
	t.Cleanup(func() { Previewer = prev })

	one := NewBindingsView("store-api")
	one.servers = []DevServer{{Name: "store-api"}}
	one.state = bindingStateEdit
	one.setFocus(fieldVar)
	one = pressKey(one, tea.KeyTab)
	if one.focus != fieldValue {
		t.Errorf("one server: tab from var lands on value, got %d", one.focus)
	}
	var b strings.Builder
	one.renderEdit(&b)
	if strings.Contains(b.String(), "\n  server ") {
		t.Errorf("one server: no scope field\n%s", b.String())
	}

	v := NewBindingsView("admin")
	v.servers = []DevServer{{Name: "backend"}, {Name: "homepage"}}
	v.state = bindingStateEdit
	v.setFocus(fieldVar)
	v = pressKey(v, tea.KeyTab)
	if v.focus != fieldServer {
		t.Fatalf("two servers: tab from var lands on the scope, got %d", v.focus)
	}
	b.Reset()
	v.renderEdit(&b)
	if got := ansi.ReplaceAllString(b.String(), ""); !strings.Contains(got, "server ‹ all servers ›") {
		t.Errorf("scope field:\n%s", got)
	}
	v = pressKey(v, tea.KeyRight)
	if v.draft.Server != "backend" {
		t.Errorf("→ picks the first server, got %q", v.draft.Server)
	}
	v = pressKey(v, tea.KeyRight)
	if v.draft.Server != "homepage" {
		t.Errorf("→ again the second, got %q", v.draft.Server)
	}
	v = pressKey(v, tea.KeyRight)
	if v.draft.Server != "" {
		t.Errorf("→ wraps to all, got %q", v.draft.Server)
	}
	v = pressKey(v, tea.KeyLeft)
	if v.draft.Server != "homepage" {
		t.Errorf("← goes back, got %q", v.draft.Server)
	}
	b.Reset()
	v.renderEdit(&b)
	if got := ansi.ReplaceAllString(b.String(), ""); !strings.Contains(got, "server ‹ homepage ›") {
		t.Errorf("scope field shows the pick:\n%s", got)
	}
	v = pressKey(v, tea.KeyTab)
	if v.focus != fieldValue {
		t.Errorf("tab from the scope lands on value, got %d", v.focus)
	}
	v = pressKey(v, tea.KeyShiftTab)
	if v.focus != fieldServer {
		t.Errorf("shift+tab goes back to the scope, got %d", v.focus)
	}
}

// Editing a scoped binding starts on its scope; saving under a changed
// scope removes the old identity.
func TestEditScopedBinding(t *testing.T) {
	setupPool(t)
	prev := Previewer
	Previewer = nil
	t.Cleanup(func() { Previewer = prev })
	AddBinding("admin", Binding{Var: "A", Value: "{{store-api}}", Server: "backend"})

	v := NewBindingsView("admin")
	v.bindings = Get("admin").Bindings
	v.servers = Get("admin").DevServers
	v = press(v, "e")
	if v.state != bindingStateEdit || v.draft.Server != "backend" {
		t.Fatalf("e on a scoped row: state %d, draft %+v", v.state, v.draft)
	}
	v.draft.Server = "homepage"
	cmd := v.saveDraft()
	if msg := cmd(); msg != (bindingSavedMsg{count: 1}) {
		t.Fatalf("save: %+v", msg)
	}
	p := Get("admin")
	if len(p.Bindings) != 1 || p.Bindings[0].Server != "homepage" {
		t.Errorf("the old scope goes, the new one stays: %+v", p.Bindings)
	}

	// d then y on the scoped row removes that identity alone.
	AddBinding("admin", Binding{Var: "A", Value: "{{store-api}}"})
	v.state = bindingStateList
	v.bindings = Get("admin").Bindings
	v.cursor = 0
	if v.bindings[0].Server != "homepage" {
		t.Fatalf("fixture order: %+v", v.bindings)
	}
	v = press(v, "d")
	m, cmd := v.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("y")})
	v = m.(BindingsView)
	if cmd == nil {
		t.Fatal("y should remove")
	}
	if msg := cmd(); msg != (bindingRemovedMsg{}) {
		t.Fatalf("remove: %+v", msg)
	}
	if p := Get("admin"); len(p.Bindings) != 1 || p.Bindings[0].Server != "" {
		t.Errorf("only the scoped identity goes: %+v", p.Bindings)
	}
	// A scan of the root counts only a project-wide binding as declared.
	v.bindings = []Binding{{Var: "A", Value: "x", Server: "homepage"}}
	if v.boundProjectWide()["A"] {
		t.Error("a var bound for one server is not project-wide bound")
	}
	if !v.declaredVars()["A"] {
		t.Error("but it is declared, for completion")
	}
}
