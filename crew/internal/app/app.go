package app

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// Page is a navigable TUI view.
type Page interface {
	tea.Model
	Title() string
}

// PushPageMsg pushes a new page onto the navigation stack.
type PushPageMsg struct{ Page Page }

// PopPageMsg pops the current page.
type PopPageMsg struct{}

// ExitWithOutputMsg quits the TUI and prints output to stdout after exit.
type ExitWithOutputMsg struct{ Output string }

// App is the root model managing a navigation stack of pages.
type App struct {
	stack      []Page
	width      int
	height     int
	ExitOutput string
}

func New(initial Page) App {
	return App{stack: []Page{initial}}
}

func (a App) Init() tea.Cmd {
	if len(a.stack) > 0 {
		return a.stack[len(a.stack)-1].Init()
	}
	return nil
}

func (a App) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		a.width = msg.Width
		a.height = msg.Height
		// Forward to current page
		if len(a.stack) > 0 {
			page := a.stack[len(a.stack)-1]
			updated, cmd := page.Update(msg)
			a.stack[len(a.stack)-1] = updated.(Page)
			return a, cmd
		}
		return a, nil

	case PushPageMsg:
		a.stack = append(a.stack, msg.Page)
		cmds := []tea.Cmd{msg.Page.Init()}
		a.forwardWindowSize(&cmds)
		return a, tea.Batch(cmds...)

	case ExitWithOutputMsg:
		a.ExitOutput = msg.Output
		return a, tea.Quit

	case PopPageMsg:
		if len(a.stack) <= 1 {
			return a, tea.Quit
		}
		a.stack = a.stack[:len(a.stack)-1]
		// Re-init the revealed page so it refreshes its data
		top := a.stack[len(a.stack)-1]
		cmds := []tea.Cmd{top.Init()}
		a.forwardWindowSize(&cmds)
		return a, tea.Batch(cmds...)
	}

	// Forward to current page
	if len(a.stack) > 0 {
		page := a.stack[len(a.stack)-1]
		updated, cmd := page.Update(msg)
		a.stack[len(a.stack)-1] = updated.(Page)
		return a, cmd
	}

	return a, nil
}

// forwardWindowSize sends the stored window size to the top page so it can
// initialize size-dependent components (e.g. viewport).
func (a *App) forwardWindowSize(cmds *[]tea.Cmd) {
	if a.width == 0 || a.height == 0 || len(a.stack) == 0 {
		return
	}
	page := a.stack[len(a.stack)-1]
	updated, cmd := page.Update(tea.WindowSizeMsg{Width: a.width, Height: a.height})
	a.stack[len(a.stack)-1] = updated.(Page)
	if cmd != nil {
		*cmds = append(*cmds, cmd)
	}
}

func (a App) View() string {
	if len(a.stack) == 0 {
		return ""
	}

	page := a.stack[len(a.stack)-1]
	var b strings.Builder

	b.WriteString("\n")
	b.WriteString("  ")
	b.WriteString(Title.Render(page.Title()))
	b.WriteString("\n\n")
	b.WriteString(page.View())

	return b.String()
}
