package workspaceui

import (
	"errors"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

func TestBasePane(t *testing.T) {
	var b basePane
	ws := &workspace.Workspace{Name: "ws"}
	tick := tea.Cmd(func() tea.Msg { return nil })

	if b.pull(ws, tick) != nil {
		t.Error("nothing to pull before the table is in")
	}
	if cmd := b.fetch(ws, tick); cmd == nil || b.gen != 1 || b.phase != workspace.BaseLoading || !b.busy() {
		t.Fatalf("fetch: gen=%d phase=%v", b.gen, b.phase)
	}
	// A late answer for an earlier opening changes nothing.
	b, err := b.apply(basesMsg{gen: 0, statuses: []workspace.BaseStatus{{Project: "x"}}})
	if err != nil || b.statuses != nil || b.phase != workspace.BaseLoading {
		t.Errorf("stale answer applied: %+v", b)
	}
	b, err = b.apply(basesMsg{gen: 1, statuses: []workspace.BaseStatus{{Project: "api", Base: "main", Behind: 2}}})
	if err != nil || !b.ready() || !b.stale() {
		t.Errorf("answer: err=%v ready=%v stale=%v", err, b.ready(), b.stale())
	}
	if cmd := b.pull(ws, tick); cmd == nil || b.gen != 2 || b.phase != workspace.BasePulling {
		t.Errorf("pull: gen=%d phase=%v", b.gen, b.phase)
	}
	b, err = b.apply(basesMsg{gen: 2, statuses: []workspace.BaseStatus{{Project: "api", Base: "main"}}, pulled: []error{errors.New("api: a"), errors.New("web: b")}})
	if err == nil || err.Error() != "api: a; web: b" || !b.ready() || b.stale() {
		t.Errorf("after the pull: err=%v ready=%v stale=%v", err, b.ready(), b.stale())
	}
	if b.pull(ws, tick) != nil {
		t.Error("nothing behind: nothing to pull")
	}
	b.drop()
	if b.gen != 3 {
		t.Errorf("drop bumps the generation: %d", b.gen)
	}
	if joinErrs(nil) != nil {
		t.Error("no errors join to nil")
	}
}
