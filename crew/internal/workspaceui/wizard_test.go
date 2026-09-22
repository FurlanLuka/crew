package workspaceui

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/projectui"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// pressV sends a key to the list and settles it; the pushes and pops it
// produced come back beside the model.
func pressV(t *testing.T, v View, k string) (View, []tea.Msg) {
	t.Helper()
	m, nav := settle(t, v, keyOf(k))
	return m.(View), nav
}

func typeV(t *testing.T, v View, text string) View {
	t.Helper()
	for _, r := range text {
		v, _ = pressV(t, v, string(r))
	}
	return v
}

// twoRepos seeds two server-less pool projects with real repos, so a
// creation checks them out and runs nothing.
func twoRepos(t *testing.T) string {
	t.Helper()
	tmp := setupTestConfig(t)
	for _, name := range []string{"store-front", "store-api"} {
		repo := filepath.Join(tmp, "repos", name)
		initRepo(t, repo)
		project.Add(project.Project{Name: name, Path: repo})
	}
	return tmp
}

func TestCliLine(t *testing.T) {
	for _, tt := range []struct {
		name  string
		specs []workspace.ProjectSpec
		want  string
	}{
		{"", nil, "crew add workspace <name> <project> …"},
		{"ws", nil, "crew add workspace ws <project> …"},
		{"ws", []workspace.ProjectSpec{{Name: "a"}, {Name: "b"}}, "crew add workspace ws a b"},
		{"ws", []workspace.ProjectSpec{{Name: "a", Mode: workspace.ModeDirect}}, "crew add workspace ws a --direct"},
		{"ws", []workspace.ProjectSpec{{Name: "a", Mode: workspace.ModeDirect}, {Name: "b"}}, "crew add workspace ws a b"},
	} {
		if got := cliLine(tt.name, tt.specs); got != tt.want {
			t.Errorf("cliLine(%q, %+v) = %q, want %q", tt.name, tt.specs, got, tt.want)
		}
	}
}

func TestWizard_NameCard(t *testing.T) {
	setupTestConfig(t)
	workspace.Create("taken")
	v := NewView()
	v, _ = pressV(t, v, "n")
	if v.wizard == nil || v.Title() != "Add workspace" {
		t.Fatalf("n opens the wizard in place: %+v", v.wizard)
	}
	v, _ = pressV(t, v, "enter")
	if v.wizard.err == nil || v.wizard.card != cardName {
		t.Errorf("an empty name stays: %v", v.wizard.err)
	}
	v = typeV(t, v, "Bad Name")
	v, _ = pressV(t, v, "enter")
	if v.wizard.card != cardName || v.wizard.err == nil {
		t.Errorf("an invalid name stays: %v", v.wizard.err)
	}
	v.wizard.name.SetValue("taken")
	v, _ = pressV(t, v, "enter")
	if v.wizard.card != cardName || !strings.Contains(v.wizard.err.Error(), "already exists") {
		t.Errorf("an existing name stays: %v", v.wizard.err)
	}
	v.wizard.name.SetValue("check")
	v, _ = pressV(t, v, "enter")
	if v.wizard.card != cardName || !strings.Contains(v.wizard.err.Error(), "reserved") {
		t.Errorf("the check workspace is reserved: %v", v.wizard.err)
	}
	v, _ = pressV(t, v, "esc")
	if v.wizard != nil || v.Title() != "Workspaces" {
		t.Error("esc on the first card closes the wizard")
	}
	if workspace.Exists("check") || workspace.Exists("Bad Name") {
		t.Error("nothing was created")
	}
}

// Name → tick two → y: the workspace file holds both members, main is
// checked out, and the list pushes the worktree page with the created
// status; the wizard is gone from under it.
func TestWizard_EndToEnd(t *testing.T) {
	twoRepos(t)
	v := NewView()
	v, _ = pressV(t, v, "n")
	v = typeV(t, v, "feature-auth")
	v, _ = pressV(t, v, "enter")
	w := v.wizard
	if w.card != cardProjects || len(w.picker.rows) != 2 {
		t.Fatalf("card 2 with the pool: card=%v rows=%+v", w.card, w.picker.rows)
	}
	v, _ = pressV(t, v, "enter")
	if v.wizard.card != cardProjects || v.wizard.err == nil {
		t.Fatalf("enter with nothing ticked stays: %v", v.wizard.err)
	}
	v, _ = pressV(t, v, " ")
	v, _ = pressV(t, v, "down")
	v, _ = pressV(t, v, " ")
	got := plain(v.View())
	if !strings.Contains(got, "✓ store-front") || !strings.Contains(got, "✓ store-api") || !strings.Contains(got, "crew add workspace feature-auth store-front store-api") {
		t.Errorf("card 2:\n%s", got)
	}
	v, _ = pressV(t, v, "enter")
	if v.wizard.card != cardCreate || !v.wizard.bases.ready() {
		t.Fatalf("card 3 with its table: card=%v phase=%v", v.wizard.card, v.wizard.bases.phase)
	}
	if got := plain(v.View()); !strings.Contains(got, "Branching from") || !strings.Contains(got, "y create") {
		t.Errorf("card 3:\n%s", got)
	}
	v, nav := pressV(t, v, "y")
	page, ok := pushedPage(nav).(workspace.WorktreeView)
	if !ok || page.Ref().String() != "feature-auth/main" || page.Status() != "Created feature-auth/main — installing" {
		t.Fatalf("y pushes the worktree page: %+v", pushedPage(nav))
	}
	if v.wizard != nil {
		t.Error("the wizard is gone from under the page")
	}
	ws, err := workspace.Load("feature-auth")
	if err != nil || len(ws.Projects) != 2 || ws.Projects[0].Name != "store-front" || ws.Projects[1].Name != "store-api" {
		t.Fatalf("workspace = %+v, %v", ws, err)
	}
	ref := workspace.Ref{Workspace: "feature-auth", Worktree: "main"}
	for _, name := range []string{"store-front", "store-api"} {
		if _, err := os.Stat(workspace.WorktreePath(ref, name)); err != nil {
			t.Errorf("%s not checked out", name)
		}
	}
	if st, _ := workspace.SetupStatus(ref); st.Running() || st.Health() != nil {
		t.Errorf("runners should have passed: %+v", st)
	}
}

// An empty pool is not a dead end: card 2 says so and a pushes the
// add-project wizard.
func TestWizard_EmptyPool(t *testing.T) {
	setupTestConfig(t)
	v := NewView()
	v, _ = pressV(t, v, "n")
	v = typeV(t, v, "ws")
	v, _ = pressV(t, v, "enter")
	if got := plain(v.View()); !strings.Contains(got, "no projects yet — a clones or adopts one") {
		t.Errorf("card 2 on an empty pool:\n%s", got)
	}
	_, nav := pressV(t, v, "a")
	if _, ok := pushedPage(nav).(projectui.Wizard); !ok {
		t.Error("a pushes the add-project wizard")
	}
	v, _ = pressV(t, v, "enter")
	if v.wizard.card != cardProjects || v.wizard.err == nil {
		t.Error("enter with nothing to tick stays")
	}
}

// ctrl+p on card 3 pulls the stale bases; a failure lands on the card.
func TestWizard_PullFirst(t *testing.T) {
	twoRepos(t)
	v := NewView()
	v, _ = pressV(t, v, "n")
	v = typeV(t, v, "ws")
	v, _ = pressV(t, v, "enter")
	v, _ = pressV(t, v, " ")
	v, _ = pressV(t, v, "enter")
	// Nothing behind: ctrl+p is inert.
	if m, cmd := v.Update(keyOf("ctrl+p")); cmd != nil || !m.(View).wizard.bases.ready() {
		t.Error("ctrl+p with nothing behind does nothing")
	}
	v.wizard.bases.statuses = []workspace.BaseStatus{{Project: "store-front", Base: "main", Behind: 2}}
	gen := v.wizard.bases.gen
	m, cmd := v.Update(keyOf("ctrl+p"))
	v = m.(View)
	if cmd == nil || v.wizard.bases.phase != workspace.BasePulling || v.wizard.bases.gen == gen {
		t.Fatalf("ctrl+p: phase=%v gen=%d→%d", v.wizard.bases.phase, gen, v.wizard.bases.gen)
	}
	m, _ = v.Update(basesMsg{gen: v.wizard.bases.gen, statuses: v.wizard.bases.statuses, pulled: []error{errors.New("store-front: fast-forwarding main failed")}})
	v = m.(View)
	if !v.wizard.bases.ready() || v.wizard.err == nil || !strings.Contains(v.wizard.err.Error(), "fast-forwarding") {
		t.Errorf("after the pull: phase=%v err=%v", v.wizard.bases.phase, v.wizard.err)
	}
}

func TestWizard_EscLevels(t *testing.T) {
	twoRepos(t)
	v := NewView()
	v, _ = pressV(t, v, "n")
	v = typeV(t, v, "ws")
	v, _ = pressV(t, v, "enter")
	v, _ = pressV(t, v, " ")
	v, _ = pressV(t, v, "enter")
	if v.wizard.card != cardCreate {
		t.Fatal("card 3")
	}
	gen := v.wizard.bases.gen
	v, _ = pressV(t, v, "esc")
	if v.wizard.card != cardProjects || v.wizard.bases.gen == gen {
		t.Error("esc goes back to the projects and drops a table in flight")
	}
	// A table for the card that was left is ignored.
	v.wizard.bases.statuses = nil
	m, _ := v.Update(basesMsg{gen: gen, statuses: []workspace.BaseStatus{{Project: "x"}}})
	if v = m.(View); v.wizard.bases.statuses != nil {
		t.Error("a stale table should be dropped")
	}
	if !v.wizard.picker.rows[0].Ticked {
		t.Error("the ticks survive going back")
	}
	v, _ = pressV(t, v, "esc")
	if v.wizard.card != cardName || v.wizard.name.Value() != "ws" {
		t.Error("esc goes back to the name, kept")
	}
	v, _ = pressV(t, v, "esc")
	if v.wizard != nil {
		t.Error("esc closes")
	}
}

// A member removed from the pool between the cards fails the create on
// card 3 and leaves no workspace behind.
func TestWizard_CreateFailureLeavesNothing(t *testing.T) {
	twoRepos(t)
	v := NewView()
	v, _ = pressV(t, v, "n")
	v = typeV(t, v, "ws")
	v, _ = pressV(t, v, "enter")
	v, _ = pressV(t, v, " ")
	v, _ = pressV(t, v, "enter")
	project.Remove("store-front")
	v, nav := pressV(t, v, "y")
	if pushedPage(nav) != nil || v.wizard == nil || v.wizard.card != cardCreate || v.wizard.creating {
		t.Fatalf("y should fail on the card: wizard=%+v", v.wizard)
	}
	if v.wizard.err == nil || !strings.Contains(v.wizard.err.Error(), "not found in pool") {
		t.Errorf("err = %v", v.wizard.err)
	}
	if workspace.Exists("ws") {
		t.Error("no workspace should be left")
	}
}

// a on card 2 pushes the add-project wizard; on the pop back the list's
// Init re-reads the pool and the new project is ticked.
func TestWizard_ProjectAddedMeanwhileComesBackTicked(t *testing.T) {
	tmp := twoRepos(t)
	v := NewView()
	v, _ = pressV(t, v, "n")
	v = typeV(t, v, "ws")
	v, _ = pressV(t, v, "enter")
	_, nav := pressV(t, v, "a")
	if _, ok := pushedPage(nav).(projectui.Wizard); !ok {
		t.Fatal("a pushes the add-project wizard")
	}
	project.Add(project.Project{Name: "checkout-api", Path: filepath.Join(tmp, "repos", "checkout-api")})
	m := tea.Model(v)
	for _, msg := range runCmd(v.Init(), nil) {
		m, _ = settle(t, m, msg)
	}
	v = m.(View)
	specs := v.wizard.picker.specs()
	if len(specs) != 1 || specs[0].Name != "checkout-api" {
		t.Errorf("specs after the pop = %+v", specs)
	}
	if v.wizard.picker.rows[0].Ticked {
		t.Error("a project the picker knew stays as it was")
	}
}

// The list's d asks with what goes, resolved when d was pressed.
func TestList_RemoveWorkspace(t *testing.T) {
	setupTestConfig(t)
	config.TrashDir = filepath.Join(t.TempDir(), "trash")
	workspace.Create("ws")
	v := NewView()
	m, _ := settle(t, v, workspacesLoadedMsg{summaries: []workspace.Summary{{Ref: workspace.Ref{Workspace: "ws", Worktree: "main"}, Workspace: "ws", Worktree: "main"}}})
	v = m.(View)
	v, _ = pressV(t, v, "d")
	if v.confirm == nil || v.confirm.prompt != "Remove workspace 'ws'? This will delete all worktrees. (y/n)" {
		t.Fatalf("confirm = %+v", v.confirm)
	}
	v, _ = pressV(t, v, "n")
	if v.confirm != nil || !workspace.Exists("ws") {
		t.Error("n keeps it")
	}
	v, _ = pressV(t, v, "d")
	v, _ = pressV(t, v, "y")
	if workspace.Exists("ws") || v.statusMsg != "Removed workspace 'ws'" {
		t.Errorf("y removes: exists=%v status=%q", workspace.Exists("ws"), v.statusMsg)
	}
	if got := removeWorkspacePrompt("ws", []workspace.WorkspaceProject{{Name: "a", Mode: workspace.ModeDirect}}); got != "Remove workspace 'ws'? No worktrees to delete; 1 direct project(s) will be untouched. (y/n)" {
		t.Errorf("direct only: %q", got)
	}
	if got := removeWorkspacePrompt("ws", []workspace.WorkspaceProject{{Name: "a", Mode: workspace.ModeDirect}, {Name: "b"}}); got != "Remove workspace 'ws'? Will delete 1 worktree(s); 1 direct project(s) untouched. (y/n)" {
		t.Errorf("mixed: %q", got)
	}
}

// The list opens the page on enter and takes a popped status.
func TestList_OpensThePage(t *testing.T) {
	setupTestConfig(t)
	v := NewView()
	m, _ := settle(t, v, workspacesLoadedMsg{summaries: []workspace.Summary{{Ref: workspace.Ref{Workspace: "ws", Worktree: "main"}, Workspace: "ws", Worktree: "main", ProjectCount: 2}}})
	v = m.(View)
	if got := plain(v.View()); !strings.Contains(got, "> ws  2 projects · 1 worktree") || !strings.Contains(got, "enter open  n new  d delete  esc back") {
		t.Errorf("list:\n%s", got)
	}
	_, nav := pressV(t, v, "enter")
	if page, ok := pushedPage(nav).(Page); !ok || page.name != "ws" {
		t.Errorf("enter pushes the page: %+v", pushedPage(nav))
	}
	m, _ = v.Update(app.StatusMsg{Status: "Removed workspace 'ws'"})
	if got := m.(View).statusMsg; got != "Removed workspace 'ws'" {
		t.Errorf("status after a pop = %q", got)
	}
}
