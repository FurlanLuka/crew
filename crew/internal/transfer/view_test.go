package transfer

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

var ansi = regexp.MustCompile(`\x1b\[[0-9;]*m`)

func plain(s string) string { return ansi.ReplaceAllString(s, "") }

func TestExportView_UncoveredWorkspaceDimsInPlace(t *testing.T) {
	v := NewExportView("")
	m, _ := v.Update(exportLoadedMsg{
		projects: []project.Project{
			{Name: "store-api", DevServers: []project.DevServer{{Name: "store-api", Port: 3000}}, Bindings: []project.Binding{{Var: "A"}, {Var: "B"}}},
			{Name: "admin", DevServers: []project.DevServer{{Name: "a"}, {Name: "b"}}, Setup: "make sync", EnvCmd: "make get-env"},
		},
		workspaces: []*workspace.Workspace{
			{Name: "store-front", Projects: []workspace.WorkspaceProject{{Name: "store-api"}}},
			{Name: "admin", Projects: []workspace.WorkspaceProject{{Name: "admin"}}},
		},
	})
	v = m.(ExportView)

	// Untick admin: its workspace stays on the row, dimmed, naming what it needs.
	v.cursor = 1
	v.toggleCursor()
	got := plain(v.View())
	want := strings.Join([]string{
		"  Export to crew-export.json",
		"",
		"  Projects",
		"  ✓ store-api    1 server  2 bindings",
		"> ○ admin        2 servers  setup: make sync  env: make get-env",
		"",
		"  Workspaces     only those whose projects are all ticked",
		"  ✓ store-front  store-api",
		"  · admin        needs admin",
		"",
		"  space toggle  a all/none  f file  enter export 1 project, 1 workspace  esc cancel",
		"",
	}, "\n")
	if got != want {
		t.Errorf("picker =\n%s\nwant\n%s", got, want)
	}

	// space on the dimmed row does nothing; a on the workspace section only touches workspaces.
	v.cursor = 3
	v.toggleCursor()
	projNames, wsNames := v.selection()
	if strings.Join(projNames, ",") != "store-api" || strings.Join(wsNames, ",") != "store-front" {
		t.Errorf("selection = %v / %v", projNames, wsNames)
	}
	v.toggleSection()
	if _, wsNames := v.selection(); len(wsNames) != 0 {
		t.Errorf("a on workspaces should untick them all, got %v", wsNames)
	}
	if !v.picked["store-api"] {
		t.Error("a on workspaces must not touch projects")
	}
}

func importFixture(t *testing.T) (ImportView, string) {
	t.Helper()
	tmp := setupTestConfig(t)
	here := filepath.Join(tmp, "dev", "store-api")
	os.MkdirAll(here, 0o755)
	os.MkdirAll(filepath.Join(tmp, "dev", "checkout-api"), 0o755)
	project.Add(project.Project{Name: "store-api", Path: here, Bindings: []project.Binding{{Var: "CHECKOUT_API_URL", Value: "{{checkout-api}}"}}})

	b := Bundle{Version: 1, Projects: []Exported{
		{Project: project.Project{Name: "store-api", Path: here,
			DevServers: []project.DevServer{{Name: "store-api", Port: 3000, Command: "npm start"}},
			Bindings:   []project.Binding{{Var: "CHECKOUT_API_URL", Value: "{{checkout-api}}"}, {Var: "CHECKOUT_API_ASR_URL", Value: "{{checkout-api}}"}},
			Setup:      "npm ci", EnvCmd: "npm run get-env"}},
		{Project: project.Project{Name: "checkout-api", Path: "/Users/other/checkout-api",
			DevServers: []project.DevServer{{Name: "checkout-api", Port: 8000}, {Name: "worker", Port: 8003}},
			Bindings:   []project.Binding{{Var: "STORE_API_URL", Value: "{{store-api}}"}}}, Remote: "git@x:ai.git"},
		{Project: project.Project{Name: "infra-ops", Path: "/Users/other/infra-ops"}, Remote: "git@x:gcp.git"},
	}, Workspaces: []Membership{{Name: "store-front", Projects: []workspace.WorkspaceProject{{Name: "store-api", Role: "api"}, {Name: "infra-ops", Role: "infra", Mode: workspace.ModeDirect}}}}}
	return NewImportView("/x/crew-export.json", b), tmp
}

func TestImportView_AlreadyHereCard(t *testing.T) {
	v, tmp := importFixture(t)
	got := plain(v.View())
	here := filepath.Join(tmp, "dev", "store-api")
	want := strings.Join([]string{
		"  Import crew-export.json · project 1 of 3",
		"",
		"  name      store-api                                  · already here",
		"  path      " + padTo(here, pathCol) + " ✓ exists",
		"  servers   store-api :3000  npm start",
		"  bindings  CHECKOUT_API_URL      {{checkout-api}}",
		"            CHECKOUT_API_ASR_URL  {{checkout-api}}",
		"            local has 1 binding: CHECKOUT_API_URL",
		"  setup     npm ci",
		"  env       npm run get-env",
		"",
		"  r replace local  n keep local  e edit  esc stop",
		"",
	}, "\n")
	if got != want {
		t.Errorf("card =\n%s\nwant\n%s", got, want)
	}
}

func TestImportView_SuggestionThenClone(t *testing.T) {
	v, tmp := importFixture(t)
	// Keep local on card 1 → anchors gain store-api's path → card 2 finds checkout-api beside it.
	m, _ := v.Update(keyRune("n"))
	v = m.(ImportView)
	got := plain(v.View())
	suggested := filepath.Join(tmp, "dev", "checkout-api")
	if !strings.Contains(got, "project 2 of 3") || !strings.Contains(got, "✗ not here") ||
		!strings.Contains(got, "→ "+suggested) || !strings.Contains(got, "found beside store-api — y uses this") ||
		!strings.Contains(got, "remote    git@x:ai.git") ||
		!strings.Contains(got, "y import with suggested path  c clone  e edit  n skip  esc stop") {
		t.Errorf("card 2 =\n%s", got)
	}

	// c must not clone onto the sibling y already offers: with no place to
	// put a fresh clone it asks for a path.
	m, cmd := v.Update(keyRune("c"))
	if ev := m.(ImportView); ev.state != importStateEdit || !ev.cloneAfterEdit || cmd == nil {
		t.Errorf("c on suggested card: state=%v cloneAfterEdit=%v", ev.state, ev.cloneAfterEdit)
	}

	// Skip it: card 3 has no sibling to find, so c clones beside the last anchor.
	m, _ = v.Update(keyRune("n"))
	v = m.(ImportView)
	got = plain(v.View())
	target := filepath.Join(tmp, "dev", "infra-ops")
	if !strings.Contains(got, "→ "+target) || !strings.Contains(got, "c clones here — beside store-api — or anywhere you type") ||
		!strings.Contains(got, "  c clone  e edit  n skip  esc stop") || strings.Contains(got, "y import") {
		t.Errorf("card 3 =\n%s", got)
	}
}

func TestImportView_WorkspaceBlockedThenSummary(t *testing.T) {
	v, _ := importFixture(t)
	for _, k := range []string{"n", "n", "n"} { // keep store-api, skip the other two
		m, _ := v.Update(keyRune(k))
		v = m.(ImportView)
	}
	got := plain(v.View())
	if !strings.Contains(got, "workspace 1 of 1") ||
		!strings.Contains(got, "store-api   api     worktree   already here") ||
		!strings.Contains(got, "infra-ops   infra   direct     skipped") ||
		!strings.Contains(got, "! needs infra-ops, which was not imported — n skips this workspace") ||
		!strings.Contains(got, "  n skip  esc stop") {
		t.Errorf("workspace card =\n%s", got)
	}

	m, _ := v.Update(keyRune("n"))
	v = m.(ImportView)
	got = plain(v.View())
	want := strings.Join([]string{
		"  Imported crew-export.json",
		"",
		"  Projects",
		"    store-api     kept local",
		"    checkout-api  skipped",
		"    infra-ops     skipped",
		"",
		"  Workspaces",
		"    store-front   skipped — needs infra-ops",
		"",
		"  Run crew import again to change a decision; imported items offer replace.",
		"  esc close",
		"",
	}, "\n")
	if got != want {
		t.Errorf("summary =\n%s\nwant\n%s", got, want)
	}
}

func TestImportView_EscStopsAndKeepsApplied(t *testing.T) {
	v, tmp := importFixture(t)
	v = press(t, v, "r") // replace store-api: applied at once
	if project.Get("store-api") == nil || len(project.Get("store-api").Bindings) != 2 {
		t.Fatal("replace should have landed before the next card")
	}
	v = press(t, v, "esc")
	got := plain(v.View())
	if !strings.Contains(got, "stopped at project 2 of 3") || !strings.Contains(got, "store-api     replaced") ||
		!strings.Contains(got, "checkout-api  not reached") || !strings.Contains(got, "store-front   not reached") {
		t.Errorf("summary =\n%s", got)
	}
	_ = tmp
}

func padTo(s string, w int) string {
	if len(s) >= w {
		return s
	}
	return s + strings.Repeat(" ", w-len(s))
}

func keyRune(r string) tea.KeyMsg { return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(r)} }
func keyEsc() tea.KeyMsg          { return tea.KeyMsg{Type: tea.KeyEsc} }

// press sends a key and runs whatever commands it produced, feeding their
// messages back until the view settles — the wizard applies through
// commands so the TUI never blocks, and tests want the settled state.
func press(t *testing.T, v ImportView, k string) ImportView {
	t.Helper()
	var msg tea.Msg = keyRune(k)
	if k == "esc" {
		msg = keyEsc()
	} else if k == "enter" {
		msg = tea.KeyMsg{Type: tea.KeyEnter}
	} else if k == "tab" {
		msg = tea.KeyMsg{Type: tea.KeyTab}
	}
	return settle(t, v, msg)
}

func settle(t *testing.T, v ImportView, msg tea.Msg) ImportView {
	t.Helper()
	m, cmd := v.Update(msg)
	v = m.(ImportView)
	for _, out := range runCmd(cmd) {
		v = settle(t, v, out)
	}
	return v
}

// runCmd executes a command tree and keeps only the wizard's own messages;
// spinner ticks and cursor blinks reschedule themselves forever.
func runCmd(cmd tea.Cmd) []tea.Msg {
	if cmd == nil {
		return nil
	}
	var out []tea.Msg
	switch msg := cmd().(type) {
	case tea.BatchMsg:
		// Bubbletea runs a batch concurrently; run every part and keep the
		// terminal messages, in order.
		results := make([][]tea.Msg, len(msg))
		var wg sync.WaitGroup
		for i, sub := range msg {
			wg.Add(1)
			go func() {
				defer wg.Done()
				results[i] = runCmd(sub)
			}()
		}
		wg.Wait()
		for _, r := range results {
			out = append(out, r...)
		}
	case projectDoneMsg, clonedMsg, wsStartedMsg, wsPollMsg:
		out = append(out, msg)
	}
	return out
}

func typeInto(t *testing.T, v ImportView, text string) ImportView {
	t.Helper()
	v.inputs[v.focus].SetValue(text)
	return v
}

func TestImportView_CloneAnchored(t *testing.T) {
	v, tmp := importFixture(t)
	remote, _ := repoWithOrigin(t, tmp, "infra-ops")
	v.bundle.Projects[2].Remote = remote
	v = press(t, v, "n") // store-api kept → anchor
	v = press(t, v, "n") // checkout-api skipped
	target := filepath.Join(tmp, "dev", "infra-ops")
	if got := v.cloneTarget(); got != target {
		t.Fatalf("cloneTarget = %q, want %q", got, target)
	}

	// c offers the guess in the path field; enter takes it as is.
	v = press(t, v, "c")
	if v.state != importStateEdit || v.focus != fieldPath || v.inputs[fieldPath].Value() != target {
		t.Fatalf("after c: state=%v path field=%q", v.state, v.inputs[fieldPath].Value())
	}
	if got := plain(v.View()); !strings.Contains(got, "· where to clone") || !strings.Contains(got, "→ clone lands here") ||
		!strings.Contains(got, "tab next  enter clone  esc back") {
		t.Errorf("clone prompt:\n%s", got)
	}
	m, cmd := v.Update(tea.KeyMsg{Type: tea.KeyEnter})
	v = m.(ImportView)
	if v.state != importStateCloning || !strings.Contains(plain(v.View()), "Cloning infra-ops → "+target) {
		t.Errorf("after enter: state=%v\n%s", v.state, plain(v.View()))
	}
	for _, msg := range runCmd(cmd) {
		v = settle(t, v, msg)
	}
	if v.state != importStateCard || !v.pathExists || v.current.Path != target {
		t.Fatalf("after clone: state=%v pathExists=%v path=%q", v.state, v.pathExists, v.current.Path)
	}
	if !strings.Contains(plain(v.View()), "  y import  ") {
		t.Errorf("card after clone:\n%s", plain(v.View()))
	}
	v = press(t, v, "y")
	if !strings.Contains(plain(v.View()), "workspace 1 of 1") {
		t.Fatalf("y after clone should advance:\n%s", plain(v.View()))
	}
	v = press(t, v, "n")
	if got := plain(v.View()); !strings.Contains(got, "infra-ops     imported (cloned)   → "+target) {
		t.Errorf("summary:\n%s", got)
	}
}

func TestImportView_ClonePickedPath(t *testing.T) {
	v, tmp := importFixture(t)
	remote, _ := repoWithOrigin(t, tmp, "infra-ops")
	v.bundle.Projects[2].Remote = remote
	v = press(t, v, "n")
	v = press(t, v, "n")
	v = press(t, v, "c")
	picked := filepath.Join(tmp, "elsewhere", "infra")
	v = typeInto(t, v, picked)
	v = press(t, v, "enter")
	if v.state != importStateCard || !v.pathExists || v.current.Path != picked {
		t.Fatalf("typed path: state=%v pathExists=%v path=%q", v.state, v.pathExists, v.current.Path)
	}
	if _, err := os.Stat(filepath.Join(picked, ".git")); err != nil {
		t.Error("no checkout at the picked path")
	}
}

func TestImportView_CloneErrorShowsInline(t *testing.T) {
	v, _ := importFixture(t)
	v.bundle.Projects[2].Remote = "/nowhere/missing.git"
	v = press(t, v, "n")
	v = press(t, v, "n")
	v = press(t, v, "c")
	v = press(t, v, "enter")
	if v.state != importStateCard || v.err == nil || !strings.Contains(plain(v.View()), "! git clone:") {
		t.Errorf("state=%v err=%v\n%s", v.state, v.err, plain(v.View()))
	}
	if !strings.Contains(plain(v.View()), "c clone  e edit  n skip  esc stop") {
		t.Error("keys should come back after a failed clone")
	}
}

func TestImportView_CloneWithoutAnchorAsksForPath(t *testing.T) {
	tmp := setupTestConfig(t)
	remote, _ := repoWithOrigin(t, tmp, "api")
	b := Bundle{Version: 1, Projects: []Exported{{Project: project.Project{Name: "api", Path: "/nowhere/api"}, Remote: remote}}}
	v := NewImportView("/x/b.json", b)
	if !strings.Contains(plain(v.View()), "✗ not here — c asks where to clone, e sets the path") {
		t.Fatalf("card:\n%s", plain(v.View()))
	}

	v = press(t, v, "c")
	if v.state != importStateEdit || !v.cloneAfterEdit || v.focus != fieldPath {
		t.Fatalf("c without anchor should open the path field: state=%v", v.state)
	}
	target := filepath.Join(tmp, "picked", "api")
	v = typeInto(t, v, target)
	v = press(t, v, "enter")
	if v.state != importStateCard || !v.pathExists || v.current.Path != target {
		t.Errorf("enter should clone there: state=%v pathExists=%v path=%q", v.state, v.pathExists, v.current.Path)
	}
	if _, err := os.Stat(filepath.Join(target, ".git")); err != nil {
		t.Error("no checkout at the typed path")
	}
}

func TestImportView_RenameWarnsAboutReferences(t *testing.T) {
	v, _ := importFixture(t)
	v = press(t, v, "n") // to checkout-api, which store-api's bindings point at
	v = press(t, v, "e")
	v.focus = fieldName
	v = typeInto(t, v, "tutor")
	v = press(t, v, "enter")
	want := "store-api's CHECKOUT_API_ASR_URL, store-api's CHECKOUT_API_URL point at checkout-api — left alone until re-bound"
	if v.warn != want {
		t.Errorf("warn = %q, want %q", v.warn, want)
	}
	if !strings.Contains(plain(v.View()), "! "+want) {
		t.Error("warning should render on the card")
	}
}

func TestImportView_ReplaceAfterRename(t *testing.T) {
	v, _ := importFixture(t)
	v = press(t, v, "e")
	v.focus = fieldName
	v = typeInto(t, v, "store-api2")
	v = press(t, v, "enter")
	if !strings.Contains(plain(v.View()), "r replace local") {
		t.Fatalf("card after rename:\n%s", plain(v.View()))
	}
	v = press(t, v, "r")
	if project.Get("store-api") != nil || project.Get("store-api2") == nil {
		t.Fatal("replace should swap the original record for the renamed one")
	}
	if !v.present["store-api2"] || v.present["store-api"] {
		t.Errorf("present = %v", v.present)
	}
	for range 2 {
		v = press(t, v, "n")
	}
	v = press(t, v, "n")
	if got := plain(v.View()); !strings.Contains(got, "store-api     replaced") {
		t.Errorf("summary:\n%s", got)
	}
}

func TestImportView_WorkspaceCreate(t *testing.T) {
	tmp := setupTestConfig(t)
	api := filepath.Join(tmp, "repos", "api")
	initRepo(t, api)
	b := Bundle{Version: 1,
		Projects:   []Exported{{Project: project.Project{Name: "api", Path: api}}},
		Workspaces: []Membership{{Name: "ws", Projects: []workspace.WorkspaceProject{{Name: "api", Role: "backend"}}}}}
	v := NewImportView("/x/b.json", b)
	v = press(t, v, "y")
	// The card opens on its base table (fetched in the background) and the
	// same keys crew add worktree offers.
	if got := plain(v.View()); !strings.Contains(got, "y create  ctrl+p pull first  n skip  esc stop") || !strings.Contains(got, "checking the base branches") {
		t.Fatalf("workspace card:\n%s", plain(v.View()))
	}
	m0, _ := v.Update(wsBasesMsg{name: "ws", statuses: workspace.BaseStatuses(b.Workspaces[0].Workspace())})
	v = m0.(ImportView)
	if got := plain(v.View()); !strings.Contains(got, "Branching from") || !strings.Contains(got, "api") {
		t.Fatalf("base table:\n%s", got)
	}

	m, cmd := v.Update(keyRune("y"))
	v = m.(ImportView)
	if v.state != importStateCreating {
		t.Fatalf("state = %v", v.state)
	}
	if !strings.Contains(plain(v.View()), "creating ws — reserving ports") {
		t.Errorf("creating card:\n%s", plain(v.View()))
	}
	// Drain: the runners run inline here, so the first poll already finds
	// them done and the card advances to the summary.
	var sawPoll bool
	var drain func(tea.Cmd)
	drain = func(c tea.Cmd) {
		for _, msg := range runCmd(c) {
			if _, ok := msg.(wsPollMsg); ok {
				sawPoll = true
			}
			m, next := v.Update(msg)
			v = m.(ImportView)
			drain(next)
		}
	}
	drain(cmd)
	if !sawPoll {
		t.Error("the card should poll the runners")
	}
	if v.wsRes[0].Outcome != outcomeCreated || !strings.HasPrefix(v.wsRes[0].Detail, "1 checkout under ") {
		t.Errorf("wsRes = %+v", v.wsRes[0])
	}
	ref := workspace.Ref{Workspace: "ws", Worktree: workspace.DefaultWorktree}
	if _, err := os.Stat(filepath.Join(workspace.WorktreePath(ref, "api"), ".git")); err != nil {
		t.Error("checkout should exist")
	}
	if !strings.Contains(plain(v.View()), "crew launch ws") {
		t.Errorf("summary:\n%s", plain(v.View()))
	}
}

func TestExportView_FileAndSectionToggle(t *testing.T) {
	v := NewExportView("")
	m, _ := v.Update(exportLoadedMsg{
		projects:   []project.Project{{Name: "a"}, {Name: "b"}},
		workspaces: []*workspace.Workspace{{Name: "ws", Projects: []workspace.WorkspaceProject{{Name: "a"}, {Name: "b"}}}},
	})
	v = m.(ExportView)

	// f edits the file; esc leaves it; enter takes it; blank keeps the old one.
	m, _ = v.Update(keyRune("f"))
	v = m.(ExportView)
	if v.state != exportStateFile || v.fileInput.Value() != "crew-export.json" {
		t.Fatalf("f: state=%v value=%q", v.state, v.fileInput.Value())
	}
	v.fileInput.SetValue("other.json")
	m, _ = v.Update(keyEsc())
	v = m.(ExportView)
	if v.file != "crew-export.json" || v.state != exportStateList {
		t.Errorf("esc should discard: file=%q", v.file)
	}
	m, _ = v.Update(keyRune("f"))
	v = m.(ExportView)
	v.fileInput.SetValue("  ")
	m, _ = v.Update(tea.KeyMsg{Type: tea.KeyEnter})
	v = m.(ExportView)
	if v.file != "crew-export.json" {
		t.Errorf("blank enter should keep the file: %q", v.file)
	}
	m, _ = v.Update(keyRune("f"))
	v = m.(ExportView)
	v.fileInput.SetValue("~/Desktop/x.json")
	m, _ = v.Update(tea.KeyMsg{Type: tea.KeyEnter})
	v = m.(ExportView)
	if v.file != "~/Desktop/x.json" || !strings.Contains(plain(v.View()), "Export to ~/Desktop/x.json") {
		t.Errorf("enter should take the file: %q", v.file)
	}

	// a on the projects section: mixed → all on; all on → all off; workspaces untouched directly.
	v.cursor = 0
	v.toggleCursor()
	m, _ = v.Update(keyRune("a"))
	v = m.(ExportView)
	if !v.picked["a"] || !v.picked["b"] {
		t.Errorf("mixed + a should tick all: %v", v.picked)
	}
	m, _ = v.Update(keyRune("a"))
	v = m.(ExportView)
	if v.picked["a"] || v.picked["b"] || !v.wsPicked["ws"] {
		t.Errorf("all + a should untick all projects only: %v / %v", v.picked, v.wsPicked)
	}
	if got := plain(v.View()); !strings.Contains(got, "· ws  needs a, b") {
		t.Errorf("workspace should dim when uncovered:\n%s", got)
	}
}

func TestImportView_WorkspaceCardBasesAndPull(t *testing.T) {
	tmp := setupTestConfig(t)
	api := filepath.Join(tmp, "repos", "api")
	initRepo(t, api)
	b := Bundle{Version: 1,
		Projects:   []Exported{{Project: project.Project{Name: "api", Path: api}}},
		Workspaces: []Membership{{Name: "ws", Projects: []workspace.WorkspaceProject{{Name: "api", Role: "backend"}}}}}
	v := NewImportView("/x/b.json", b)
	v = press(t, v, "y") // api imported → workspace card

	// A table for another card is dropped; the right one shows, with the
	// stale warning and the pull hint.
	m, _ := v.Update(wsBasesMsg{name: "other", statuses: []workspace.BaseStatus{{Project: "x", Base: "main"}}})
	v = m.(ImportView)
	if v.bases != nil {
		t.Fatal("a table for another card must be ignored")
	}
	m, _ = v.Update(wsBasesMsg{name: "ws", statuses: []workspace.BaseStatus{{Project: "api", Base: "main", Behind: 2}}})
	v = m.(ImportView)
	if got := plain(v.View()); !strings.Contains(got, "2 behind origin/main") || !strings.Contains(got, "ctrl+p pulls the latest") {
		t.Errorf("stale card:\n%s", got)
	}

	// ctrl+p: pulling, y ignored meanwhile, then the table comes back
	// with the pull's error shown.
	m, cmd := v.Update(tea.KeyMsg{Type: tea.KeyCtrlP})
	v = m.(ImportView)
	if !v.pulling || cmd == nil || !strings.Contains(plain(v.View()), "pulling the latest") {
		t.Fatalf("after ctrl+p: pulling=%v\n%s", v.pulling, plain(v.View()))
	}
	m, _ = v.Update(keyRune("y"))
	v = m.(ImportView)
	if v.state == importStateCreating {
		t.Fatal("y must wait for the pull")
	}
	m, _ = v.Update(wsBasesMsg{name: "ws", statuses: []workspace.BaseStatus{{Project: "api", Base: "main"}}, pulled: []error{errors.New("api: not a fast-forward")}})
	v = m.(ImportView)
	if v.pulling || !strings.Contains(plain(v.View()), "! api: not a fast-forward") || !strings.Contains(plain(v.View()), "up to date") {
		t.Errorf("after pull:\n%s", plain(v.View()))
	}

	// While the runners go, the card shows their table and polls again; a
	// create that recorded issues says so and names the fix line.
	v.state = importStateCreating
	running := workspace.Status{Projects: []workspace.ProjectStatus{{Project: "api", State: workspace.StateRunning, Steps: []workspace.RunStep{{Name: "npm ci", Status: workspace.StepRunning}}}}}
	m, cmd = v.Update(wsPollMsg{name: "ws", status: running})
	v = m.(ImportView)
	if v.state != importStateCreating || cmd == nil || !strings.Contains(plain(v.View()), "▸ npm ci") {
		t.Errorf("polling card: state=%v cmd=%v\n%s", v.state, cmd != nil, plain(v.View()))
	}
	done := workspace.Status{Projects: []workspace.ProjectStatus{{Project: "api", State: workspace.StateFailed, Issues: []workspace.Issue{{Stage: workspace.StageInstall, Project: "api"}, {Stage: workspace.StageSmoke, Project: "api", Server: "api"}}}}}
	m, _ = v.Update(wsPollMsg{name: "ws", status: done})
	v = m.(ImportView)
	if r := v.wsRes[0]; r.Outcome != outcomeCreated || !strings.HasPrefix(r.Detail, "2 issues recorded — crew fix ws/main --print") {
		t.Errorf("wsRes = %+v", r)
	}
}

// The edit form carries the env command: shown, editable, saved on the card.
func TestImportView_EditEnvCmd(t *testing.T) {
	v, _ := importFixture(t)
	v = press(t, v, "e")
	if v.state != importStateEdit || !strings.Contains(plain(v.View()), "  env       ") || v.inputs[fieldEnvCmd].Value() != "npm run get-env" {
		t.Fatalf("edit form (field=%q):\n%s", v.inputs[fieldEnvCmd].Value(), plain(v.View()))
	}
	v.inputs[fieldEnvCmd].SetValue("make get-env")
	m, _ := v.Update(tea.KeyMsg{Type: tea.KeyEnter})
	v = m.(ImportView)
	if v.state != importStateCard || v.current.EnvCmd != "make get-env" {
		t.Errorf("after enter: state=%v env=%q", v.state, v.current.EnvCmd)
	}
	if got := plain(v.View()); !strings.Contains(got, "env       make get-env") {
		t.Errorf("card:\n%s", got)
	}
	v = press(t, v, "r")
	if got := project.Get("store-api"); got == nil || got.EnvCmd != "make get-env" {
		t.Errorf("imported project = %+v", got)
	}
}
