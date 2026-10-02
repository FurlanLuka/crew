package workspace

import (
	"fmt"
	"os"
	osexec "os/exec"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// The worktree page is the terminal's one job left: launching Claude or an
// editor on a worktree. Its servers show read-only; starting, stopping,
// verifying and fixing are crew's page in the browser (or the commands the
// manage line names).

// ── Messages ──

type errMsg struct{ err error }

// codeOpenedMsg carries the remote-editor links crew open printed.
type codeOpenedMsg struct{ output string }

// recheckMsg: look again while runners are still installing.
type recheckMsg struct{}

// pageRecheck is how often the page looks again while runners are alive.
const pageRecheck = 2 * time.Second

type worktreeLoadedMsg struct {
	page worktreePage
}
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

// portLabel is the port the server runs on, or that it has none to reach.
func (d devItem) portLabel() string {
	if !d.Server.Listens() {
		return "no port"
	}
	return fmt.Sprintf(":%d", d.Port)
}

// worktreePage is everything the page shows, loaded in one go.
type worktreePage struct {
	Ref       Ref
	Dir       string
	Session   string
	Items     []devItem
	Anomalies string // FormatResolutions anomalies + FormatConflicts, "" when clean
	Health    *Health
	// Setup is the runners' progress while any is alive — the page's
	// "installing" state; nil once they are done or when none ran. Now is
	// when it was read, so a running step's elapsed time renders from it.
	Setup       *Status
	Now         time.Time
	LeadProject string
	LeadBranch  string
	HasEditor   bool
	HasSSH      bool
	// ManageURL is crew's page, without its sign-in token; "" when the
	// server is not running.
	ManageURL string
}

type rowKind int

const (
	rowLaunchEditor rowKind = iota
	rowLaunchClaude
	rowOpenRemote
	rowOpenShell
)

// worktreeRows is the cursor's path through the page: launching only. Pure.
func worktreeRows(hasEditor, hasSSH bool) []rowKind {
	var rows []rowKind
	if hasEditor {
		rows = append(rows, rowLaunchEditor)
	}
	rows = append(rows, rowLaunchClaude)
	if hasSSH {
		rows = append(rows, rowOpenRemote)
	}
	return append(rows, rowOpenShell)
}

// ── Model ──

type WorktreeView struct {
	ref       Ref
	manageURL string
	page      worktreePage
	rows      []rowKind
	cursor    int
	loading   bool
	actionMsg string
	spinner   spinner.Model
	statusMsg string
	err       error
}

// NewWorktreeView opens the page on ref; manageURL is crew's page (the
// caller knows the server, this package does not).
func NewWorktreeView(ref Ref, manageURL string) WorktreeView {
	return WorktreeView{ref: ref, manageURL: manageURL, spinner: app.NewSpinner()}
}

// Ref is the worktree the page is on.
func (v WorktreeView) Ref() Ref { return v.ref }

func (v WorktreeView) Title() string {
	return v.ref.String()
}

func (v WorktreeView) Init() tea.Cmd {
	return v.load()
}

func (v WorktreeView) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case worktreeLoadedMsg:
		v.page = msg.page
		v.rows = worktreeRows(msg.page.HasEditor, msg.page.HasSSH)
		// The hint about a refused key is over once the runners are.
		if v.statusMsg == installingMsg && !msg.page.installing() {
			v.statusMsg = ""
		}
		v.cursor = min(v.cursor, max(0, len(v.rows)-1))
		v.loading = false
		if msg.page.installing() {
			return v, tea.Tick(pageRecheck, func(time.Time) tea.Msg { return recheckMsg{} })
		}
		return v, nil

	case recheckMsg:
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

// installing: runners are alive on the worktree, so the checkout may not be
// there yet — launching waits; logs and the shell stay live.
func (p worktreePage) installing() bool { return p.Setup != nil && p.Setup.Running() }

const installingMsg = "installing — l runner logs, esc leaves it running"

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
	case msg.String() == "o":
		return v.activateRow(rowOpenShell)
	case msg.String() == "l":
		return v.openLogs()
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
	return v.activateRow(v.rows[v.cursor])
}

func (v WorktreeView) activateRow(kind rowKind) (tea.Model, tea.Cmd) {
	if v.page.installing() && kind != rowOpenShell {
		v.statusMsg, v.err = installingMsg, nil
		return v, nil
	}
	switch kind {
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
	// While runners are alive their logs are the ones to read — what an
	// install is printing right now.
	if v.page.installing() {
		var projects []string
		for _, p := range v.page.Setup.Projects {
			projects = append(projects, p.Project)
		}
		logs := NewSetupLogsView(v.ref, projects)
		return v, func() tea.Msg { return app.PushPageMsg{Page: logs} }
	}
	items := v.loggedItems()
	if len(items) == 0 {
		v.err = fmt.Errorf("no server has run yet")
		return v, nil
	}
	logs := NewLogsView(v.ref, items, 0)
	return v, func() tea.Msg { return app.PushPageMsg{Page: logs} }
}

// loggedItems is every server that is running or has a log file — a dead
// server's smoke output is worth reading too.
func (v WorktreeView) loggedItems() []devItem {
	var out []devItem
	for _, item := range v.page.Items {
		if item.Running || fileExists(dev.LogFile(v.ref.Slug(), item.Server.Name)) || fileExists(smokeLogFile(v.ref.Slug(), item.ProjectName, item.Server.Name)) {
			out = append(out, item)
		}
	}
	return out
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// ── Commands ──

func (v WorktreeView) load() tea.Cmd {
	ref, manageURL := v.ref, v.manageURL
	return func() tea.Msg {
		res, err := Resolve(ref)
		if err != nil {
			return errMsg{err}
		}
		page := loadWorktreePage(res)
		page.ManageURL = manageURL
		return worktreeLoadedMsg{page: page}
	}
}

// loadWorktreePage gathers everything the page shows: configured servers
// joined to what is running, and the same anomalies `crew dev start` prints.
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
		Ref:       res.Ref,
		Dir:       res.Dir,
		Items:     items,
		Setup:     liveSetup(res.Ref),
		Now:       time.Now(),
		Anomalies: strings.TrimLeft(anomalies, "\n"),
		Health:    res.Health,
		HasEditor: exec.DetectEditor() != "",
		HasSSH:    settings.SSHHost != "",
	}
	if len(routes) > 0 {
		page.Session = dev.SessionName(res.Slug)
	}
	if len(res.Projects) > 0 {
		page.LeadProject = res.Projects[0].Name
		page.LeadBranch = currentBranch(res.Projects[0].Path)
	}
	return page
}

// liveSetup is the runners' status while any is alive, nil otherwise.
func liveSetup(ref Ref) *Status {
	st, err := SetupStatus(ref)
	if err != nil || !st.Running() {
		return nil
	}
	return &st
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
// up and the orientation prompt written — LaunchEditor, the one crew edit
// uses.
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

func openCode(ref Ref) tea.Cmd {
	return func() tea.Msg {
		settings := config.LoadSettings()
		if settings.SSHHost == "" {
			return errMsg{fmt.Errorf("ssh_host not configured — crew config set ssh_host <host>")}
		}

		res, err := Resolve(ref)
		if err != nil {
			return errMsg{err}
		}

		links, err := EditorLinks(res, settings.SSHHost)
		if err != nil {
			return errMsg{err}
		}
		return codeOpenedMsg{output: links}
	}
}
