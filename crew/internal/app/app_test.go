package app

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

type stubPage struct {
	name   string
	status string
}

func (p stubPage) Init() tea.Cmd { return nil }
func (p stubPage) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if s, ok := msg.(StatusMsg); ok {
		p.status = s.Status
	}
	return p, nil
}
func (p stubPage) View() string  { return "" }
func (p stubPage) Title() string { return p.name }

// A pop can carry what the popped page did last; the revealed page gets
// it as a StatusMsg after its Init.
func TestPop_CarriesStatusToTheRevealedPage(t *testing.T) {
	a := New(stubPage{name: "list"})
	m, _ := a.Update(PushPageMsg{Page: stubPage{name: "page"}})
	a = m.(App)
	m, cmd := a.Update(PopPageMsg{Status: "Removed workspace ws"})
	a = m.(App)
	if len(a.stack) != 1 || a.stack[0].Title() != "list" {
		t.Fatalf("stack = %d", len(a.stack))
	}
	if got := statusIn(cmd); got != "Removed workspace ws" {
		t.Errorf("status = %q", got)
	}
	// A plain pop sends none.
	m, _ = a.Update(PushPageMsg{Page: stubPage{name: "page"}})
	_, cmd = m.(App).Update(PopPageMsg{})
	if got := statusIn(cmd); got != "" {
		t.Errorf("a bare pop should carry no status, got %q", got)
	}
}

// statusIn runs a command tree and returns the StatusMsg in it, if any.
// tea.Batch hands a lone command back as itself, so both shapes are read.
func statusIn(cmd tea.Cmd) string {
	if cmd == nil {
		return ""
	}
	switch msg := cmd().(type) {
	case StatusMsg:
		return msg.Status
	case tea.BatchMsg:
		for _, sub := range msg {
			if s := statusIn(sub); s != "" {
				return s
			}
		}
	}
	return ""
}
