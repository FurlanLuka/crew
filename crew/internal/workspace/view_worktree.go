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

// ── Messages ──

// recheckMsg: look at the servers started a moment ago again.
type recheckMsg struct{}

// pageRecheck is how often the page looks again while servers are still
// coming up after a start.
const pageRecheck = 2 * time.Second

type worktreeLoadedMsg struct {
	page worktreePage
}
type devStartedMsg struct{ status string }
type devStoppedMsg struct{}
type launchExecutedMsg struct{}

// verifyStartedMsg: the verify's runners are up; the page follows them.
type verifyStartedMsg struct{}

// checkPassedMsg: the check this page was opened on passed and its target
// is gone; the page leaves with the verdict.
type checkPassedMsg struct{ project string }

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
	// Check is what the smoke's look at the running server found — nil
	// until it has had time to settle after a start.
	Check *SmokeResult
}

// checked is the check's verdict, SmokeOK until there is one.
func (d devItem) checked() SmokeState {
	if d.Check == nil {
		return SmokeOK
	}
	return d.Check.State()
}

// worktreePage is everything the page shows, loaded in one go.
type worktreePage struct {
	Dir       string
	Session   string
	NoProxy   bool // how the running session was started, if any
	Items     []devItem
	Anomalies string // FormatResolutions anomalies + FormatConflicts, "" when clean
	Health    *Health
	// CheckHealth is what the running servers' check found, never written:
	// f hands it to Claude, a plain start still records nothing.
	CheckHealth *Health
	// Settling: the servers were started less than the smoke ceiling ago, so
	// a referenced one that is not listening yet is "starting", not a
	// verdict — the page keeps looking until it is.
	Settling bool
	// Setup is the runners' progress while any is alive — the page's
	// "installing" state; nil once they are done or when none ran. Now is
	// when it was read, so a running step's elapsed time renders from it.
	Setup       *Status
	Now         time.Time
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
	// confirmVerify: a verify restarts running servers, so it asks first.
	confirmVerify bool
	// startedAt: when the page last started the servers; drives Settling.
	startedAt time.Time
}

// settling: within the smoke ceiling of a start the page has made.
func (v WorktreeView) settling() bool {
	return !v.startedAt.IsZero() && time.Since(v.startedAt) < SmokeCeiling
}

func NewWorktreeView(ref Ref) WorktreeView {
	return WorktreeView{ref: ref, spinner: app.NewSpinner(), noProxy: true}
}

// SetStatus is the line the page opens with — what creation just did.
func (v *WorktreeView) SetStatus(msg string) { v.statusMsg = msg }

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
		// The hint about a refused key is over once the runners are.
		if v.statusMsg == installingMsg && !msg.page.installing() {
			v.statusMsg = ""
		}
		v.cursor = min(v.cursor, max(0, len(v.rows)-1))
		// The toggle starts out matching the running session, so the header
		// never claims a mode the servers are not in.
		if msg.page.Session != "" && !v.touchedProxy {
			v.noProxy = msg.page.NoProxy
		}
		v.loading = false
		// Still starting, or still installing? Look again in a moment.
		if (msg.page.Settling && msg.page.anyStarting()) || msg.page.installing() {
			return v, tea.Tick(pageRecheck, func(time.Time) tea.Msg { return recheckMsg{} })
		}
		return v, nil

	case devStartedMsg:
		v.loading = false
		v.statusMsg = msg.status
		v.err = nil
		v.startedAt = time.Now()
		// Rows first; the checks follow every couple of seconds until every
		// server has a verdict or the ceiling passes.
		return v, tea.Batch(v.loadWith(false), tea.Tick(pageRecheck, func(time.Time) tea.Msg { return recheckMsg{} }))

	case recheckMsg:
		return v, v.load()

	case devStoppedMsg:
		v.loading = false
		v.statusMsg = "Stopped"
		v.err = nil
		return v, v.load()

	case launchExecutedMsg:
		return v, tea.Quit

	case verifyStartedMsg:
		v.loading = false
		v.statusMsg = "verifying — one runner per project; esc leaves them running"
		return v, v.load()

	case checkPassedMsg:
		return v, func() tea.Msg {
			return app.ExitWithOutputMsg{Output: CheckPassedLine(msg.project)}
		}

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

// locked: something is recorded on the worktree, so the rows that would
// start servers or launch on it wait for a verify. Reading logs, opening a
// shell and fixing stay live — that is how it gets unlocked.
func (v WorktreeView) locked() bool { return v.page.Health != nil }

// installing: runners are alive on the worktree. Start and launch wait —
// the checkout may not be there yet — while logs, shell and fix (on what
// is recorded so far) stay live. esc leaves the runners going.
func (p worktreePage) installing() bool { return p.Setup != nil && p.Setup.Running() }

const (
	lockedMsg     = "locked — f fix with Claude, v verify"
	installingMsg = "installing — l runner logs, esc leaves it running"
)

// gatedWhileLocked is which rows a locked page refuses to act on.
func gatedWhileLocked(kind rowKind) bool { return kind != rowOpenShell && kind != rowServer }

func (v WorktreeView) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if v.loading {
		return v, nil
	}
	if v.confirmVerify {
		return v.handleConfirmVerifyKey(msg)
	}
	if v.page.installing() && v.refusedWhileInstalling(msg) {
		v.statusMsg, v.err = installingMsg, nil
		return v, nil
	}
	if v.locked() && v.refusedWhileLocked(msg) {
		v.statusMsg, v.err = lockedMsg, nil
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
	case msg.String() == "v":
		if v.page.Session != "" {
			v.confirmVerify = true
			return v, nil
		}
		return v.act("starting the verify…", v.runVerify())
	case msg.String() == "f" && (v.page.Health != nil || v.page.CheckHealth != nil):
		return v, v.runFix()
	}
	return v, nil
}

func (v WorktreeView) handleConfirmVerifyKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	v.confirmVerify = false
	if msg.String() == "y" || msg.String() == "Y" {
		return v.act("stopping the servers, starting the verify…", v.runVerify())
	}
	return v, nil
}

// refusedWhileInstalling: everything that would touch a checkout a runner
// is still making — start, stop, verify, and enter on a launch row.
func (v WorktreeView) refusedWhileInstalling(msg tea.KeyMsg) bool {
	return msg.String() == "v" || v.refusedWhileLocked(msg)
}

// refusedWhileLocked: the start/stop keys, and enter on a gated row.
func (v WorktreeView) refusedWhileLocked(msg tea.KeyMsg) bool {
	switch msg.String() {
	case "s", "r", "x":
		return true
	case "enter":
		return len(v.rows) > 0 && gatedWhileLocked(v.rows[v.cursor].Kind)
	}
	return false
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
	return v.activateRow(v.rows[v.cursor].Kind)
}

func (v WorktreeView) activateRow(kind rowKind) (tea.Model, tea.Cmd) {
	switch kind {
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
	logs := NewLogsView(v.ref, items, v.loggedTabIndex())
	return v, func() tea.Msg { return app.PushPageMsg{Page: logs} }
}

// loggedItems is every server that is running or has a log file — a dead
// server's smoke output is what you read on a locked page.
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

// loggedTabIndex maps the cursor to its position among the servers the logs
// view lists, so it opens on the server under the cursor.
func (v WorktreeView) loggedTabIndex() int {
	if len(v.rows) == 0 || v.rows[v.cursor].Kind != rowServer {
		return 0
	}
	want := v.page.Items[v.rows[v.cursor].Item].Server.Name
	for i, item := range v.loggedItems() {
		if item.Server.Name == want {
			return i
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

	if v.confirmVerify {
		b.WriteString("\n  " + app.Highlight.Render("Servers are running; verify restarts them. (y/n)") + "\n")
		return b.String()
	}
	b.WriteString("\n  ")
	help := "enter act  s start all  r restart  x stop  l logs  p proxy  v verify"
	switch {
	case v.page.installing():
		help = "l runner logs  o shell"
		if v.page.Health != nil {
			help = "f fix what failed so far  " + help
		}
	case v.locked():
		help = "f fix  v verify  l logs  o shell  p proxy"
	case v.page.CheckHealth != nil:
		help = "f fix with Claude  " + help
	}
	b.WriteString(app.HelpStyle.Render(help + "  esc back"))
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
	fmt.Fprintf(b, "  %s\n", app.Subtle.Render("proxy: "+proxy))

	// What is recorded comes first: it is the reason the rest is locked.
	// While runners are alive, their table — the failures so far are in the
	// health block above it.
	locked := page.Health != nil || page.installing()
	renderHealth(b, page.Health, page.installing())
	if page.installing() {
		b.WriteString("\n  " + app.Highlight.Render("installing") + app.Subtle.Render(" · one runner per project") + "\n")
		b.WriteString(RenderSetupTable(*page.Setup, spinnerFrame, page.Now))
	}
	b.WriteString("\n")

	selected := func(kind rowKind, item int) bool {
		return len(rows) > 0 && rows[cursor].Kind == kind && (kind != rowServer || rows[cursor].Item == item)
	}
	// name renders a row label; on a locked page everything but the shell
	// is dimmed — servers too, though enter on one still opens its log.
	name := func(label string, kind rowKind, sel bool) string {
		if locked && kind != rowOpenShell {
			return app.Subtle.Render(label)
		}
		return app.RowName(label, sel)
	}
	lockedTag := func(section string) string {
		switch {
		case page.installing():
			return section + "  " + app.Subtle.Render("after the install")
		case locked:
			return section + "  " + app.Subtle.Render("locked until verified")
		}
		return section
	}

	b.WriteString("  " + lockedTag("Servers"))
	if page.Session != "" && !locked {
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
		b.WriteString(name(fmt.Sprintf("%-*s", width, item.Server.Name), rowServer, sel))
		switch {
		case item.checked() == SmokeDied:
			fmt.Fprintf(b, "  %s :%d   %s", app.Error.Render("✗ died"), item.Port, app.Subtle.Render(firstLine(item.Check.Tail)))
		case item.checked() == SmokeUnreached && page.Settling:
			fmt.Fprintf(b, "  %s :%d   %s", app.Highlight.Render("● starting…"), item.Port, app.Subtle.Render(item.URL))
		case item.checked() == SmokeUnreached:
			fmt.Fprintf(b, "  %s :%d   %s", app.Error.Render("! not listening"), item.Port, app.Subtle.Render("something points at it"))
		case item.checked() == SmokeIdle:
			fmt.Fprintf(b, "  %s :%d   %s", app.Highlight.Render("● not listening"), item.Port, app.Subtle.Render("nothing points at it"))
		case item.Running:
			fmt.Fprintf(b, "  %s :%d   %s", app.Success.Render("●"), item.Port, app.Subtle.Render(item.URL))
		case locked:
			fmt.Fprintf(b, "  %s", app.Subtle.Render("○"))
		default:
			fmt.Fprintf(b, "  %s %s", app.Subtle.Render("○"), app.Subtle.Render("stopped"))
		}
		b.WriteString("\n")
	}

	if page.Anomalies != "" && !locked {
		b.WriteString("\n")
		for _, line := range strings.Split(strings.TrimRight(page.Anomalies, "\n"), "\n") {
			b.WriteString("  " + app.Highlight.Render(line) + "\n")
		}
	}

	b.WriteString("\n  " + lockedTag("Launch") + "\n")
	if page.HasEditor {
		sel := selected(rowLaunchEditor, 0)
		b.WriteString("  " + app.RowPrefix(sel))
		b.WriteString(name(fmt.Sprintf("%-28s", "Editor + Claude"), rowLaunchEditor, sel))
		if !locked {
			b.WriteString(app.Subtle.Render(leadHint(page)))
		}
		b.WriteString("\n")
	}
	sel := selected(rowLaunchClaude, 0)
	b.WriteString("  " + app.RowPrefix(sel))
	b.WriteString(name(fmt.Sprintf("%-28s", "Claude in terminal"), rowLaunchClaude, sel))
	if !page.HasEditor && !locked {
		b.WriteString(app.Subtle.Render(leadHint(page)))
	}
	b.WriteString("\n")

	b.WriteString("\n  Open\n")
	if page.HasSSH {
		sel := selected(rowOpenRemote, 0)
		b.WriteString("  " + app.RowPrefix(sel))
		b.WriteString(name("Cursor / VS Code (remote)", rowOpenRemote, sel))
		b.WriteString("\n")
	}
	sel = selected(rowOpenShell, 0)
	b.WriteString("  " + app.RowPrefix(sel))
	b.WriteString(name("Shell here", rowOpenShell, sel))
	b.WriteString("\n")
}

// renderHealth is what is recorded on the worktree, per issue with its
// stage and a few lines of evidence, and the two keys out of it. f hands
// Claude all of the evidence.
func renderHealth(b *strings.Builder, h *Health, installing bool) {
	if h == nil {
		return
	}
	b.WriteString("\n  " + app.Error.Render("! "+h.Summary()) + app.Subtle.Render(" · "+ago(h.At)) + "\n")
	width := 0
	for _, issue := range h.Issues {
		width = max(width, len(issue.Name()))
	}
	for _, issue := range h.Issues {
		lines := strings.Split(strings.TrimRight(issue.Detail, "\n"), "\n")
		hidden := 0
		if len(lines) > 3 {
			hidden = len(lines) - 3
			lines = lines[len(lines)-3:]
		}
		for j, line := range lines {
			label := strings.Repeat(" ", 10+width)
			if j == 0 {
				label = fmt.Sprintf("%-9s %-*s", issue.Stage, width, issue.Name())
			}
			b.WriteString("    " + app.Subtle.Render(label[:9]) + label[9:] + "   " + app.Subtle.Render(line) + "\n")
		}
		if hidden > 0 {
			b.WriteString("    " + strings.Repeat(" ", 10+width) + "   " + app.Subtle.Render(fmt.Sprintf("… %d more lines — f hands Claude all of it", hidden)) + "\n")
		}
	}
	keys := "f fix with Claude   v verify"
	if installing {
		// The rest is still being made; a verify has to wait for it.
		keys = "f fix with Claude"
	}
	b.WriteString("\n    " + app.Highlight.Render(keys) + "\n")
}

// spinnerFrame is the page's mark on a running step. Static: the page
// re-renders every couple of seconds, not every tick.
const spinnerFrame = "▸"

// ago is "2 minutes ago" for a timestamp; nothing older than days needs finer.
func ago(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%d minutes ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%d hours ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%d days ago", int(d.Hours()/24))
	}
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

func (v WorktreeView) load() tea.Cmd { return v.loadWith(true) }

func (v WorktreeView) loadWith(check bool) tea.Cmd {
	ref, settling := v.ref, v.settling()
	return func() tea.Msg {
		res, err := Resolve(ref)
		if err != nil {
			// A check that passed took its target with it: the page's job
			// is done, and the verdict is the last thing it says.
			if IsCheck(ref) && !CheckExists(ref.Worktree) {
				return checkPassedMsg{project: ref.Worktree}
			}
			return errMsg{err}
		}
		return worktreeLoadedMsg{page: loadWorktreePage(res, check, settling)}
	}
}

// anyStarting: a referenced server the check found not listening yet.
func (p worktreePage) anyStarting() bool {
	for _, item := range p.Items {
		if item.checked() == SmokeUnreached {
			return true
		}
	}
	return false
}

// loadWorktreePage gathers everything the page shows: configured servers
// joined to what is running, and the same anomalies `crew dev start` prints,
// so the page tells you before you start anything.
func loadWorktreePage(res *Resolved, check, settling bool) worktreePage {
	routes, _ := dev.LoadRoutes(res.Slug)
	var checks map[string]SmokeResult
	var checkHealth *Health
	if check && len(routes) > 0 {
		results := waitDevRoutes(res.Slug, routes, 0)
		checks = make(map[string]SmokeResult, len(results))
		for _, r := range results {
			checks[dev.PortKey(r.Project, r.Server)] = r
		}
		// No verdict on a server that is still starting: f waits too.
		verdicts := results
		if settling {
			verdicts = withoutStarting(results)
		}
		checkHealth = CheckHealth(verdicts)
	}
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
				if c, ok := checks[dev.PortKey(p.Name, ds.Name)]; ok {
					c := c
					item.Check = &c
				}
			}
			items = append(items, item)
		}
	}

	projects := res.DevProjects()
	resolutions := dev.ResolveBindings(res.ResolveParams(dev.IndexRoutePorts(routes)))
	anomalies := dev.FormatAnomalies(resolutions) +
		dev.FormatConflicts(dev.InspectEnvConflicts(res.Slug, projects, dev.PlannedFromRoutes(projects, routes), resolutions))

	page := worktreePage{
		Dir:         res.Dir,
		Items:       items,
		CheckHealth: checkHealth,
		Settling:    settling,
		Setup:       liveSetup(res.Ref),
		Now:         time.Now(),
		Anomalies:   strings.TrimLeft(anomalies, "\n"),
		Health:      res.Health,
		HasEditor:   exec.DetectEditor() != "",
		HasSSH:      settings.SSHHost != "",
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

// liveSetup is the runners' status while any is alive, nil otherwise.
func liveSetup(ref Ref) *Status {
	st, err := SetupStatus(ref)
	if err != nil || !st.Running() {
		return nil
	}
	return &st
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

// runVerify starts the verify's runners; the page then shows their table
// until they are done and reads the verdict off the worktree.
func (v WorktreeView) runVerify() tea.Cmd {
	ref := v.ref
	return func() tea.Msg {
		res, err := Resolve(ref)
		if err != nil {
			return errMsg{err}
		}
		// The page asked already; a session still up is stopped first.
		dev.StopAll(res.Slug)
		if err := Verify(res, CheckoutOptions{Install: true, Smoke: true}, nil); err != nil {
			return errMsg{err}
		}
		return verifyStartedMsg{}
	}
}

// runFix is crew fix from the page: Claude with the recorded failure, or
// with what the check of the running servers found.
func (v WorktreeView) runFix() tea.Cmd {
	ref := v.ref
	transient := v.page.CheckHealth
	return func() tea.Msg {
		res, err := Resolve(ref)
		if err != nil {
			return errMsg{err}
		}
		cmd, err := FixCommandFor(res, MergeHealth(res.Health, transient), FixAnomalies(res))
		if err != nil {
			return errMsg{err}
		}
		return claudeExecReadyMsg{cmd: cmd}
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
