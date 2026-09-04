package workspace

import (
	"fmt"
	osexec "os/exec"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// ── Messages ──

type worktreeLoadedMsg struct {
	page worktreePage
}
type devStartedMsg struct{ status string }
type devStoppedMsg struct{}
type launchExecutedMsg struct{}

// claudeExecReadyMsg carries a Claude command to run directly in the current
// terminal. Claude takes over the terminal until it exits — no tmux, no
// session tracking, no reattach.
type claudeExecReadyMsg struct {
	cmd *osexec.Cmd
}

// ── Data ──

type devItem struct {
	ProjectName string
	Server      project.DevServer
	Running     bool
	Port        int
	URL         string
}

// worktreePage is everything the page shows, loaded in one go.
type worktreePage struct {
	Dir         string
	Session     string
	NoProxy     bool // how the running session was started, if any
	Items       []devItem
	Anomalies   string // FormatResolutions anomalies + FormatConflicts, "" when clean
	LeadProject string
	LeadBranch  string
	HasEditor   bool
	HasSSH      bool
}

type rowKind int

const (
	rowServer rowKind = iota
	rowLaunchEditor
	rowLaunchClaude
	rowOpenRemote
	rowOpenShell
)

// worktreeRow is one thing the cursor can land on.
type worktreeRow struct {
	Kind rowKind
	Item int // index into Items for rowServer
}

// worktreeRows is the cursor's path through the page. Pure.
func worktreeRows(items []devItem, hasEditor, hasSSH bool) []worktreeRow {
	var rows []worktreeRow
	for i := range items {
		rows = append(rows, worktreeRow{Kind: rowServer, Item: i})
	}
	if hasEditor {
		rows = append(rows, worktreeRow{Kind: rowLaunchEditor})
	}
	rows = append(rows, worktreeRow{Kind: rowLaunchClaude})
	if hasSSH {
		rows = append(rows, worktreeRow{Kind: rowOpenRemote})
	}
	rows = append(rows, worktreeRow{Kind: rowOpenShell})
	return rows
}

// ── Model ──

type WorktreeView struct {
	ref       Ref
	page      worktreePage
	rows      []worktreeRow
	cursor    int
	loading   bool
	actionMsg string
	spinner   spinner.Model
	statusMsg string
	err       error
	noProxy   bool
	// touchedProxy records that the user flipped p, so a reload does not
	// snap the toggle back to the running session's mode.
	touchedProxy bool
}

func NewWorktreeView(ref Ref) WorktreeView {
	return WorktreeView{ref: ref, spinner: app.NewSpinner(), noProxy: true}
}

func (v WorktreeView) Title() string {
	return v.ref.String()
}

func (v WorktreeView) Init() tea.Cmd {
	return v.load()
}

func (v WorktreeView) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return v, nil

	case worktreeLoadedMsg:
		v.page = msg.page
		v.rows = worktreeRows(msg.page.Items, msg.page.HasEditor, msg.page.HasSSH)
		v.cursor = min(v.cursor, max(0, len(v.rows)-1))
		// The toggle starts out matching the running session, so the header
		// never claims a mode the servers are not in.
		if msg.page.Session != "" && !v.touchedProxy {
			v.noProxy = msg.page.NoProxy
		}
		v.loading = false
		return v, nil

	case devStartedMsg:
		v.loading = false
		v.statusMsg = msg.status
		v.err = nil
		return v, v.load()

	case devStoppedMsg:
		v.loading = false
		v.statusMsg = "Stopped"
		v.err = nil
		return v, v.load()

	case launchExecutedMsg:
		return v, tea.Quit

	case claudeExecReadyMsg:
		return v, tea.ExecProcess(msg.cmd, func(err error) tea.Msg {
			if err != nil {
				return errMsg{err}
			}
			return launchExecutedMsg{}
		})

	case codeOpenedMsg:
		return v, func() tea.Msg { return app.ExitWithOutputMsg{Output: msg.output} }

	case errMsg:
		v.loading = false
		v.err = msg.err
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

func (v WorktreeView) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if v.loading {
		return v, nil
	}

	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		return v, func() tea.Msg { return app.PopPageMsg{} }
	case key.Matches(msg, app.Keys.Up):
		v.cursor = app.MoveCursor(v.cursor, -1, len(v.rows))
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		v.cursor = app.MoveCursor(v.cursor, 1, len(v.rows))
		return v, nil
	case msg.String() == "enter":
		return v.activate()
	case msg.String() == "l":
		return v.openLogs()
	case msg.String() == "s":
		return v.act("Starting dev servers...", v.runDevStart(false))
	case msg.String() == "r":
		return v.act("Restarting dev servers...", v.runDevStart(true))
	case msg.String() == "x":
		return v.act("Stopping dev servers...", v.stopAll())
	case msg.String() == "p":
		v.noProxy = !v.noProxy
		v.touchedProxy = true
		v.err = nil
		v.statusMsg = ""
		return v, nil
	}
	return v, nil
}

func (v WorktreeView) act(label string, cmd tea.Cmd) (tea.Model, tea.Cmd) {
	v.loading = true
	v.actionMsg = label
	v.statusMsg = ""
	v.err = nil
	return v, tea.Batch(v.spinner.Tick, cmd)
}

// activate does the obvious thing for the row under the cursor.
func (v WorktreeView) activate() (tea.Model, tea.Cmd) {
	if len(v.rows) == 0 {
		return v, nil
	}
	switch row := v.rows[v.cursor]; row.Kind {
	case rowServer:
		return v.openLogs()
	case rowLaunchEditor:
		return v.act("Launching editor + Claude...", v.launch(true))
	case rowLaunchClaude:
		return v.act("Launching Claude...", v.launch(false))
	case rowOpenRemote:
		return v, openCode(v.ref)
	case rowOpenShell:
		dir := v.page.Dir
		return v, func() tea.Msg { return app.ExitWithOutputMsg{Output: dir} }
	}
	return v, nil
}

func (v WorktreeView) openLogs() (tea.Model, tea.Cmd) {
	running := v.runningItems()
	if len(running) == 0 {
		v.err = fmt.Errorf("no servers are running")
		return v, nil
	}
	logs := NewLogsView(v.ref, running, v.runningTabIndex())
	return v, func() tea.Msg { return app.PushPageMsg{Page: logs} }
}

func (v WorktreeView) runningItems() []devItem {
	var running []devItem
	for _, item := range v.page.Items {
		if item.Running {
			running = append(running, item)
		}
	}
	return running
}

// runningTabIndex maps the cursor to its position among running servers, so
// the logs view opens on the server under the cursor when it is running.
func (v WorktreeView) runningTabIndex() int {
	if len(v.rows) == 0 || v.rows[v.cursor].Kind != rowServer {
		return 0
	}
	idx := 0
	for i, item := range v.page.Items {
		if i == v.rows[v.cursor].Item {
			return idx
		}
		if item.Running {
			idx++
		}
	}
	return 0
}

// ── View ──

func (v WorktreeView) View() string {
	var b strings.Builder
	renderWorktreePage(&b, v.page, v.rows, v.cursor, v.noProxy)

	if v.loading {
		b.WriteString("\n  ")
		b.WriteString(v.spinner.View())
		b.WriteString(" ")
		b.WriteString(v.actionMsg)
		b.WriteString("\n")
	}
	if v.statusMsg != "" {
		b.WriteString("\n  ")
		b.WriteString(app.Success.Render(v.statusMsg))
		b.WriteString("\n")
	}
	if v.err != nil {
		b.WriteString("\n  ")
		b.WriteString(app.Error.Render(v.err.Error()))
		b.WriteString("\n")
	}

	b.WriteString("\n  ")
	b.WriteString(app.HelpStyle.Render("enter act  s start all  r restart  x stop  l logs  p proxy  esc back"))
	b.WriteString("\n")
	return b.String()
}

// renderWorktreePage draws the page body. Pure over its inputs so the layout
// can be asserted as a whole.
func renderWorktreePage(b *strings.Builder, page worktreePage, rows []worktreeRow, cursor int, noProxy bool) {
	proxy := "on"
	if noProxy {
		proxy = "off"
	}
	fmt.Fprintf(b, "  %s\n", app.Subtle.Render(page.Dir))
	fmt.Fprintf(b, "  %s\n\n", app.Subtle.Render("proxy: "+proxy))

	selected := func(kind rowKind, item int) bool {
		return len(rows) > 0 && rows[cursor].Kind == kind && (kind != rowServer || rows[cursor].Item == item)
	}

	b.WriteString("  Servers")
	if page.Session != "" {
		b.WriteString("  " + app.Subtle.Render(page.Session))
	}
	b.WriteString("\n")

	if len(page.Items) == 0 {
		b.WriteString("    ")
		b.WriteString(app.Subtle.Render("none configured — crew dev add <project> …"))
		b.WriteString("\n")
	}
	width := 0
	for _, item := range page.Items {
		width = max(width, len(item.Server.Name))
	}
	for i, item := range page.Items {
		sel := selected(rowServer, i)
		b.WriteString("  " + app.RowPrefix(sel))
		b.WriteString(app.RowName(fmt.Sprintf("%-*s", width, item.Server.Name), sel))
		if item.Running {
			fmt.Fprintf(b, "  %s :%d   %s", app.Success.Render("●"), item.Port, app.Subtle.Render(item.URL))
		} else {
			fmt.Fprintf(b, "  %s %s", app.Subtle.Render("○"), app.Subtle.Render("stopped"))
		}
		b.WriteString("\n")
	}

	if page.Anomalies != "" {
		b.WriteString("\n")
		for _, line := range strings.Split(strings.TrimRight(page.Anomalies, "\n"), "\n") {
			b.WriteString("  " + app.Highlight.Render(line) + "\n")
		}
	}

	b.WriteString("\n  Launch\n")
	if page.HasEditor {
		sel := selected(rowLaunchEditor, 0)
		b.WriteString("  " + app.RowPrefix(sel))
		b.WriteString(app.RowName(fmt.Sprintf("%-28s", "Editor + Claude"), sel))
		b.WriteString(app.Subtle.Render(leadHint(page)))
		b.WriteString("\n")
	}
	sel := selected(rowLaunchClaude, 0)
	b.WriteString("  " + app.RowPrefix(sel))
	b.WriteString(app.RowName(fmt.Sprintf("%-28s", "Claude in terminal"), sel))
	if !page.HasEditor {
		b.WriteString(app.Subtle.Render(leadHint(page)))
	}
	b.WriteString("\n")

	b.WriteString("\n  Open\n")
	if page.HasSSH {
		sel := selected(rowOpenRemote, 0)
		b.WriteString("  " + app.RowPrefix(sel))
		b.WriteString(app.RowName("Cursor / VS Code (remote)", sel))
		b.WriteString("\n")
	}
	sel = selected(rowOpenShell, 0)
	b.WriteString("  " + app.RowPrefix(sel))
	b.WriteString(app.RowName("Shell here", sel))
	b.WriteString("\n")
}

func leadHint(page worktreePage) string {
	if page.LeadProject == "" {
		return ""
	}
	if page.LeadBranch == "" {
		return page.LeadProject
	}
	return page.LeadProject + " · " + page.LeadBranch
}

// ── Commands ──

func (v WorktreeView) load() tea.Cmd {
	ref := v.ref
	return func() tea.Msg {
		res, err := Resolve(ref)
		if err != nil {
			return errMsg{err}
		}
		return worktreeLoadedMsg{page: loadWorktreePage(res)}
	}
}

// loadWorktreePage gathers everything the page shows: configured servers
// joined to what is running, and the same anomalies `crew dev start` prints,
// so the page tells you before you start anything.
func loadWorktreePage(res *Resolved) worktreePage {
	routes, _ := dev.LoadRoutes(res.Slug)
	settings := config.LoadSettings()
	domain := settings.GetDomain(dev.ResolveHostIP())
	proxyPort := settings.GetProxyPort()

	running := map[dev.ProjectServer]dev.Route{}
	for _, r := range routes {
		running[dev.ProjectServer{Project: r.Project, Server: r.ServerName}] = r
	}

	var items []devItem
	for _, p := range res.Projects {
		for _, ds := range p.DevServers {
			item := devItem{ProjectName: p.Name, Server: ds}
			if r, ok := running[dev.ProjectServer{Project: p.Name, Server: ds.Name}]; ok {
				item.Running = true
				item.Port = r.InternalPort
				item.URL = dev.RouteURL(r, res.Slug, domain, proxyPort)
			}
			items = append(items, item)
		}
	}

	projects := res.DevProjects()
	resolutions := dev.ResolveBindings(res.ResolveParams(dev.IndexRoutePorts(routes)))
	anomalies := dev.FormatAnomalies(resolutions) +
		dev.FormatConflicts(dev.InspectEnvConflicts(res.Slug, projects, dev.PlannedFromRoutes(projects, routes), resolutions))

	page := worktreePage{
		Dir:       res.Dir,
		Items:     items,
		Anomalies: strings.TrimLeft(anomalies, "\n"),
		HasEditor: exec.DetectEditor() != "",
		HasSSH:    settings.SSHHost != "",
	}
	if len(routes) > 0 {
		page.Session = dev.SessionName(res.Slug)
		page.NoProxy = routes[0].NoProxy
	}
	if len(res.Projects) > 0 {
		page.LeadProject = res.Projects[0].Name
		page.LeadBranch = currentBranch(res.Projects[0].Path)
	}
	return page
}

func (v WorktreeView) runDevStart(restart bool) tea.Cmd {
	ref := v.ref
	noProxy := v.noProxy
	return func() tea.Msg {
		res, err := Resolve(ref)
		if err != nil {
			return errMsg{err}
		}
		result, err := StartDev(res, noProxy, restart)
		if err != nil {
			return errMsg{err}
		}
		verb := "Started"
		if restart {
			verb = "Restarted"
		}
		return devStartedMsg{fmt.Sprintf("%s %d dev servers", verb, len(result.Routes))}
	}
}

func (v WorktreeView) stopAll() tea.Cmd {
	ref := v.ref
	return func() tea.Msg {
		dev.StopAll(ref.Slug())
		dev.StopProxyIfIdle()
		return devStoppedMsg{}
	}
}

func (v WorktreeView) launch(withEditor bool) tea.Cmd {
	ref := v.ref
	return func() tea.Msg {
		res, err := Resolve(ref)
		if err != nil {
			return errMsg{err}
		}
		if len(res.Projects) == 0 {
			return errMsg{fmt.Errorf("workspace '%s' has no projects", ref)}
		}
		if withEditor {
			editor := exec.DetectEditor()
			if editor == "" {
				return errMsg{fmt.Errorf("no editor detected — install VS Code or Cursor")}
			}
			return launchWithEditor(res, editor)
		}
		return launchClaude(res)
	}
}

// launchWithEditor opens the worktree in the editor with a Claude task wired
// up. A multi-project worktree runs one flat Claude at the worktree root with
// every project exposed via --add-dir; a single-project worktree starts in the
// project itself and needs no orientation prompt.
func launchWithEditor(res *Resolved, editor string) tea.Msg {
	if err := LaunchEditor(res, editor); err != nil {
		return errMsg{err}
	}
	return launchExecutedMsg{}
}

// launchClaude runs Claude for the worktree directly in the current terminal
// via tea.ExecProcess — no tmux, no session tracking.
func launchClaude(res *Resolved) tea.Msg {
	cmd, err := ClaudeCommand(res)
	if err != nil {
		return errMsg{err}
	}
	return claudeExecReadyMsg{cmd: cmd}
}
