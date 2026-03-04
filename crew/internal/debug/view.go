package debug

import (
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
)

// ── Messages ──

type debugContentMsg struct{ content string }
type tickDebugMsg time.Time

// ── Model ──

type View struct {
	viewport viewport.Model
	width    int
	height   int
	ready    bool
}

func NewView() View {
	return View{}
}

func (v View) Title() string {
	return "Debug Log"
}

func (v View) Init() tea.Cmd {
	return tea.Batch(readLog(), tickDebug())
}

func (v View) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		v.width = msg.Width
		v.height = msg.Height
		v.updateViewportSize()
		return v, nil

	case debugContentMsg:
		wasAtBottom := v.viewport.AtBottom()
		v.viewport.SetContent(msg.content)
		if wasAtBottom {
			v.viewport.GotoBottom()
		}
		return v, nil

	case tickDebugMsg:
		return v, tea.Batch(readLog(), tickDebug())

	case tea.KeyMsg:
		return v.handleKey(msg)
	}

	return v, nil
}

func (v *View) updateViewportSize() {
	// Account for: app title (3 lines) + help bar (2) = 5
	h := v.height - 5
	if h < 1 {
		h = 1
	}
	w := v.width - 4
	if w < 1 {
		w = 1
	}

	if !v.ready {
		v.viewport = viewport.New(w, h)
		v.ready = true
	} else {
		v.viewport.Width = w
		v.viewport.Height = h
	}
}

func (v View) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		return v, func() tea.Msg { return app.PopPageMsg{} }
	}

	var cmd tea.Cmd
	v.viewport, cmd = v.viewport.Update(msg)
	return v, cmd
}

func (v View) View() string {
	var b strings.Builder

	if v.ready {
		for _, line := range strings.Split(v.viewport.View(), "\n") {
			b.WriteString("  ")
			b.WriteString(line)
			b.WriteString("\n")
		}
	}

	b.WriteString("\n")
	b.WriteString("  ")
	b.WriteString(app.HelpStyle.Render("↑↓ scroll  esc back"))
	b.WriteString("\n")

	return b.String()
}

// ── Commands ──

func readLog() tea.Cmd {
	return func() tea.Msg {
		content := ReadTail(200)
		return debugContentMsg{content: strings.TrimRight(content, "\n")}
	}
}

func tickDebug() tea.Cmd {
	return tea.Tick(time.Second, func(t time.Time) tea.Msg {
		return tickDebugMsg(t)
	})
}
