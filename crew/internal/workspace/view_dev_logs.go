package workspace

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

// ── Messages ──

type paneContentMsg struct{ content string }
type tickLogsMsg time.Time
type serverRestartedMsg struct{}

// ── Data ──

type logTab struct {
	label   string   // display name ("api", "web", "proxy", "urls")
	window  string   // tmux window name ("<ws>/api") — empty for urls/proxy tab
	file    string   // a log file to tail instead of a pane — a setup runner's
	stopped []string // logs to read when the pane is gone: the dev log, then the last smoke's
	isURLs  bool     // true for the URLs overview tab
	isProxy bool     // true for the proxy logs tab
}

// ── Model ──

type LogsView struct {
	ref      Ref
	session  string
	tabs     []logTab
	tabIdx   int
	viewport viewport.Model
	width    int
	height   int
	ready    bool
}

func NewLogsView(ref Ref, items []devItem, initialIdx int) LogsView {
	session := dev.SessionName(ref.Slug())

	var tabs []logTab
	for _, item := range items {
		tabs = append(tabs, logTab{
			label:   item.Server.Name,
			window:  fmt.Sprintf("%s/%s", ref.Slug(), item.Server.Name),
			stopped: []string{dev.LogFile(ref.Slug(), item.Server.Name), smokeLogFile(ref.Slug(), item.ProjectName, item.Server.Name)},
		})
	}
	tabs = append(tabs, logTab{label: "proxy", isProxy: true})
	tabs = append(tabs, logTab{label: "urls", isURLs: true})

	tabIdx := initialIdx
	if tabIdx >= len(tabs) {
		tabIdx = 0
	}

	return LogsView{
		ref:     ref,
		session: session,
		tabs:    tabs,
		tabIdx:  tabIdx,
	}
}

// NewSetupLogsView is the logs view over the setup runners' logs, one tab
// per project: what each install is printing right now.
func NewSetupLogsView(ref Ref, projects []string) LogsView {
	var tabs []logTab
	for _, p := range projects {
		tabs = append(tabs, logTab{label: p, file: RunnerLogFile(ref, p)})
	}
	return LogsView{ref: ref, tabs: tabs}
}

func (v LogsView) Title() string {
	return fmt.Sprintf("Logs — %s", v.ref)
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
		wasAtBottom := v.viewport.AtBottom()
		v.viewport.SetContent(msg.content)
		if wasAtBottom {
			v.viewport.GotoBottom()
		}
		return v, nil

	case tickLogsMsg:
		return v, tea.Batch(v.capturePane(), tickLogs())

	case serverRestartedMsg:
		return v, nil

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
	case msg.String() == "r":
		if v.tabs[v.tabIdx].isURLs || v.tabs[v.tabIdx].file != "" {
			return v, nil
		}
		if v.tabs[v.tabIdx].isProxy {
			return v, v.restartProxy()
		}
		return v, v.restartServer()
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
	if v.tabs[v.tabIdx].file != "" {
		b.WriteString(app.HelpStyle.Render("tab switch  ↑↓ scroll  esc back"))
	} else {
		b.WriteString(app.HelpStyle.Render("r restart  tab switch  ↑↓ scroll  esc back"))
	}
	b.WriteString("\n")

	return b.String()
}

// ── Commands ──

func (v LogsView) restartProxy() tea.Cmd {
	return func() tea.Msg {
		crewExec.TmuxRestartLastCommand(dev.ProxySessionName)
		return serverRestartedMsg{}
	}
}

func (v LogsView) restartServer() tea.Cmd {
	target := fmt.Sprintf("%s:%s", v.session, v.tabs[v.tabIdx].window)
	return func() tea.Msg {
		crewExec.TmuxRestartLastCommand(target)
		return serverRestartedMsg{}
	}
}

func (v LogsView) capturePane() tea.Cmd {
	tab := v.tabs[v.tabIdx]

	if tab.file != "" {
		file := tab.file
		return func() tea.Msg {
			data, err := os.ReadFile(file)
			if err != nil {
				return paneContentMsg{content: "(nothing yet)"}
			}
			return paneContentMsg{content: strings.TrimRight(string(data), "\n")}
		}
	}

	if tab.isURLs {
		ref := v.ref
		return func() tea.Msg {
			return paneContentMsg{content: buildURLsContent(ref)}
		}
	}

	if tab.isProxy {
		return func() tea.Msg {
			content, _ := crewExec.CaptureTmuxPane(dev.ProxySessionName, "0", 500)
			return paneContentMsg{content: strings.TrimRight(content, "\n")}
		}
	}

	session, window, stopped := v.session, tab.window, tab.stopped
	return func() tea.Msg {
		content, err := crewExec.CaptureTmuxPane(session, window, 500)
		if err != nil || strings.TrimSpace(content) == "" {
			// No pane: the server is stopped. Its log file is what a smoke or
			// a crash left behind, and the reason to open logs on a dead one.
			for _, logFile := range stopped {
				if data, readErr := os.ReadFile(logFile); readErr == nil {
					content = "(stopped — last log)\n" + string(data)
					break
				}
			}
		}
		return paneContentMsg{content: strings.TrimRight(content, "\n")}
	}
}

func buildURLsContent(ref Ref) string {
	settings := config.LoadSettings()
	host := dev.ResolveHostIP()
	domain := settings.GetDomain(host)
	proxyPort := settings.GetProxyPort()

	allRoutes, _ := dev.ListAllRoutes()

	var b strings.Builder
	b.WriteString("Service URLs\n")
	b.WriteString(strings.Repeat("─", 40))
	b.WriteString("\n\n")

	found := false
	for _, wr := range allRoutes {
		if wr.Slug != ref.Slug() {
			continue
		}
		for _, r := range wr.Routes {
			url := dev.RouteURL(r, wr.Slug, domain, proxyPort)
			b.WriteString(fmt.Sprintf("  %-12s %s\n", r.ServerName, url))
			found = true
		}
	}
	if !found {
		b.WriteString("  No servers running\n")
	}

	var others []dev.WsRoutes
	for _, wr := range allRoutes {
		if wr.Slug != ref.Slug() {
			others = append(others, wr)
		}
	}
	if len(others) > 0 {
		b.WriteString("\nOther workspaces\n")
		b.WriteString(strings.Repeat("─", 40))
		b.WriteString("\n\n")
		for _, wr := range others {
			for _, r := range wr.Routes {
				url := dev.RouteURL(r, wr.Slug, domain, proxyPort)
				b.WriteString(fmt.Sprintf("  %-12s %-12s %s\n", dev.DisplayRef(wr.Slug), r.ServerName, url))
			}
		}
	}

	return b.String()
}

func tickLogs() tea.Cmd {
	return tea.Tick(time.Second, func(t time.Time) tea.Msg {
		return tickLogsMsg(t)
	})
}
