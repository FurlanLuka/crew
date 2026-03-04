package workspace

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/exec"
)

// ── Messages ──

type paneContentMsg struct{ content string }
type tickLogsMsg time.Time

// ── Data ──

type logTab struct {
	label  string // display name ("api", "web", "proxy")
	window string // tmux window name ("<ws>/api", "proxy")
}

// ── Model ──

type LogsView struct {
	wsName   string
	session  string
	tabs     []logTab
	tabIdx   int
	viewport viewport.Model
	width    int
	height   int
	ready    bool
}

func NewLogsView(wsName string, items []devItem, initialIdx int) LogsView {
	session := "crew-dev-" + wsName

	var tabs []logTab
	for _, item := range items {
		tabs = append(tabs, logTab{
			label:  item.Server.Name,
			window: fmt.Sprintf("%s/%s", wsName, item.Server.Name),
		})
	}
	tabs = append(tabs, logTab{label: "proxy", window: "proxy"})

	tabIdx := initialIdx
	if tabIdx >= len(tabs) {
		tabIdx = 0
	}

	return LogsView{
		wsName:  wsName,
		session: session,
		tabs:    tabs,
		tabIdx:  tabIdx,
	}
}

func (v LogsView) Title() string {
	return fmt.Sprintf("Logs — %s", v.wsName)
}

func (v LogsView) Init() tea.Cmd {
	return tea.Batch(v.capturePane(), tickLogs())
}

func (v LogsView) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		v.width = msg.Width
		v.height = msg.Height
		v.updateViewportSize()
		return v, nil

	case paneContentMsg:
		v.viewport.SetContent(msg.content)
		v.viewport.GotoBottom()
		return v, nil

	case tickLogsMsg:
		return v, tea.Batch(v.capturePane(), tickLogs())

	case tea.KeyMsg:
		return v.handleKey(msg)
	}

	return v, nil
}

func (v *LogsView) updateViewportSize() {
	// Account for: app title (3 lines) + tab bar (1) + blank (1) + help bar (2) = 7
	h := v.height - 7
	if h < 1 {
		h = 1
	}
	w := v.width - 4 // left padding
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

func (v LogsView) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		return v, func() tea.Msg { return app.PopPageMsg{} }
	case msg.String() == "tab" || msg.String() == "right" || msg.String() == "l":
		v.tabIdx = (v.tabIdx + 1) % len(v.tabs)
		return v, v.capturePane()
	case msg.String() == "shift+tab" || msg.String() == "left" || msg.String() == "h":
		v.tabIdx = (v.tabIdx - 1 + len(v.tabs)) % len(v.tabs)
		return v, v.capturePane()
	}

	// Forward to viewport for scrolling
	var cmd tea.Cmd
	v.viewport, cmd = v.viewport.Update(msg)
	return v, cmd
}

// ── View ──

func (v LogsView) View() string {
	var b strings.Builder

	// Tab bar
	b.WriteString("  ")
	for i, tab := range v.tabs {
		if i == v.tabIdx {
			b.WriteString(app.Selected.Render("[" + tab.label + "]"))
		} else {
			b.WriteString(app.Subtle.Render(" " + tab.label + " "))
		}
		b.WriteString(" ")
	}
	b.WriteString("\n\n")

	// Viewport
	if v.ready {
		// Indent each line of viewport content
		for _, line := range strings.Split(v.viewport.View(), "\n") {
			b.WriteString("  ")
			b.WriteString(line)
			b.WriteString("\n")
		}
	}

	b.WriteString("\n")
	b.WriteString("  ")
	b.WriteString(app.HelpStyle.Render("tab switch  ↑↓ scroll  esc back"))
	b.WriteString("\n")

	return b.String()
}

// ── Commands ──

func (v LogsView) capturePane() tea.Cmd {
	session := v.session
	window := v.tabs[v.tabIdx].window
	return func() tea.Msg {
		content, _ := exec.CaptureTmuxPane(session, window, 500)
		return paneContentMsg{content: strings.TrimRight(content, "\n")}
	}
}

func tickLogs() tea.Cmd {
	return tea.Tick(time.Second, func(t time.Time) tea.Msg {
		return tickLogsMsg(t)
	})
}
