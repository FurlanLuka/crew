package transfer

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
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
	m, _ := v.Update(keyRune("r")) // replace speak-api: applied at once
	v = m.(ImportView)
	msg := v.pendingCmdResult(t)
	m, _ = v.Update(msg)
	v = m.(ImportView)
	if project.Get("speak-api") == nil || len(project.Get("speak-api").Bindings) != 2 {
		t.Fatal("replace should have landed before the next card")
	}
	m, _ = v.Update(keyEsc())
	v = m.(ImportView)
	got := plain(v.View())
	if !strings.Contains(got, "stopped at project 2 of 3") || !strings.Contains(got, "speak-api     replaced") ||
		!strings.Contains(got, "ai-tutor-api  not reached") || !strings.Contains(got, "phone-speak   not reached") {
		t.Errorf("summary =\n%s", got)
	}
	_ = tmp
}

// pendingCmdResult runs the command the last key produced. The import view
// applies through commands so the TUI never blocks; tests run them inline.
func (v ImportView) pendingCmdResult(t *testing.T) interface{} {
	t.Helper()
	_, cmd := ImportView(v).apply(true)
	if cmd == nil {
		t.Fatal("no command")
	}
	return cmd()
}

func padTo(s string, w int) string {
	if len(s) >= w {
		return s
	}
	return s + strings.Repeat(" ", w-len(s))
}

func keyRune(r string) tea.KeyMsg { return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(r)} }
func keyEsc() tea.KeyMsg          { return tea.KeyMsg{Type: tea.KeyEsc} }
