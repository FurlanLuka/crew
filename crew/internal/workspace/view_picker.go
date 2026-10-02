package workspace

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
)

// LaunchPicker is bare `crew launch`: every worktree, enter opens its page —
// where Claude and the editor are launched. Configuring them is the web's
// Set up; the terminal keeps only the launching.
type LaunchPicker struct {
	manageURL string
	rows      []Summary
	cursor    int
	loaded    bool
	err       error
}

type pickerLoadedMsg struct {
	rows []Summary
	err  error
}

func NewLaunchPicker(manageURL string) LaunchPicker { return LaunchPicker{manageURL: manageURL} }

func (p LaunchPicker) Title() string { return "launch" }

func (p LaunchPicker) Init() tea.Cmd {
	return func() tea.Msg {
		rows, err := ListSummaries()
		return pickerLoadedMsg{rows: rows, err: err}
	}
}

func (p LaunchPicker) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case pickerLoadedMsg:
		p.rows, p.err, p.loaded = msg.rows, msg.err, true
		p.cursor = min(p.cursor, max(0, len(p.rows)-1))
	case tea.KeyMsg:
		switch {
		case key.Matches(msg, app.Keys.Quit), key.Matches(msg, app.Keys.Back):
			return p, tea.Quit
		case key.Matches(msg, app.Keys.Up):
			p.cursor = app.MoveCursor(p.cursor, -1, len(p.rows))
		case key.Matches(msg, app.Keys.Down):
			p.cursor = app.MoveCursor(p.cursor, 1, len(p.rows))
		case msg.String() == "enter" && len(p.rows) > 0:
			page := NewWorktreeView(p.rows[p.cursor].Ref, p.manageURL)
			return p, func() tea.Msg { return app.PushPageMsg{Page: page} }
		}
	}
	return p, nil
}

func (p LaunchPicker) View() string {
	if !p.loaded {
		return ""
	}
	var b strings.Builder
	if p.err != nil {
		b.WriteString("  " + app.Error.Render(p.err.Error()) + "\n")
	}
	b.WriteString(renderPicker(p.rows, p.cursor))
	b.WriteString("\n  " + app.HelpStyle.Render("enter open  esc quit") + "\n")
	return b.String()
}

// renderPicker is the list: one worktree per row with what it is doing,
// the empty case naming where worktrees are made. Pure.
func renderPicker(rows []Summary, cursor int) string {
	var b strings.Builder
	if len(rows) == 0 {
		b.WriteString("  " + app.Subtle.Render("no worktrees yet — set one up in the browser (run crew) or crew add workspace <ws> <project>…") + "\n")
		return b.String()
	}
	width := 0
	for _, r := range rows {
		width = max(width, len(r.Name))
	}
	for i, r := range rows {
		sel := i == cursor
		b.WriteString("  " + app.RowPrefix(sel) + app.RowName(fmt.Sprintf("%-*s", width, r.Name), sel))
		switch {
		case r.Health != "":
			b.WriteString("  " + app.Error.Render("! "+r.Health))
		case r.Installing:
			b.WriteString("  " + app.Highlight.Render("installing…"))
		case r.DevRunning:
			b.WriteString("  " + app.Success.Render("[dev]"))
		}
		b.WriteString("\n")
	}
	return b.String()
}
