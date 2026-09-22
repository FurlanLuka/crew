package projectui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

func TestRenderTokenLegend_Golden(t *testing.T) {
	targets := []project.Project{
		{Name: "store-api", DevServers: []project.DevServer{{Name: "store-api", Port: 3000}}},
		{Name: "checkout-api", DevServers: []project.DevServer{{Name: "api", Port: 8000}, {Name: "worker", Port: 8001}}},
	}

	var b strings.Builder
	renderTokenLegend(&b, targets)
	got := plain(b.String())

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
	if got := plain(b.String()); !strings.Contains(got, "none with dev servers yet") {
		t.Errorf("legend without targets =\n%s", got)
	}
}

func TestDraftState(t *testing.T) {
	tests := []struct {
		name        string
		draft       project.Binding
		previewable bool
		wantErr     string
	}{
		{"empty", project.Binding{}, false, ""},
		{"var only", project.Binding{Var: "A"}, false, ""},
		{"value only", project.Binding{Value: "{{store-api}}"}, false, ""},
		{"invalid var", project.Binding{Var: "1A", Value: "{{store-api}}"}, false, ""},
		{"both", project.Binding{Var: "A", Value: "{{store-api}}"}, true, ""},
		{"malformed", project.Binding{Var: "A", Value: "{{store-api.foo}}"}, false, "a server is written"},
		{"malformed beats missing var", project.Binding{Value: "{{store-api.foo}}"}, false, "a server is written"},
	}
	for _, tt := range tests {
		previewable, err := draftState(tt.draft)
		if previewable != tt.previewable {
			t.Errorf("%s: previewable = %v, want %v", tt.name, previewable, tt.previewable)
		}
		if tt.wantErr == "" && err != nil {
			t.Errorf("%s: unexpected error %v", tt.name, err)
		}
		if tt.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tt.wantErr)) {
			t.Errorf("%s: err = %v, want %q", tt.name, err, tt.wantErr)
		}
	}
}

// completeVar finishes a name from the env files, skipping what is bound.
func TestCompleteVar(t *testing.T) {
	envKeys := []string{"API_URL", "APP_NAME", "DB_HOST"}
	declared := map[string]bool{"API_URL": true}
	for prefix, want := range map[string]string{
		"":    "",
		"ap":  "APP_NAME",
		"API": "", // API_URL is bound already, nothing else starts with API
		"DB":  "DB_HOST",
		"zz":  "",
	} {
		if got := completeVar(prefix, envKeys, declared); got != want {
			t.Errorf("completeVar(%q) = %q, want %q", prefix, got, want)
		}
	}
}

// The preview cell is the first resolved value, else the first reason.
func TestRenderPreviewInline(t *testing.T) {
	for name, tt := range map[string]struct {
		previews []workspace.BindingPreview
		want     string
	}{
		"none":     {nil, "→ no worktree to check against"},
		"resolved": {[]workspace.BindingPreview{{Ref: "ws/wrk1", Value: "http://localhost:1", Resolved: true, Running: true}}, "→ http://localhost:1  in ws/wrk1"},
		"stopped":  {[]workspace.BindingPreview{{Ref: "ws/wrk1", Value: "http://localhost:1", Resolved: true}}, "→ http://localhost:1  in ws/wrk1 · stopped"},
		"first resolved wins": {[]workspace.BindingPreview{
			{Ref: "ws/a", Detail: "no dev server"},
			{Ref: "ws/b", Value: "http://localhost:2", Resolved: true, Running: true},
		}, "→ http://localhost:2  in ws/b"},
		"left alone": {[]workspace.BindingPreview{{Ref: "ws/a", Detail: "store-api has no server db"}}, "→ left alone  store-api has no server db"},
	} {
		if got := plain(renderPreviewInline(tt.previews)); got != tt.want {
			t.Errorf("%s: %q, want %q", name, got, tt.want)
		}
	}
}

func editorKey(e bindingEditor, k tea.KeyType) bindingEditor {
	e, _ = e.Update(tea.KeyMsg{Type: k})
	return e
}

// A malformed token is one error and no preview; fixing it clears the
// error and, with no worktree on disk, falls back to the hint.
func TestRenderEdit_MalformedTokenShowsOneError(t *testing.T) {
	setupTestConfig(t)
	e := newBindingEditor(editorFacts{proj: "checkout-api"}, nil)
	e.varInput.SetValue("A")
	e.valueInput.SetValue("{{store-api.foo}}")
	e.syncDraft()
	got := plain(e.View())
	if strings.Count(got, "a server is written") != 1 {
		t.Errorf("want the parse error exactly once:\n%s", got)
	}
	if strings.Contains(got, "not in any worktree yet") || strings.Contains(got, "→") {
		t.Errorf("malformed draft must not preview:\n%s", got)
	}

	e.valueInput.SetValue("{{store-api}}")
	e.syncDraft()
	got = plain(e.View())
	if strings.Contains(got, "a server is written") || !strings.Contains(got, "not in any worktree yet") {
		t.Errorf("valid draft:\n%s", got)
	}
	// The grammar line is always there; the legend only on ctrl+t.
	if !strings.Contains(got, grammarLine) || strings.Contains(got, "  Tokens\n") {
		t.Errorf("grammar line without the legend:\n%s", got)
	}
	e, _ = e.Update(tea.KeyMsg{Type: tea.KeyCtrlT})
	if !strings.Contains(plain(e.View()), "  Tokens\n") {
		t.Error("ctrl+t shows the legend")
	}
}

// The scope field exists only when the project has two or more servers;
// ←/→ cycle all / each server, tab moves on to the value.
func TestRenderEdit_ScopeField(t *testing.T) {
	setupTestConfig(t)
	one := newBindingEditor(editorFacts{proj: "store-api", servers: []project.DevServer{{Name: "store-api"}}}, nil)
	one.setFocus(fieldVar)
	one = editorKey(one, tea.KeyTab)
	if one.focus != fieldValue {
		t.Errorf("one server: tab from var lands on value, got %d", one.focus)
	}
	if strings.Contains(one.View(), "\n  server ") {
		t.Errorf("one server: no scope field\n%s", one.View())
	}

	e := newBindingEditor(editorFacts{proj: "admin", servers: []project.DevServer{{Name: "backend"}, {Name: "homepage"}}}, nil)
	e.setFocus(fieldVar)
	e = editorKey(e, tea.KeyTab)
	if e.focus != fieldServer {
		t.Fatalf("two servers: tab from var lands on the scope, got %d", e.focus)
	}
	if got := plain(e.View()); !strings.Contains(got, "server ‹ all servers ›") {
		t.Errorf("scope field:\n%s", got)
	}
	e = editorKey(e, tea.KeyRight)
	if e.draft.Server != "backend" {
		t.Errorf("→ picks the first server, got %q", e.draft.Server)
	}
	e = editorKey(e, tea.KeyRight)
	if e.draft.Server != "homepage" {
		t.Errorf("→ again the second, got %q", e.draft.Server)
	}
	e = editorKey(e, tea.KeyRight)
	if e.draft.Server != "" {
		t.Errorf("→ wraps to all, got %q", e.draft.Server)
	}
	e = editorKey(e, tea.KeyLeft)
	if e.draft.Server != "homepage" {
		t.Errorf("← goes back, got %q", e.draft.Server)
	}
	if got := plain(e.View()); !strings.Contains(got, "server ‹ homepage ›") {
		t.Errorf("scope field shows the pick:\n%s", got)
	}
	e = editorKey(e, tea.KeyTab)
	if e.focus != fieldValue {
		t.Errorf("tab from the scope lands on value, got %d", e.focus)
	}
	e = editorKey(e, tea.KeyShiftTab)
	if e.focus != fieldServer {
		t.Errorf("shift+tab goes back to the scope, got %d", e.focus)
	}
	// A space on the value field types a space; on the scope it cycles.
	e = editorKey(e, tea.KeyTab)
	e, _ = e.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(" ")})
	if e.valueInput.Value() != " " {
		t.Errorf("space on the value field types: %q", e.valueInput.Value())
	}
}

// Editing a scoped binding opens on its scope; saving under a changed
// scope removes the old identity.
func TestEditScopedBinding(t *testing.T) {
	setupPool(t)
	project.AddBinding("admin", project.Binding{Var: "A", Value: "{{store-api}}", Server: "backend"})
	p := project.Get("admin")
	e := newBindingEditor(editorFacts{proj: "admin", servers: p.DevServers}, &p.Bindings[0])
	e.open()
	if e.draft.Server != "backend" || e.orig == nil || e.orig.Server != "backend" {
		t.Fatalf("opens on the scope: draft %+v orig %+v", e.draft, e.orig)
	}
	e.draft.Server = "homepage"
	if msg := e.saveDraft()(); msg != (savedMsg{sectionBindings, "A (homepage)"}) {
		t.Fatalf("save: %+v", msg)
	}
	if p := project.Get("admin"); len(p.Bindings) != 1 || p.Bindings[0].Server != "homepage" {
		t.Errorf("the old scope goes, the new one stays: %+v", p.Bindings)
	}
}

// The server form validates on enter; a rename re-scopes the bindings.
func TestServerForm(t *testing.T) {
	for name, tt := range map[string]struct {
		in   [4]string
		want project.DevServer
		err  string
	}{
		"ok":         {[4]string{"web", "3000", "pnpm dev", ""}, project.DevServer{Name: "web", Port: 3000, Command: "pnpm dev"}, ""},
		"dir":        {[4]string{" web ", "3000", "pnpm dev", "apps/web"}, project.DevServer{Name: "web", Port: 3000, Command: "pnpm dev", Dir: "apps/web"}, ""},
		"no port":    {[4]string{"worker", "", "pnpm worker", ""}, project.DevServer{Name: "worker", Command: "pnpm worker"}, ""},
		"no name":    {[4]string{"", "3000", "pnpm dev", ""}, project.DevServer{}, "name and command are required"},
		"no command": {[4]string{"web", "3000", "", ""}, project.DevServer{}, "name and command are required"},
		"bad port":   {[4]string{"web", "abc", "pnpm dev", ""}, project.DevServer{}, "invalid port number"},
		"zero port":  {[4]string{"web", "0", "pnpm dev", ""}, project.DevServer{}, "invalid port number"},
	} {
		got, err := parseServerForm(tt.in[0], tt.in[1], tt.in[2], tt.in[3])
		if tt.err != "" {
			if err == nil || err.Error() != tt.err {
				t.Errorf("%s: err = %v, want %q", name, err, tt.err)
			}
			continue
		}
		if err != nil || got != tt.want {
			t.Errorf("%s: %+v, %v", name, got, err)
		}
	}

	setupPool(t)
	project.AddBinding("admin", project.Binding{Var: "A", Value: "{{store-api}}", Server: "backend"})
	p := project.Get("admin")
	f := newServerForm("admin", &p.DevServers[0])
	f.inputs[serverName].SetValue("api")
	f, cmd := f.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if f.err != nil || cmd == nil {
		t.Fatalf("enter on a valid form saves: err=%v", f.err)
	}
	if msg := cmd(); msg != (savedMsg{sectionServers, "api"}) {
		t.Fatalf("save: %+v", msg)
	}
	p = project.Get("admin")
	if _, err := project.FindServer("admin", p.DevServers, "api"); err != nil || len(p.DevServers) != 2 || p.Bindings[0].Server != "api" {
		t.Errorf("a rename keeps the scoped binding: %+v %+v", p.DevServers, p.Bindings)
	}
	f = newServerForm("admin", nil)
	f.inputs[serverPort].SetValue("x")
	f, _ = f.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if f.err == nil || !strings.Contains(plain(f.View()), "name and command are required") {
		t.Errorf("the form says what is wrong:\n%s", plain(f.View()))
	}
}

// setupPool is the three-project pool the binding tests read: one server,
// two servers, none.
func setupPool(t *testing.T) {
	t.Helper()
	setupTestConfig(t)
	project.Add(project.Project{Name: "store-api", Path: "/p/store-api", DevServers: []project.DevServer{
		{Name: "store-api", Port: 3000, Command: "npm start"},
	}})
	project.Add(project.Project{Name: "admin", Path: "/p/admin", DevServers: []project.DevServer{
		{Name: "backend", Port: 3100, Command: "pnpm dev"},
		{Name: "homepage", Port: 3001, Command: "pnpm dev"},
	}})
	project.Add(project.Project{Name: "checkout-api", Path: "/p/checkout-api"})
}

// A preview for a key the draft has moved on from is dropped; tab on the
// var field completes from the env files.
func TestEditor_PreviewKeyAndTabCompletion(t *testing.T) {
	setupTestConfig(t)
	e := newBindingEditor(editorFacts{proj: "store-api", envKeys: []string{"SIGNALS_URL"}}, nil)
	e.open()
	for _, r := range "sig" {
		e, _ = e.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
	if got := plain(e.View()); !strings.Contains(got, "tab → SIGNALS_URL") {
		t.Errorf("the hint names the completion:\n%s", got)
	}
	e = editorKey(e, tea.KeyTab)
	if e.varInput.Value() != "SIGNALS_URL" || e.focus != fieldVar {
		t.Errorf("tab completes in place: %q focus=%d", e.varInput.Value(), e.focus)
	}
	e = editorKey(e, tea.KeyTab)
	if e.focus != fieldValue {
		t.Error("tab with nothing to complete moves on")
	}
	e.draft = project.Binding{Var: "SIGNALS_URL", Value: "{{signals}}"}
	e, _ = e.Update(bindingPreviewMsg{key: dev.BindingKey{Var: "OLD"}, previews: []workspace.BindingPreview{{Ref: "x"}}})
	if e.draftPreview != nil {
		t.Error("a stale preview is dropped")
	}
	e, _ = e.Update(bindingPreviewMsg{key: e.draft.Key(), previews: []workspace.BindingPreview{{Ref: "x"}}})
	if len(e.draftPreview) != 1 {
		t.Error("the draft's own preview lands")
	}
}
