package workspace

import (
	"strings"
	"testing"

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
