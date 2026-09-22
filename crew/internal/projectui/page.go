package projectui

import (
	"fmt"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// The project page: everything about one project on one screen — install,
// servers, bindings, the check — with one cursor, each row edited in place.
// Every action is a command the footer names. The page re-reads its facts
// after every save and on every pop; the expensive walk (previews,
// proposals) only when a server or binding changed. The keys live in
// page_keys.go, the drawing in page_render.go.

// ── Host protocol ──

// section is which part of a project a form or a row belongs to.
type section int

const (
	sectionInstall section = iota
	sectionServers
	sectionBindings
	sectionCheck
)

// savedMsg: a sub-model's command landed; the host re-reads its facts.
// key names the row to land on afterwards (a renamed server, a re-scoped
// binding), "" to stay where the cursor was.
type savedMsg struct {
	section section
	key     string
}

// ── Messages ──

// pageFactsMsg is the cheap read: the pool entry, its remote, the detected
// plan and the check's state.
type pageFactsMsg struct {
	proj     project.Project
	remote   string
	detected []exec.SetupStep
	check    workspace.CheckInfo
}

// pageScanMsg is the expensive read: every binding previewed against every
// worktree, the env files scanned for proposals, the pool for targets.
type pageScanMsg struct {
	previews  map[dev.BindingKey][]workspace.BindingPreview
	proposals []dev.Proposal
	envKeys   []string
	pool      []project.Project
}

// ── Facts ──

// pageFacts is everything the page renders, pre-derived: the renderer does
// no I/O, no git, and reads no clock but now.
type pageFacts struct {
	proj      project.Project
	remote    string
	detected  []exec.SetupStep
	previews  map[dev.BindingKey][]workspace.BindingPreview
	proposals []dev.Proposal // not yet bound
	envKeys   []string
	pool      []project.Project
	check     workspace.CheckInfo
	now       time.Time
}

// ── Model ──

type openKind int

const (
	openNone openKind = iota
	openCommand
	openServer
	openBinding
)

// pendingCursor is where the next rebuild puts the cursor: a key names a
// row by identity (a save's renamed server); an empty key means the
// section's first row — the list's t/e/s/b, which waits for both loads,
// since the bindings section is not known until the scan is.
type pendingCursor struct {
	kind rowKind
	key  string
}

// confirmAsk is what d asked about, resolved when d was pressed — the
// prompt and the target by identity, so a reload in between changes
// nothing about what y removes.
type confirmAsk struct {
	prompt  string
	section section
	server  string
	key     dev.BindingKey
}

type Page struct {
	name  string
	facts pageFacts
	rows  []pageRow
	// The cursor follows its row's identity across reloads.
	cursor  int
	pending *pendingCursor
	height  int

	open       openKind
	cmdField   commandField
	cmdInput   textinput.Model
	serverForm *serverForm
	editor     *bindingEditor
	check      checkCard
	confirm    *confirmAsk

	// loaded and scanned: the two reads of Init have landed.
	loaded  bool
	scanned bool
	status  string
	err     error
}

// NewPage opens the page on a project. jump names the section to land on
// (rowSetup, rowEnv, rowServer, rowBinding) — the list's t/e/s/b.
func NewPage(name string, jump rowKind) Page {
	ci := textinput.New()
	ci.CharLimit = 256
	p := Page{name: name, cmdInput: ci, check: newCheckCard(name, "")}
	// Until the loads land the rows are an empty project's; the jump is
	// applied once both are in.
	p.rows = pageRows(pageFacts{})
	p.cursor = jumpTo(p.rows, jump)
	p.pending = &pendingCursor{kind: jump}
	return p
}

func (p Page) Title() string { return fmt.Sprintf("Project %q", p.name) }

// Init runs on the first push and again on every pop back from the logs
// page: re-read everything, and re-arm the check poll when a runner is
// alive — ticks reach only the top page, so the chain died under the push.
func (p Page) Init() tea.Cmd {
	return tea.Batch(loadPageFacts(p.name), loadPageScan(p.name))
}

func (p Page) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		p.height = msg.Height
		return p, nil

	case pageFactsMsg:
		p.facts.proj, p.facts.remote, p.facts.detected, p.facts.check = msg.proj, msg.remote, msg.detected, msg.check
		p.facts.now = time.Now()
		if p.check.base == "" {
			p.check = newCheckCard(p.name, msg.proj.Path)
		}
		p.facts.proposals = unboundProposals(p.facts.proposals, msg.proj.Bindings)
		p.loaded = true
		p.rerow()
		// What the disk says about the check is the card's to act on —
		// a runner alive (started here or from the CLI) is followed, a
		// kept failure gets l, f and the guard on c.
		var cmd tea.Cmd
		p.check, cmd = p.check.adopt(msg.check)
		return p, cmd

	case pageScanMsg:
		p.facts.previews, p.facts.envKeys, p.facts.pool = msg.previews, msg.envKeys, msg.pool
		p.facts.proposals = unboundProposals(msg.proposals, p.facts.proj.Bindings)
		p.scanned = true
		p.rerow()
		return p, nil

	case savedMsg:
		p.err = nil
		p.status = savedLine(msg.section)
		p.closeForm()
		if msg.key != "" {
			kind := rowServer
			if msg.section == sectionBindings {
				kind = rowBinding
			}
			p.pending = &pendingCursor{kind: kind, key: msg.key}
		}
		cmds := []tea.Cmd{loadPageFacts(p.name)}
		if msg.section != sectionInstall {
			cmds = append(cmds, loadPageScan(p.name))
		}
		return p, tea.Batch(cmds...)

	case bindingPreviewMsg:
		if p.editor != nil {
			e, cmd := p.editor.Update(msg)
			p.editor = &e
			return p, cmd
		}
		return p, nil

	case checkStartedMsg, checkPollMsg:
		before := p.check.phase
		var cmd tea.Cmd
		p.check, cmd = p.check.Update(msg)
		p.status = ""
		if p.check.phase != before && p.check.done() {
			// The verdict is on disk now; the facts say what the row shows.
			return p, tea.Batch(cmd, loadPageFacts(p.name))
		}
		return p, cmd

	case fixReadyMsg:
		return p, tea.ExecProcess(msg.cmd, func(err error) tea.Msg {
			if err != nil {
				return errMsg{err}
			}
			return savedMsg{section: sectionCheck}
		})

	case errMsg:
		p.check, _ = p.check.Update(msg)
		p.err = msg.err
		p.status = ""
		return p, nil

	case spinner.TickMsg:
		var cmd tea.Cmd
		p.check, cmd = p.check.Update(msg)
		return p, cmd

	case tea.KeyMsg:
		return p.handleKey(msg)
	}
	if p.open != openNone {
		return p.updateForm(msg)
	}
	return p, nil
}

// rerow rebuilds the cursor's path and puts the cursor where it belongs:
// the pending target when there is one and the rows can hold it, else
// the row it was on, found again by identity.
func (p *Page) rerow() {
	var kind rowKind
	key := ""
	if p.cursor >= 0 && p.cursor < len(p.rows) {
		kind, key = p.rows[p.cursor].Kind, p.rows[p.cursor].Key
	}
	p.rows = pageRows(p.facts)
	if t := p.pending; t != nil {
		switch {
		case t.key != "":
			if i := findRow(p.rows, t.kind, t.key); i >= 0 {
				p.cursor, p.pending = i, nil
				return
			}
			// Not in the rows yet (the scan reload lands after the
			// facts): keep the target until it is.
		case p.loaded && p.scanned:
			p.cursor, p.pending = jumpTo(p.rows, t.kind), nil
			return
		default:
			return
		}
	}
	if i := findRow(p.rows, kind, key); i >= 0 {
		p.cursor = i
		return
	}
	p.cursor = min(p.cursor, max(0, len(p.rows)-1))
}

// savedLine is the status a save leaves. Pure.
func savedLine(s section) string {
	switch s {
	case sectionInstall:
		return "Saved"
	case sectionServers:
		return "Servers saved"
	case sectionBindings:
		return "Bindings saved"
	}
	return ""
}

// ── Loads ──

func loadPageFacts(name string) tea.Cmd {
	return func() tea.Msg {
		p := project.Get(name)
		if p == nil {
			return errMsg{fmt.Errorf("project '%s' is gone from the pool", name)}
		}
		return pageFactsMsg{
			proj:     *p,
			remote:   project.RemoteOf(*p),
			detected: exec.DetectSetup(p.Path),
			check:    workspace.InspectCheck(name),
		}
	}
}

func loadPageScan(name string) tea.Cmd {
	return func() tea.Msg {
		p := project.Get(name)
		if p == nil {
			return errMsg{fmt.Errorf("project '%s' is gone from the pool", name)}
		}
		values := project.ScanEnv(workspace.ProjectCheckouts(name), "")
		pool, _ := project.List()
		return pageScanMsg{
			previews:  workspace.PreviewBindings(name, p.Bindings),
			proposals: dev.ProposeBindings(values, project.ConfiguredPorts()),
			envKeys:   envKeysOf(values),
			pool:      pool,
		}
	}
}
