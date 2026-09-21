package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
)

func TestRenderWorktrees_SizeColumnAndTrashNotice(t *testing.T) {
	tmp := setupTestConfig(t)
	config.TrashDir = tmp + "/trash"

	v := NewView()
	v.state = stateWorktrees
	v.selectedWs = "store-front"
	v.summaries = []Summary{
		{Ref: Ref{Workspace: "store-front", Worktree: "wrk1"}, Workspace: "store-front", Worktree: "wrk1", DevRunning: true},
		{Ref: Ref{Workspace: "store-front", Worktree: "wrk10"}, Workspace: "store-front", Worktree: "wrk10"},
	}
	v.sizes["store-front/wrk1"] = 161 << 30
	v.summaries[1].Health = "server died: api/api"

	var b strings.Builder
	v.renderWorktrees(&b)
	got := stripANSI(b.String())

	// Sizes right-align in one column; a worktree still being walked shows the spinner.
	if !strings.Contains(got, "> wrk1    161 GB  [dev]") {
		t.Errorf("wrk1 row:\n%s", got)
	}
	if !strings.Contains(got, "  wrk10        ") || strings.Contains(got, "wrk10  161") {
		t.Errorf("wrk10 row should show no size yet:\n%s", got)
	}
	if !strings.Contains(got, "! server died: api/api") {
		t.Errorf("recorded failure should show on the row:\n%s", got)
	}
	if strings.Contains(got, "trash:") {
		t.Errorf("no trash notice when the trash is empty:\n%s", got)
	}

	// With something in the trash the list says so.
	checkoutInTrash(t, "x")
	b.Reset()
	v.renderWorktrees(&b)
	if !strings.Contains(stripANSI(b.String()), "trash: 1 removed checkout still clearing in background") {
		t.Errorf("trash notice missing:\n%s", b.String())
	}
}

func TestTrashNotice(t *testing.T) {
	tmp := setupTestConfig(t)
	config.TrashDir = tmp + "/trash"

	if got := TrashNotice(); got != "" {
		t.Errorf("empty trash: %q", got)
	}
	checkoutInTrash(t, "a")
	if got := TrashNotice(); got != "trash: 1 removed checkout still clearing in background" {
		t.Errorf("one entry: %q", got)
	}
	checkoutInTrash(t, "b")
	if got := TrashNotice(); got != "trash: 2 removed checkouts still clearing in background" {
		t.Errorf("two entries: %q", got)
	}
}

// Each worktree is walked by its own command, closing over its own path, so
// a small one lands while a huge sibling is still being walked.
func TestLoadMissingSizes_OneCommandPerWorktree(t *testing.T) {
	tmp := setupTestConfig(t)
	dirA, dirB := filepath.Join(tmp, "a"), filepath.Join(tmp, "b")
	os.MkdirAll(dirA, 0o755)
	os.MkdirAll(dirB, 0o755)
	os.WriteFile(filepath.Join(dirA, "f"), make([]byte, 100), 0o644)
	os.WriteFile(filepath.Join(dirB, "f"), make([]byte, 2500), 0o644)

	v := NewView()
	v.state = stateWorktrees
	v.selectedWs = "ws"
	v.summaries = []Summary{
		{Ref: Ref{Workspace: "ws", Worktree: "a"}, Workspace: "ws", Worktree: "a", Path: dirA},
		{Ref: Ref{Workspace: "ws", Worktree: "b"}, Workspace: "ws", Worktree: "b", Path: dirB},
	}

	for _, msg := range runBatch(t, v.loadMissingSizes()) {
		if sizes, ok := msg.(worktreeSizesMsg); ok {
			m, _ := v.Update(sizes)
			v = m.(View)
		}
	}
	if v.sizes["ws/a"] != 100 || v.sizes["ws/b"] != 2500 {
		t.Errorf("sizes = %v, want a=100 b=2500", v.sizes)
	}
}

// runBatch executes every command in a tea.Batch and returns their messages.
func runBatch(t *testing.T, cmd tea.Cmd) []tea.Msg {
	t.Helper()
	var out []tea.Msg
	var run func(tea.Cmd)
	run = func(c tea.Cmd) {
		if c == nil {
			return
		}
		switch msg := c().(type) {
		case tea.BatchMsg:
			for _, sub := range msg {
				run(sub)
			}
		default:
			out = append(out, msg)
		}
	}
	run(cmd)
	return out
}

func TestLoadMissingSizes_OnlyWalksUnknownWorktrees(t *testing.T) {
	setupTestConfig(t)
	v := NewView()
	v.state = stateWorktrees
	v.selectedWs = "ws"
	v.summaries = []Summary{
		{Ref: Ref{Workspace: "ws", Worktree: "a"}, Workspace: "ws", Worktree: "a"},
		{Ref: Ref{Workspace: "ws", Worktree: "b"}, Workspace: "ws", Worktree: "b"},
	}
	v.sizes["ws/a"] = 1
	if !v.sizesLoading() {
		t.Error("b has no size yet, so the spinner should run")
	}
	v.sizes["ws/b"] = 2
	if v.sizesLoading() || v.loadMissingSizes() != nil {
		t.Error("nothing to walk once every worktree has a size")
	}
}

// Creation ends on the worktree page: the list resets itself for when esc
// comes back, and pushes the page with what just happened as its status.
func TestWorktreeAdded_PushesThePage(t *testing.T) {
	setupTestConfig(t)
	v := NewView()
	v.state = stateAddingWorktree
	v.sizes["ws/wt"] = 5
	ref := Ref{Workspace: "ws", Worktree: "wt"}

	m, cmd := v.Update(worktreeAddedMsg{ref: ref, health: &Health{Issues: []Issue{{Stage: StageSmoke, Project: "a", Server: "a"}}}})
	v = m.(View)
	if v.state != stateWorktrees || v.statusMsg != "" {
		t.Errorf("list should be reset: state=%v status=%q", v.state, v.statusMsg)
	}
	if _, ok := v.sizes["ws/wt"]; ok {
		t.Error("the new worktree's size should be invalidated")
	}
	var page WorktreeView
	found := false
	for _, msg := range runBatch(t, cmd) {
		if p, ok := msg.(app.PushPageMsg); ok {
			page, found = p.Page.(WorktreeView)
		}
	}
	if !found || page.ref != ref || page.statusMsg != "Created ws/wt — server died: a/a" {
		t.Errorf("pushed page: found=%v ref=%v status=%q", found, page.ref, page.statusMsg)
	}

	m, cmd = v.Update(worktreeAddedMsg{ref: ref, duplicatedFrom: "ws/main"})
	for _, msg := range runBatch(t, cmd) {
		if p, ok := msg.(app.PushPageMsg); ok {
			if got := p.Page.(WorktreeView).statusMsg; got != "Duplicated ws/main → ws/wt" {
				t.Errorf("duplicate status = %q", got)
			}
		}
	}
	_ = m
}

func keyMsg(s string) tea.KeyMsg {
	switch s {
	case "enter":
		return tea.KeyMsg{Type: tea.KeyEnter}
	case "esc":
		return tea.KeyMsg{Type: tea.KeyEsc}
	case " ":
		return tea.KeyMsg{Type: tea.KeySpace}
	case "down":
		return tea.KeyMsg{Type: tea.KeyDown}
	}
	return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(s)}
}

// Space ticks, enter walks a role prompt per ticked project, then one mode
// step, then one add of all of them. Nothing ticked: the row under the
// cursor, as before.
func TestProjectPick_MultiSelect(t *testing.T) {
	setupTestConfig(t)
	v := NewView()
	v.state = stateProjectPick
	v.selectedWs = "ws"
	v.poolNames = []string{"api", "web", "worker"}

	step := func(k string) {
		m, _ := v.Update(keyMsg(k))
		v = m.(View)
	}
	step(" ")    // tick api
	step("down") // → web
	step("down") // → worker
	step(" ")    // tick worker
	if got := stripANSI(v.View()); !strings.Contains(got, "✓ api") || !strings.Contains(got, "○ web") || !strings.Contains(got, "✓ worker") {
		t.Errorf("ticks not rendered:\n%s", got)
	}
	step("enter")
	if v.state != stateProjectRole || v.pickedProject != "api" || len(v.queue) != 2 {
		t.Fatalf("after enter: state=%v picked=%q queue=%v", v.state, v.pickedProject, v.queue)
	}
	if got := stripANSI(v.View()); !strings.Contains(got, "Adding 'api' (1 of 2)") {
		t.Errorf("role prompt should count:\n%s", got)
	}
	v.roleInput.SetValue("Backend")
	step("enter")
	if v.state != stateProjectRole || v.pickedProject != "worker" {
		t.Fatalf("second role prompt: state=%v picked=%q", v.state, v.pickedProject)
	}
	step("enter") // empty role → default
	if v.state != stateProjectMode {
		t.Fatalf("after the last role: state=%v", v.state)
	}
	want := []ProjectSpec{{Name: "api", Role: "Backend"}, {Name: "worker", Role: "works on worker"}}
	if len(v.picked) != 2 || v.picked[0] != want[0] || v.picked[1] != want[1] {
		t.Errorf("picked = %+v, want %+v", v.picked, want)
	}
	if got := stripANSI(v.View()); !strings.Contains(got, "Adding api, worker") {
		t.Errorf("mode step names them all:\n%s", got)
	}

	// Nothing ticked: enter takes the cursor row, one role prompt, no count.
	v = NewView()
	v.state = stateProjectPick
	v.poolNames = []string{"api", "web"}
	step("down")
	step("enter")
	if v.state != stateProjectRole || v.pickedProject != "web" || len(v.queue) != 1 {
		t.Errorf("single pick: state=%v picked=%q queue=%v", v.state, v.pickedProject, v.queue)
	}
	if got := stripANSI(v.View()); strings.Contains(got, "of 1") {
		t.Errorf("a single pick should not count:\n%s", got)
	}
}

func TestAddedStatus(t *testing.T) {
	if got := addedStatus([]string{"api", "web"}, nil); got != "Added api, web" {
		t.Errorf("all good → %q", got)
	}
	issues := []Issue{{Stage: StageInstall, Project: "web"}}
	if got := addedStatus([]string{"api", "web"}, issues); got != "Added api — web failed, recorded on the worktree (f fix on its page)" {
		t.Errorf("one failed → %q", got)
	}
	if got := addedStatus([]string{"web"}, issues); got != "Added nothing — web failed, recorded on the worktree (f fix on its page)" {
		t.Errorf("all failed → %q", got)
	}
}
