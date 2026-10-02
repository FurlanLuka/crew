package app

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

type stubPage struct{ name string }

func (p stubPage) Init() tea.Cmd                       { return nil }
func (p stubPage) Update(tea.Msg) (tea.Model, tea.Cmd) { return p, nil }
func (p stubPage) View() string                        { return "" }
func (p stubPage) Title() string                       { return p.name }

// A pop reveals the page underneath; a pop of the last page quits.
func TestPop_RevealsThePageUnderneath(t *testing.T) {
	a := New(stubPage{name: "picker"})
	m, _ := a.Update(PushPageMsg{Page: stubPage{name: "page"}})
	m, _ = m.(App).Update(PopPageMsg{})
	a = m.(App)
	if len(a.stack) != 1 || a.stack[0].Title() != "picker" {
		t.Fatalf("stack = %d", len(a.stack))
	}
	_, cmd := a.Update(PopPageMsg{})
	if cmd == nil {
		t.Fatal("popping the last page should quit")
	}
	if _, ok := cmd().(tea.QuitMsg); !ok {
		t.Error("popping the last page should quit")
	}
}
