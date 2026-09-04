package transfer

import (
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
			{Name: "speak-api", DevServers: []project.DevServer{{Name: "speak-api", Port: 3000}}, Bindings: []project.Binding{{Var: "A"}, {Var: "B"}}},
			{Name: "mumbo", DevServers: []project.DevServer{{Name: "a"}, {Name: "b"}}, Setup: "make sync"},
		},
		workspaces: []*workspace.Workspace{
			{Name: "phone-speak", Projects: []workspace.WorkspaceProject{{Name: "speak-api"}}},
			{Name: "mumbo", Projects: []workspace.WorkspaceProject{{Name: "mumbo"}}},
		},
	})
	v = m.(ExportView)

	// Untick mumbo: its workspace stays on the row, dimmed, naming what it needs.
	v.cursor = 1
	v.toggleCursor()
	got := plain(v.View())
	want := strings.Join([]string{
		"  Export to crew-export.json",
		"",
		"  Projects",
		"  ✓ speak-api    1 server  2 bindings",
		"> ○ mumbo        2 servers  setup: make sync",
		"",
		"  Workspaces     only those whose projects are all ticked",
		"  ✓ phone-speak  speak-api",
		"  · mumbo        needs mumbo",
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
	if strings.Join(projNames, ",") != "speak-api" || strings.Join(wsNames, ",") != "phone-speak" {
		t.Errorf("selection = %v / %v", projNames, wsNames)
	}
	v.toggleSection()
	if _, wsNames := v.selection(); len(wsNames) != 0 {
		t.Errorf("a on workspaces should untick them all, got %v", wsNames)
	}
	if !v.picked["speak-api"] {
		t.Error("a on workspaces must not touch projects")
	}
}

func importFixture(t *testing.T) (ImportView, string) {
	t.Helper()
	tmp := setupTestConfig(t)
	here := filepath.Join(tmp, "dev", "speak-api")
	os.MkdirAll(here, 0o755)
	os.MkdirAll(filepath.Join(tmp, "dev", "ai-tutor-api"), 0o755)
	project.Add(project.Project{Name: "speak-api", Path: here, Bindings: []project.Binding{{Var: "AI_TUTOR_API_URL", Value: "{{ai-tutor-api}}"}}})

	b := Bundle{Version: 1, Projects: []Exported{
		{Project: project.Project{Name: "speak-api", Path: here,
			DevServers: []project.DevServer{{Name: "speak-api", Port: 3000, Command: "npm start"}},
			Bindings:   []project.Binding{{Var: "AI_TUTOR_API_URL", Value: "{{ai-tutor-api}}"}, {Var: "AI_TUTOR_API_ASR_URL", Value: "{{ai-tutor-api}}"}},
			Setup:      "npm ci"}},
		{Project: project.Project{Name: "ai-tutor-api", Path: "/Users/other/ai-tutor-api",
			DevServers: []project.DevServer{{Name: "ai-tutor-api", Port: 8000}, {Name: "worker", Port: 8003}},
			Bindings:   []project.Binding{{Var: "SPEAK_API_URL", Value: "{{speak-api}}"}}}, Remote: "git@x:ai.git"},
		{Project: project.Project{Name: "gcp-infra", Path: "/Users/other/gcp-infra"}, Remote: "git@x:gcp.git"},
	}, Workspaces: []Membership{{Name: "phone-speak", Projects: []workspace.WorkspaceProject{{Name: "speak-api", Role: "api"}, {Name: "gcp-infra", Role: "infra", Mode: workspace.ModeDirect}}}}}
	return NewImportView("/x/crew-export.json", b), tmp
}

func TestImportView_AlreadyHereCard(t *testing.T) {
	v, tmp := importFixture(t)
	got := plain(v.View())
	here := filepath.Join(tmp, "dev", "speak-api")
	want := strings.Join([]string{
		"  Import crew-export.json · project 1 of 3",
		"",
		"  name      speak-api                                  · already here",
		"  path      " + padTo(here, pathCol) + " ✓ exists",
		"  servers   speak-api :3000  npm start",
		"  bindings  AI_TUTOR_API_URL      {{ai-tutor-api}}",
		"            AI_TUTOR_API_ASR_URL  {{ai-tutor-api}}",
		"            local has 1 binding: AI_TUTOR_API_URL",
		"  setup     npm ci",
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
	// Keep local on card 1 → anchors gain speak-api's path → card 2 finds ai-tutor-api beside it.
	m, _ := v.Update(keyRune("n"))
	v = m.(ImportView)
	got := plain(v.View())
	suggested := filepath.Join(tmp, "dev", "ai-tutor-api")
	if !strings.Contains(got, "project 2 of 3") || !strings.Contains(got, "✗ not here") ||
		!strings.Contains(got, "→ "+suggested) || !strings.Contains(got, "found beside speak-api — y uses this") ||
		!strings.Contains(got, "remote    git@x:ai.git") ||
		!strings.Contains(got, "y import with suggested path  c clone  e edit  n skip  esc stop") {
		t.Errorf("card 2 =\n%s", got)
	}

	// Skip it: card 3 has no sibling to find, so c clones beside the last anchor.
	m, _ = v.Update(keyRune("n"))
	v = m.(ImportView)
	got = plain(v.View())
	target := filepath.Join(tmp, "dev", "gcp-infra")
	if !strings.Contains(got, "→ "+target) || !strings.Contains(got, "c clones here — beside speak-api") ||
		!strings.Contains(got, "  c clone  e edit  n skip  esc stop") || strings.Contains(got, "y import") {
		t.Errorf("card 3 =\n%s", got)
	}
}

func TestImportView_WorkspaceBlockedThenSummary(t *testing.T) {
	v, _ := importFixture(t)
	for _, k := range []string{"n", "n", "n"} { // keep speak-api, skip the other two
		m, _ := v.Update(keyRune(k))
		v = m.(ImportView)
	}
	got := plain(v.View())
	if !strings.Contains(got, "workspace 1 of 1") ||
		!strings.Contains(got, "speak-api   api     worktree   already here") ||
		!strings.Contains(got, "gcp-infra   infra   direct     skipped") ||
		!strings.Contains(got, "! needs gcp-infra, which was not imported — n skips this workspace") ||
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
		"    speak-api     kept local",
		"    ai-tutor-api  skipped",
		"    gcp-infra     skipped",
		"",
		"  Workspaces",
		"    phone-speak   skipped — needs gcp-infra",
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
	v = press(t, v, "r") // replace speak-api: applied at once
	if project.Get("speak-api") == nil || len(project.Get("speak-api").Bindings) != 2 {
		t.Fatal("replace should have landed before the next card")
	}
	v = press(t, v, "esc")
	got := plain(v.View())
	if !strings.Contains(got, "stopped at project 2 of 3") || !strings.Contains(got, "speak-api     replaced") ||
		!strings.Contains(got, "ai-tutor-api  not reached") || !strings.Contains(got, "phone-speak   not reached") {
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
		// Bubbletea runs a batch concurrently; a listener in it blocks until
		// the worker beside it sends. Progress comes first so a test sees the
		// line before the completion that follows it.
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
		var rest []tea.Msg
		for _, r := range results {
			for _, m := range r {
				if _, ok := m.(wsProgressMsg); ok {
					out = append(out, m)
				} else {
					rest = append(rest, m)
				}
			}
		}
		out = append(out, rest...)
	case projectDoneMsg, clonedMsg, wsProgressMsg, wsDoneMsg:
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
	remote, _ := repoWithOrigin(t, tmp, "gcp-infra")
	v.bundle.Projects[2].Remote = remote
	v = press(t, v, "n") // speak-api kept → anchor
	v = press(t, v, "n") // ai-tutor-api skipped
	target := filepath.Join(tmp, "dev", "gcp-infra")
	if got := v.cloneTarget(); got != target {
		t.Fatalf("cloneTarget = %q, want %q", got, target)
	}

	m, cmd := v.Update(keyRune("c"))
	v = m.(ImportView)
	if v.state != importStateCloning || !strings.Contains(plain(v.View()), "Cloning gcp-infra → "+target) {
		t.Errorf("after c: state=%v\n%s", v.state, plain(v.View()))
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
	if got := plain(v.View()); !strings.Contains(got, "gcp-infra     imported (cloned)   → "+target) {
		t.Errorf("summary:\n%s", got)
	}
}

func TestImportView_CloneErrorShowsInline(t *testing.T) {
	v, _ := importFixture(t)
	v.bundle.Projects[2].Remote = "/nowhere/missing.git"
	v = press(t, v, "n")
	v = press(t, v, "n")
	v = press(t, v, "c")
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
	v = press(t, v, "n") // to ai-tutor-api, which speak-api's bindings point at
	v = press(t, v, "e")
	v.focus = fieldName
	v = typeInto(t, v, "tutor")
	v = press(t, v, "enter")
	want := "speak-api's AI_TUTOR_API_ASR_URL, speak-api's AI_TUTOR_API_URL point at ai-tutor-api — left alone until re-bound"
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
	v = typeInto(t, v, "speak-api2")
	v = press(t, v, "enter")
	if !strings.Contains(plain(v.View()), "r replace local") {
		t.Fatalf("card after rename:\n%s", plain(v.View()))
	}
	v = press(t, v, "r")
	if project.Get("speak-api") != nil || project.Get("speak-api2") == nil {
		t.Fatal("replace should swap the original record for the renamed one")
	}
	if !v.present["speak-api2"] || v.present["speak-api"] {
		t.Errorf("present = %v", v.present)
	}
	for range 2 {
		v = press(t, v, "n")
	}
	v = press(t, v, "n")
	if got := plain(v.View()); !strings.Contains(got, "speak-api     replaced") {
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
	if !strings.Contains(plain(v.View()), "y create  n skip  esc stop") {
		t.Fatalf("workspace card:\n%s", plain(v.View()))
	}

	m, cmd := v.Update(keyRune("y"))
	v = m.(ImportView)
	if v.state != importStateCreating {
		t.Fatalf("state = %v", v.state)
	}
	// Drain: the create runs to completion; progress lines arrive through the channel.
	var sawProgress bool
	var drain func(tea.Cmd)
	drain = func(c tea.Cmd) {
		for _, msg := range runCmd(c) {
			if p, ok := msg.(wsProgressMsg); ok {
				sawProgress = true
				m, next := v.Update(p)
				v = m.(ImportView)
				if !strings.Contains(plain(v.View()), "Creating ws — checking out api (1 of 1)") {
					t.Errorf("progress line:\n%s", plain(v.View()))
				}
				drain(next)
				continue
			}
			m, next := v.Update(msg)
			v = m.(ImportView)
			drain(next)
		}
	}
	drain(cmd)
	if !sawProgress {
		t.Error("no progress message seen")
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
