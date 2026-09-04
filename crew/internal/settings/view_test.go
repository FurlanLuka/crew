package settings

import (
	"regexp"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

var ansi = regexp.MustCompile(`\x1b\[[0-9;]*m`)

func TestRenderTrash(t *testing.T) {
	v := NewView()
	if got := ansi.ReplaceAllString(v.renderTrash(), ""); !strings.Contains(got, "measuring") {
		t.Errorf("unsized: %q", got)
	}

	v.trashSized = true
	if got := ansi.ReplaceAllString(v.renderTrash(), ""); got != "empty" {
		t.Errorf("empty: %q", got)
	}

	v.trashBytes, v.trashEntries = 161<<30, 1
	want := "161 GB in 1 entry  clearing in background — t deletes now"
	if got := ansi.ReplaceAllString(v.renderTrash(), ""); got != want {
		t.Errorf("one entry: %q, want %q", got, want)
	}
	v.trashEntries = 2
	if got := v.trashSummary(); got != "161 GB in 2 entries" {
		t.Errorf("summary: %q", got)
	}
}

func TestEmptyTrashFlow(t *testing.T) {
	press := func(v View, k string) View {
		m, _ := v.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)})
		return m.(View)
	}

	v := NewView()
	v.trashSized = true
	v = press(v, "t")
	if v.state != stateView || v.statusMsg != "Trash is empty" {
		t.Errorf("t on an empty trash: state=%v status=%q", v.state, v.statusMsg)
	}

	v.trashEntries = 2
	v = press(v, "t")
	if v.state != stateConfirmEmptyTrash {
		t.Errorf("t with entries should ask first, state=%v", v.state)
	}
	v = press(v, "n")
	if v.state != stateView {
		t.Errorf("n should back out, state=%v", v.state)
	}

	v = press(v, "t")
	m, cmd := v.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("y")})
	if cmd == nil {
		t.Fatal("y should run the empty command")
	}
	m, _ = m.(View).Update(trashEmptiedMsg{})
	v = m.(View)
	if v.state != stateView || v.statusMsg != "Trash emptied" || v.trashSized {
		t.Errorf("after emptying: state=%v status=%q sized=%v", v.state, v.statusMsg, v.trashSized)
	}
}
