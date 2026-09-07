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
	v.selectedWs = "phone-speak"
	v.summaries = []Summary{
		{Ref: Ref{Workspace: "phone-speak", Worktree: "wrk1"}, Workspace: "phone-speak", Worktree: "wrk1", DevRunning: true},
		{Ref: Ref{Workspace: "phone-speak", Worktree: "wrk10"}, Workspace: "phone-speak", Worktree: "wrk10"},
	}
	v.sizes["phone-speak/wrk1"] = 161 << 30
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
