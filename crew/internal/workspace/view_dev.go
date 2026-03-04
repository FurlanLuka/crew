package workspace

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// ── Messages ──

type devServersLoadedMsg struct{ items []devItem }
type devStartedMsg struct{ status string }
type devStoppedMsg struct{}

// ── Data ──

type devItem struct {
	ProjectName string
	Server      project.DevServer
	Running     bool
	URL         string
}

// ── Model ──

type DevView struct {
	wsName    string
	items     []devItem
	cursor    int
	loading   bool
	actionMsg string
	spinner   spinner.Model
	statusMsg string
	err       error
}

func NewDevView(wsName string) DevView {
	sp := spinner.New()
	sp.Spinner = spinner.Dot

	return DevView{
		wsName:  wsName,
		spinner: sp,
	}
}

func (v DevView) Title() string {
	return fmt.Sprintf("Dev Servers for \"%s\"", v.wsName)
}

func (v DevView) Init() tea.Cmd {
	return v.loadDevServers()
}

func (v DevView) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return v, nil

	case devServersLoadedMsg:
		v.items = msg.items
		if v.cursor >= len(v.items) {
			v.cursor = max(0, len(v.items)-1)
		}
		return v, nil

	case devStartedMsg:
		v.loading = false
		v.statusMsg = msg.status
		v.err = nil
		return v, v.loadDevServers()

	case devStoppedMsg:
		v.loading = false
		v.statusMsg = "Dev servers stopped"
		v.err = nil
		return v, v.loadDevServers()

	case errMsg:
		v.err = msg.err
		v.loading = false
		return v, nil

	case spinner.TickMsg:
		if v.loading {
			var cmd tea.Cmd
			v.spinner, cmd = v.spinner.Update(msg)
			return v, cmd
		}
		return v, nil

	case tea.KeyMsg:
		return v.handleKey(msg)
	}

	return v, nil
}

func (v DevView) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if v.loading {
		return v, nil
	}

	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		return v, func() tea.Msg { return app.PopPageMsg{} }
	case key.Matches(msg, app.Keys.Up):
		if v.cursor > 0 {
			v.cursor--
		}
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		if v.cursor < len(v.items)-1 {
			v.cursor++
		}
		return v, nil
	case msg.String() == "enter" || msg.String() == "l":
		running := v.runningItems()
		if len(running) == 0 {
			v.err = fmt.Errorf("no servers are running")
			return v, nil
		}
		initialTab := v.runningTabIndex()
		logs := NewLogsView(v.wsName, running, initialTab)
		return v, func() tea.Msg { return app.PushPageMsg{Page: logs} }
	case msg.String() == "S":
		v.loading = true
		v.actionMsg = "Starting dev servers..."
		v.statusMsg = ""
		v.err = nil
		return v, tea.Batch(v.spinner.Tick, v.startAllDevServers())
	case msg.String() == "X":
		v.loading = true
		v.actionMsg = "Stopping dev servers..."
		v.statusMsg = ""
		v.err = nil
		return v, tea.Batch(v.spinner.Tick, v.stopAllDevServers())
	}
	return v, nil
}

// ── View ──

func (v DevView) View() string {
	var b strings.Builder
	v.renderList(&b)
	return b.String()
}

func (v DevView) renderList(b *strings.Builder) {
	if len(v.items) == 0 {
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render("No dev servers configured. Add them via project settings."))
		b.WriteString("\n\n")
		b.WriteString("  ")
		b.WriteString(app.HelpStyle.Render("esc back"))
		b.WriteString("\n")
		return
	}

	currentProject := ""
	for i, item := range v.items {
		if item.ProjectName != currentProject {
			if currentProject != "" {
				b.WriteString("\n")
			}
			b.WriteString("  ")
			b.WriteString(app.Highlight.Render(item.ProjectName))
			b.WriteString("\n")
			currentProject = item.ProjectName
		}

		cursor := "    "
		if i == v.cursor {
			cursor = "  " + app.Selected.Render("> ")
		}

		name := item.Server.Name
		if i == v.cursor {
			name = app.Selected.Render(name)
		}

		port := fmt.Sprintf(":%d", item.Server.Port)
		status := app.Subtle.Render("stopped")
		if item.Running {
			status = app.Success.Render("running")
		}

		b.WriteString(cursor)
		b.WriteString(fmt.Sprintf("%-12s %-8s %-20s %s",
			name, port, app.Subtle.Render(item.Server.Command), status))
		if item.URL != "" {
			b.WriteString("  ")
			b.WriteString(app.Subtle.Render(item.URL))
		}
		b.WriteString("\n")
	}

	b.WriteString("\n")
	if v.loading {
		b.WriteString("  ")
		b.WriteString(v.spinner.View())
		b.WriteString(" ")
		b.WriteString(v.actionMsg)
		b.WriteString("\n\n")
	}
	if v.statusMsg != "" {
		b.WriteString("  ")
		b.WriteString(app.Success.Render(v.statusMsg))
		b.WriteString("\n\n")
	}
	if v.err != nil {
		b.WriteString("  ")
		b.WriteString(app.Error.Render(v.err.Error()))
		b.WriteString("\n\n")
	}

	b.WriteString("  ")
	b.WriteString(app.HelpStyle.Render("l logs  S start all  X stop all  esc back"))
	b.WriteString("\n")
}

// ── Commands ──

func (v DevView) loadDevServers() tea.Cmd {
	wsName := v.wsName
	return func() tea.Msg {
		ws, err := Load(wsName)
		if err != nil {
			return errMsg{err}
		}

		routes, _ := dev.LoadRoutes(wsName)
		host := dev.DetectLANIP()

		// Build running route lookup: port -> Route
		runningPorts := map[int]dev.Route{}
		for _, r := range routes {
			runningPorts[r.ExternalPort] = r
		}

		var items []devItem
		for _, wp := range ws.Projects {
			p := project.Get(wp.Name)
			if p == nil {
				continue
			}
			for _, ds := range p.DevServers {
				item := devItem{
					ProjectName: wp.Name,
					Server:      ds,
				}
				if r, ok := runningPorts[ds.Port]; ok {
					item.Running = true
					item.URL = fmt.Sprintf("http://%s.%s.nip.io:%d", r.Subdomain, host, r.ExternalPort)
				}
				items = append(items, item)
			}
		}
		return devServersLoadedMsg{items}
	}
}

func (v DevView) startAllDevServers() tea.Cmd {
	wsName := v.wsName
	return func() tea.Msg {
		if !exec.HasTmux() {
			return errMsg{fmt.Errorf("tmux not found — install with: brew install tmux")}
		}

		ws, err := Load(wsName)
		if err != nil {
			return errMsg{err}
		}

		host := dev.DetectLANIP()
		projects := BuildDevProjects(wsName, ws.Projects)

		if len(projects) == 0 {
			return errMsg{fmt.Errorf("no dev servers configured")}
		}

		routes, err := dev.Start(wsName, projects, host)
		if err != nil {
			return errMsg{err}
		}

		status := fmt.Sprintf("Started %d dev servers", len(routes))
		return devStartedMsg{status}
	}
}

func (v DevView) stopAllDevServers() tea.Cmd {
	wsName := v.wsName
	return func() tea.Msg {
		dev.StopAll(wsName)
		return devStoppedMsg{}
	}
}

func (v DevView) runningItems() []devItem {
	var running []devItem
	for _, item := range v.items {
		if item.Running {
			running = append(running, item)
		}
	}
	return running
}

// runningTabIndex maps the cursor position to an index in the running-only list.
func (v DevView) runningTabIndex() int {
	idx := 0
	for i, item := range v.items {
		if i == v.cursor {
			return idx
		}
		if item.Running {
			idx++
		}
	}
	return 0
}
