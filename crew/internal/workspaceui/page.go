package workspaceui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/dirsize"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// The workspace page: its members and its worktrees on one screen, one
// cursor. enter on a member opens the project page, on a worktree its
// page; a adds members through the picker; + new worktree and u make
// worktrees here, with the base table; d removes. Every action is a
// command the footer names. The page re-reads its facts after every
// action and on every pop. Keys live in page_keys.go, the drawing in
// page_render.go.

// ── Messages ──

// pageFactsMsg is the read: the workspace file, its worktree rows, the
// pool entries of its members, and whether the trash is still clearing.
type pageFactsMsg struct {
	ws        *workspace.Workspace
	pool      map[string]project.Project
	summaries []workspace.Summary
	trash     string
}

type worktreeSizesMsg struct{ sizes map[string]int64 }

type worktreeAddedMsg struct {
	ref            workspace.Ref
	duplicatedFrom string
}
type worktreeRemovedMsg struct{ ref workspace.Ref }
type worktreeRenamedMsg struct {
	from, to workspace.Ref
	warnings []string
}
type membersAddedMsg struct {
	names []string
	refs  []workspace.Ref // the worktrees whose runners were started
}
type memberRemovedMsg struct{ name string }

// ── Facts ──

// pageFacts is everything the page renders, pre-derived: the renderer
// does no I/O.
type pageFacts struct {
	ws        *workspace.Workspace
	pool      map[string]project.Project
	summaries []workspace.Summary
	// sizes is bytes on disk per worktree ref, filled in after the page
	// shows and kept for its lifetime — a walk over a big build tree is
	// slow and competes with whatever is writing it. An absent key is
	// still loading.
	sizes   map[string]int64
	spinner string
	// trash is the notice that removed checkouts are still clearing, ""
	// when the trash is empty — read with the facts, not per frame.
	trash string
}

func (f pageFacts) members() []workspace.WorkspaceProject {
	if f.ws == nil {
		return nil
	}
	return f.ws.Projects
}

// flat: the workspace predates worktrees — one unnamed row, no sizes, no
// new worktree until crew migrate.
func (f pageFacts) flat() bool {
	return len(f.summaries) == 1 && f.summaries[0].Worktree == ""
}

// ── Model ──

type openKind int

const (
	openNone openKind = iota
	openPicker
	openNewWorktree
	openDuplicate
	openRename
)

type confirmKind int

const (
	confirmProject confirmKind = iota
	confirmWorktree
	confirmWorkspace
)

// confirmAsk is what d asked about, resolved when d was pressed — the
// prompt and the target by identity, so a reload in between changes
// nothing about what y removes.
type confirmAsk struct {
	prompt string
	kind   confirmKind
	name   string
	ref    workspace.Ref
}

// pendingCursor is where the next rebuild puts the cursor: a row by
// identity (the worktree just made), or with no key the first row of the
// kind — where a fresh page lands once its facts are in.
type pendingCursor struct {
	kind rowKind
	key  string
}

type Page struct {
	name  string
	facts pageFacts
	rows  []pageRow
	// The cursor follows its row's identity across reloads.
	cursor  int
	pending *pendingCursor
	height  int

	open   openKind
	picker picker
	input  textinput.Model // the name field of the open form
	// bases is the new-worktree form's table.
	bases basePane
	// formRef is the worktree the open form acts on — duplicate's source,
	// rename's subject.
	formRef workspace.Ref

	confirm *confirmAsk
	// busy is the line shown while a removal or a creation runs; keys
	// wait for it — a large checkout takes a while to move, and a second
	// d would start a concurrent removal on the next row.
	busy    string
	spinner spinner.Model

	loaded bool
	status string
	err    error
}

// NewPage opens the page on a workspace; the cursor lands on the first
// worktree.
func NewPage(name string) Page {
	ti := textinput.New()
	ti.CharLimit = 64
	p := Page{name: name, input: ti, spinner: app.NewSpinner()}
	p.facts.sizes = map[string]int64{}
	p.rows = pageRows(p.facts)
	p.cursor = landOn(p.rows, rowWorktree)
	p.pending = &pendingCursor{kind: rowWorktree}
	return p
}

func (p Page) Title() string { return p.name }

// Init runs on the first push and again on every pop back — from a
// worktree page, a project page, or the add-project wizard the picker
// pushed: re-read everything, and the picker's pool when it is open.
func (p Page) Init() tea.Cmd {
	cmds := []tea.Cmd{loadPageFacts(p.name)}
	if p.open == openPicker {
		cmds = append(cmds, p.loadPicker())
	}
	return tea.Batch(cmds...)
}

func (p Page) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		p.height = msg.Height
		return p, nil

	case pageFactsMsg:
		p.facts.ws, p.facts.pool, p.facts.summaries, p.facts.trash = msg.ws, msg.pool, msg.summaries, msg.trash
		p.loaded = true
		p.rerow()
		return p, p.loadMissingSizes()

	case worktreeSizesMsg:
		for ref, n := range msg.sizes {
			p.facts.sizes[ref] = n
		}
		return p, nil

	case pickerFactsMsg:
		p.picker.reload(msg.facts)
		return p, nil

	case basesMsg:
		if p.open != openNewWorktree {
			return p, nil
		}
		var err error
		if p.bases, err = p.bases.apply(msg); err != nil {
			p.err = err
		}
		return p, nil

	case worktreeAddedMsg:
		// The page stays under the pushed one and is what esc comes back
		// to, so its state is reset here even though the page takes over
		// now.
		p.busy, p.status, p.err = "", "", nil
		p.closeForm()
		delete(p.facts.sizes, msg.ref.String())
		p.pending = &pendingCursor{kind: rowWorktree, key: msg.ref.String()}
		created := fmt.Sprintf("Created %s — installing", msg.ref)
		if msg.duplicatedFrom != "" {
			created = fmt.Sprintf("Duplicated %s → %s — installing", msg.duplicatedFrom, msg.ref)
		}
		page := workspace.NewWorktreeView(msg.ref)
		page.SetStatus(created)
		return p, tea.Batch(loadPageFacts(p.name), func() tea.Msg { return app.PushPageMsg{Page: page} })

	case worktreeRemovedMsg:
		p.busy, p.err = "", nil
		p.status = fmt.Sprintf("Removed worktree '%s' — clearing in background", msg.ref)
		delete(p.facts.sizes, msg.ref.String())
		p.pending = &pendingCursor{kind: rowWorktree}
		return p, loadPageFacts(p.name)

	case worktreeRenamedMsg:
		p.busy, p.err = "", nil
		p.closeForm()
		p.status = fmt.Sprintf("Renamed %s → %s", msg.from, msg.to)
		if len(msg.warnings) > 0 {
			p.status += " — " + msg.warnings[0]
		}
		// The size is the same bytes under a new key.
		if n, ok := p.facts.sizes[msg.from.String()]; ok {
			p.facts.sizes[msg.to.String()] = n
			delete(p.facts.sizes, msg.from.String())
		}
		p.pending = &pendingCursor{kind: rowWorktree, key: msg.to.String()}
		return p, loadPageFacts(p.name)

	case workspaceRemovedMsg:
		return p, func() tea.Msg { return app.PopPageMsg{Status: fmt.Sprintf("Removed workspace '%s'", msg.name)} }

	case membersAddedMsg:
		p.busy, p.err = "", nil
		p.status = addedStatus(msg.names, msg.refs)
		p.closeForm()
		if len(msg.names) > 0 {
			p.pending = &pendingCursor{kind: rowProject, key: msg.names[0]}
		}
		return p, loadPageFacts(p.name)

	case memberRemovedMsg:
		p.busy, p.err = "", nil
		p.status = fmt.Sprintf("Removed '%s'", msg.name)
		p.pending = &pendingCursor{kind: rowProject}
		return p, loadPageFacts(p.name)

	case app.StatusMsg:
		p.status, p.err = msg.Status, nil
		return p, nil

	case errMsg:
		p.busy = ""
		p.err = msg.err
		p.status = ""
		return p, nil

	case spinner.TickMsg:
		if p.busy != "" || p.sizesLoading() || (p.open == openNewWorktree && p.bases.busy()) {
			var cmd tea.Cmd
			p.spinner, cmd = p.spinner.Update(msg)
			return p, cmd
		}
		return p, nil

	case tea.KeyMsg:
		return p.handleKey(msg)
	}
	if p.open == openNewWorktree || p.open == openDuplicate || p.open == openRename {
		var cmd tea.Cmd
		p.input, cmd = p.input.Update(msg)
		return p, cmd
	}
	return p, nil
}

// rerow rebuilds the cursor's path and puts the cursor where it belongs:
// the pending target when there is one, else the row it was on, found
// again by identity.
func (p *Page) rerow() {
	var kind rowKind
	key := ""
	if p.cursor >= 0 && p.cursor < len(p.rows) {
		kind, key = p.rows[p.cursor].Kind, p.rows[p.cursor].Key
	}
	p.rows = pageRows(p.facts)
	if t := p.pending; t != nil {
		switch {
		case t.key == "" && p.loaded:
			p.cursor, p.pending = landOn(p.rows, t.kind), nil
			return
		case t.key != "":
			if i := findRow(p.rows, t.kind, t.key); i >= 0 {
				p.cursor, p.pending = i, nil
				return
			}
		}
	}
	if i := findRow(p.rows, kind, key); i >= 0 {
		p.cursor = i
		return
	}
	p.cursor = min(p.cursor, max(0, len(p.rows)-1))
}

func (p *Page) closeForm() {
	p.open = openNone
	p.input.Blur()
	p.input.SetValue("")
}

// ── Loads ──

func loadPageFacts(name string) tea.Cmd {
	return func() tea.Msg {
		ws, err := workspace.Load(name)
		if err != nil {
			return errMsg{fmt.Errorf("workspace '%s' is gone", name)}
		}
		summaries, err := workspace.SummariesOf(name)
		if err != nil {
			return errMsg{err}
		}
		pool := map[string]project.Project{}
		if list, err := project.List(); err == nil {
			for _, p := range list {
				pool[p.Name] = p
			}
		}
		return pageFactsMsg{ws: ws, pool: pool, summaries: summaries, trash: workspace.TrashNotice()}
	}
}

// loadPicker reads the pool for the picker, the members left out.
func (p Page) loadPicker() tea.Cmd {
	exclude := map[string]bool{}
	for _, wp := range p.facts.members() {
		exclude[wp.Name] = true
	}
	ws := p.facts.ws
	if ws == nil {
		ws = &workspace.Workspace{Name: p.name}
	}
	return loadPickerFacts(ws, exclude)
}

// loadMissingSizes walks the worktrees that have no size yet. Nothing is
// rewalked: a removed or added worktree drops out of or never enters the
// map, everything else keeps the number it got.
func (p Page) loadMissingSizes() tea.Cmd {
	var missing []workspace.Summary
	for _, s := range p.facts.summaries {
		// A flat pre-2.0 workspace has no size column to fill.
		if _, done := p.facts.sizes[s.Ref.String()]; !done && s.Worktree != "" {
			missing = append(missing, s)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	// One walk per worktree, so a small one is not held up by a huge sibling.
	cmds := []tea.Cmd{p.spinner.Tick}
	for _, s := range missing {
		ref, path := s.Ref.String(), s.Path
		cmds = append(cmds, func() tea.Msg {
			return worktreeSizesMsg{map[string]int64{ref: dirsize.Of(path)}}
		})
	}
	return tea.Batch(cmds...)
}

func (p Page) sizesLoading() bool {
	for _, s := range p.facts.summaries {
		if _, done := p.facts.sizes[s.Ref.String()]; !done && s.Worktree != "" {
			return true
		}
	}
	return false
}

// addedStatus is the one line after an add: what went in, and where its
// runners are going. Pure.
func addedStatus(names []string, refs []workspace.Ref) string {
	msg := "Added " + strings.Join(names, ", ")
	if len(refs) == 0 {
		return msg
	}
	if len(refs) == 1 {
		return msg + fmt.Sprintf(" — installing on %s (its page shows the runners)", refs[0])
	}
	return msg + fmt.Sprintf(" — installing on %d worktrees (each page shows its runners)", len(refs))
}
