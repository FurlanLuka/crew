package workspace

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dirsize"
	"github.com/FurlanLuka/crew/crew/internal/exec"
)

// ── Messages ──

type workspacesLoadedMsg struct{ summaries []Summary }
type workspaceCreatedMsg struct{ name string }
type workspaceRemovedMsg struct{ name string }
type workspaceDuplicatedMsg struct{ src, dst string }
type worktreeAddedMsg struct{ ref Ref }
type worktreeSizesMsg struct{ sizes map[string]int64 }
type baseStatusesMsg struct{ statuses []BaseStatus }
type basesPulledMsg struct{ failed []error }

// setupProgressMsg is one install step finishing while a worktree is being
// created. The worker sends these on a channel and the view keeps listening
// until the terminal message arrives.
type setupProgressMsg struct {
	line string
	ch   <-chan tea.Msg
}
type worktreeRemovedMsg struct{ ref Ref }
type errMsg struct{ err error }

// Project management messages
type wsProjectsLoadedMsg struct {
	wsProjects []WorkspaceProject
	poolNames  []string // names from pool not yet in workspace
}
type codeOpenedMsg struct{ output string }
type wsProjectAddedMsg struct{ name string }
type wsProjectRemovedMsg struct{ name string }

// ── States ──

type viewState int

const (
	stateList viewState = iota
	stateCreate
	stateConfirmRemove
	stateProjects        // project list for selected workspace
	stateProjectPick     // pick from pool to add
	stateProjectRole     // enter role for picked project
	stateProjectMode     // pick mode (worktree | direct) for picked project
	stateAddingProject   // async: creating git worktree
	stateRemovingProject // async: removing git worktree
	stateProjectConfirmRemove
	stateDuplicate
	stateDuplicating
	stateNewWorktree
	stateAddingWorktree
	stateWorktrees // worktree list for the selected workspace
	stateConfirmRemoveWorktree
	stateRemovingWorktree
)

// ── Model ──

type View struct {
	state     viewState
	summaries []Summary // every worktree, across workspaces
	cursor    int       // over workspaceRows()
	wtCursor  int       // over the selected workspace's worktrees, plus the "+ new" row
	input     textinput.Model
	err       error
	statusMsg string
	spinner   spinner.Model

	// Base branches shown while naming a new worktree; nil while loading.
	baseStatuses []BaseStatus
	baseLoading  bool
	// setupLines is what has finished so far while a checkout is installing.
	setupLines []string
	// sizes is bytes on disk per worktree ref, filled in after the list shows
	// and kept for the view's lifetime — a walk over a big build tree is slow
	// and competes with whatever is writing it. An absent key is still loading.
	sizes map[string]int64

	// Project management within workspace
	selectedWs    string
	selectedRef   Ref
	wsProjects    []WorkspaceProject
	projCursor    int
	poolNames     []string // available from pool
	poolCursor    int
	roleInput     textinput.Model
	pickedProject string // name of project being added
	pickedRole    string // role captured before mode pick
	modeCursor    int    // 0 = worktree, 1 = direct
}

func NewView() View {
	ti := textinput.New()
	ti.Placeholder = "workspace-name"
	ti.CharLimit = 64

	ri := textinput.New()
	ri.Placeholder = "owns the backend API"
	ri.CharLimit = 256

	return View{
		state:     stateList,
		input:     ti,
		roleInput: ri,
		spinner:   app.NewSpinner(),
		sizes:     map[string]int64{},
	}
}

func (v View) Title() string {
	switch v.state {
	case stateProjects, stateProjectPick, stateProjectRole, stateProjectMode, stateAddingProject, stateRemovingProject, stateProjectConfirmRemove:
		return fmt.Sprintf("Projects in \"%s\"", v.selectedWs)
	case stateWorktrees, stateNewWorktree, stateAddingWorktree, stateDuplicate, stateDuplicating, stateConfirmRemoveWorktree, stateRemovingWorktree:
		return fmt.Sprintf("Worktrees in \"%s\"", v.selectedWs)
	}
	return "Workspaces"
}

func (v View) Init() tea.Cmd {
	return loadWorkspaces
}

func (v View) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return v, nil

	case workspacesLoadedMsg:
		v.summaries = msg.summaries
		v.err = nil
		if v.cursor >= len(v.summaries) {
			v.cursor = max(0, len(v.summaries)-1)
		}
		return v, v.loadMissingSizes()

	case workspaceCreatedMsg:
		v.state = stateList
		v.statusMsg = fmt.Sprintf("Created workspace '%s'", msg.name)
		v.err = nil
		v.input.Reset()
		return v, loadWorkspaces

	case workspaceRemovedMsg:
		v.state = stateList
		v.statusMsg = fmt.Sprintf("Removed workspace '%s'", msg.name)
		v.err = nil
		return v, loadWorkspaces

	case workspaceDuplicatedMsg:
		v.state = stateWorktrees
		v.statusMsg = fmt.Sprintf("Duplicated '%s' → '%s'", msg.src, msg.dst)
		if len(v.setupLines) > 0 {
			v.statusMsg = strings.Join(v.setupLines, "\n  ") + "\n\n  " + v.statusMsg
		}
		v.err = nil
		v.input.Reset()
		return v, loadWorkspaces

	case worktreeRemovedMsg:
		v.state = stateWorktrees
		v.statusMsg = fmt.Sprintf("Removed worktree '%s' — clearing in background", msg.ref)
		v.err = nil
		delete(v.sizes, msg.ref.String())
		return v, loadWorkspaces

	case worktreeSizesMsg:
		for ref, n := range msg.sizes {
			v.sizes[ref] = n
		}
		return v, nil

	case baseStatusesMsg:
		v.baseStatuses = msg.statuses
		v.baseLoading = false
		return v, nil

	case basesPulledMsg:
		if len(msg.failed) > 0 {
			msgs := make([]string, 0, len(msg.failed))
			for _, err := range msg.failed {
				msgs = append(msgs, err.Error())
			}
			v.err = fmt.Errorf("%s", strings.Join(msgs, "; "))
		}
		v.baseLoading = true
		return v, tea.Batch(loadBaseStatuses(v.selectedWs), v.spinner.Tick)

	case setupProgressMsg:
		v.setupLines = append(v.setupLines, msg.line)
		return v, listen(msg.ch)

	case worktreeAddedMsg:
		v.state = stateWorktrees
		v.statusMsg = fmt.Sprintf("Created worktree '%s'", msg.ref)
		if len(v.setupLines) > 0 {
			v.statusMsg = strings.Join(v.setupLines, "\n  ") + "\n\n  " + v.statusMsg
		}
		v.err = nil
		v.input.Reset()
		return v, loadWorkspaces

	case codeOpenedMsg:
		return v, func() tea.Msg { return app.ExitWithOutputMsg{Output: msg.output} }

	case wsProjectsLoadedMsg:
		v.wsProjects = msg.wsProjects
		v.poolNames = msg.poolNames
		if v.projCursor >= len(v.wsProjects) {
			v.projCursor = max(0, len(v.wsProjects)-1)
		}
		return v, nil

	case wsProjectAddedMsg:
		v.state = stateProjects
		v.statusMsg = fmt.Sprintf("Added '%s'", msg.name)
		v.err = nil
		v.roleInput.Reset()
		v.pickedProject = ""
		v.pickedRole = ""
		v.modeCursor = 0
		return v, loadWsProjects(v.selectedWs)

	case wsProjectRemovedMsg:
		v.state = stateProjects
		v.statusMsg = fmt.Sprintf("Removed '%s'", msg.name)
		v.err = nil
		return v, loadWsProjects(v.selectedWs)

	case errMsg:
		v.err = msg.err
		if v.state == stateAddingProject || v.state == stateRemovingProject {
			v.state = stateProjects
		}
		if v.state == stateDuplicating || v.state == stateAddingWorktree || v.state == stateRemovingWorktree {
			v.state = stateWorktrees
		}
		return v, nil

	case spinner.TickMsg:
		if v.state == stateAddingProject || v.state == stateRemovingProject || v.state == stateDuplicating || v.state == stateAddingWorktree || v.state == stateRemovingWorktree || v.baseLoading || v.sizesLoading() {
			var cmd tea.Cmd
			v.spinner, cmd = v.spinner.Update(msg)
			return v, cmd
		}
		return v, nil

	case tea.KeyMsg:
		return v.handleKey(msg)
	}

	// Forward to text inputs
	switch v.state {
	case stateCreate, stateDuplicate, stateNewWorktree:
		var cmd tea.Cmd
		v.input, cmd = v.input.Update(msg)
		return v, cmd
	case stateProjectRole:
		var cmd tea.Cmd
		v.roleInput, cmd = v.roleInput.Update(msg)
		return v, cmd
	}

	return v, nil
}

func (v View) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch v.state {
	case stateList:
		return v.handleListKey(msg)
	case stateCreate:
		return v.handleCreateKey(msg)
	case stateConfirmRemove:
		return v.handleConfirmRemoveKey(msg)
	case stateProjects:
		return v.handleProjectsKey(msg)
	case stateProjectPick:
		return v.handleProjectPickKey(msg)
	case stateProjectRole:
		return v.handleProjectRoleKey(msg)
	case stateProjectMode:
		return v.handleProjectModeKey(msg)
	case stateProjectConfirmRemove:
		return v.handleProjectConfirmRemoveKey(msg)
	case stateDuplicate:
		return v.handleDuplicateKey(msg)
	case stateNewWorktree:
		return v.handleNewWorktreeKey(msg)
	case stateWorktrees:
		return v.handleWorktreesKey(msg)
	case stateConfirmRemoveWorktree:
		return v.handleConfirmRemoveWorktreeKey(msg)
	}
	return v, nil
}

// workspaceRow is one workspace as the top-level list shows it, with its
// worktrees underneath for the subview.
type workspaceRow struct {
	Name         string
	ProjectCount int
	Worktrees    []Summary
	DevRunning   bool
}

// workspaceRows groups the flat worktree summaries by workspace, in order.
func (v View) workspaceRows() []workspaceRow {
	var rows []workspaceRow
	index := map[string]int{}
	for _, s := range v.summaries {
		i, ok := index[s.Workspace]
		if !ok {
			i = len(rows)
			index[s.Workspace] = i
			rows = append(rows, workspaceRow{Name: s.Workspace, ProjectCount: s.ProjectCount})
		}
		rows[i].Worktrees = append(rows[i].Worktrees, s)
		rows[i].DevRunning = rows[i].DevRunning || s.DevRunning
	}
	return rows
}

func (v View) selectedRow() (workspaceRow, bool) {
	rows := v.workspaceRows()
	for _, r := range rows {
		if r.Name == v.selectedWs {
			return r, true
		}
	}
	if len(rows) == 0 {
		return workspaceRow{}, false
	}
	return rows[min(v.cursor, len(rows)-1)], true
}

func (v View) handleListKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	rows := v.workspaceRows()
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		return v, func() tea.Msg { return app.PopPageMsg{} }
	case key.Matches(msg, app.Keys.Up):
		v.cursor = app.MoveCursor(v.cursor, -1, len(rows))
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		v.cursor = app.MoveCursor(v.cursor, 1, len(rows))
		return v, nil
	case msg.String() == "n":
		v.state = stateCreate
		v.statusMsg = ""
		v.err = nil
		v.input.Placeholder = "workspace-name"
		v.input.Focus()
		return v, v.input.Cursor.BlinkCmd()
	case msg.String() == "d":
		if len(rows) > 0 {
			v.selectedWs = rows[v.cursor].Name
			v.state = stateConfirmRemove
			v.statusMsg = ""
			v.err = nil
		}
		return v, nil
	case msg.String() == "p":
		if len(rows) > 0 {
			v.selectedWs = rows[v.cursor].Name
			v.selectedRef = rows[v.cursor].Worktrees[0].Ref
			v.state = stateProjects
			v.projCursor = 0
			v.statusMsg = ""
			v.err = nil
			return v, loadWsProjects(v.selectedWs)
		}
		return v, nil
	case msg.String() == "enter":
		if len(rows) > 0 {
			v.selectedWs = rows[v.cursor].Name
			v.state = stateWorktrees
			v.wtCursor = 0
			v.statusMsg = ""
			v.err = nil
			return v, v.loadMissingSizes()
		}
		return v, nil
	}
	return v, nil
}

// handleWorktreesKey drives the subview: the workspace's worktrees plus a
// trailing "+ new worktree" row, so adding one is a selection like any other.
func (v View) handleWorktreesKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	row, ok := v.selectedRow()
	if !ok {
		v.state = stateList
		return v, nil
	}
	worktrees := row.Worktrees
	rowCount := len(worktrees) + 1 // + new
	onNew := v.wtCursor >= len(worktrees)

	startNew := func() (tea.Model, tea.Cmd) {
		v.state = stateNewWorktree
		v.statusMsg = ""
		v.err = nil
		v.baseStatuses = nil
		v.baseLoading = true
		v.input.SetValue("")
		v.input.Placeholder = fmt.Sprintf("wrk%d", len(worktrees)+1)
		v.input.Focus()
		return v, tea.Batch(v.input.Cursor.BlinkCmd(), loadBaseStatuses(v.selectedWs), v.spinner.Tick)
	}

	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		v.state = stateList
		v.statusMsg = ""
		v.err = nil
		return v, nil
	case key.Matches(msg, app.Keys.Up):
		v.wtCursor = app.MoveCursor(v.wtCursor, -1, rowCount)
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		v.wtCursor = app.MoveCursor(v.wtCursor, 1, rowCount)
		return v, nil
	case msg.String() == "n":
		return startNew()
	case msg.String() == "enter":
		if onNew {
			return startNew()
		}
		page := NewWorktreeView(worktrees[v.wtCursor].Ref)
		return v, func() tea.Msg { return app.PushPageMsg{Page: page} }
	}

	if onNew {
		return v, nil
	}
	selected := worktrees[v.wtCursor]
	v.selectedRef = selected.Ref

	switch msg.String() {
	case "u":
		v.state = stateDuplicate
		v.statusMsg = ""
		v.err = nil
		v.input.SetValue("")
		v.input.Placeholder = fmt.Sprintf("wrk%d", len(worktrees)+1)
		v.input.Focus()
		return v, v.input.Cursor.BlinkCmd()
	case "d":
		v.state = stateConfirmRemoveWorktree
		v.statusMsg = ""
		return v, nil
	}
	return v, nil
}

func (v View) handleCreateKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		v.state = stateList
		v.input.Reset()
		return v, nil
	case "enter":
		name := strings.TrimSpace(v.input.Value())
		if name == "" {
			return v, nil
		}
		return v, createWorkspace(name)
	}

	var cmd tea.Cmd
	v.input, cmd = v.input.Update(msg)
	return v, cmd
}

func (v View) handleDuplicateKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		v.state = stateWorktrees
		v.input.Reset()
		return v, nil
	case "enter":
		name := strings.TrimSpace(v.input.Value())
		if name == "" {
			return v, nil
		}
		src := v.selectedRef
		v.state = stateDuplicating
		v.setupLines = nil
		ch := runWithProgress(func(opts CheckoutOptions, ch chan tea.Msg) tea.Msg {
			if err := DuplicateWorktree(src, name, opts); err != nil {
				return errMsg{err}
			}
			smokeInto(ch, Ref{Workspace: src.Workspace, Worktree: name})
			return workspaceDuplicatedMsg{src: src.String(), dst: src.Workspace + "/" + name}
		})
		return v, tea.Batch(v.spinner.Tick, listen(ch))
	}

	var cmd tea.Cmd
	v.input, cmd = v.input.Update(msg)
	return v, cmd
}

func (v View) handleNewWorktreeKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		v.state = stateWorktrees
		v.input.Reset()
		return v, nil
	case "ctrl+p":
		if v.baseLoading || !Stale(v.baseStatuses) {
			return v, nil
		}
		v.baseLoading = true
		v.err = nil
		return v, tea.Batch(pullBases(v.selectedWs, v.baseStatuses), v.spinner.Tick)
	case "enter":
		name := strings.TrimSpace(v.input.Value())
		if name == "" {
			return v, nil
		}
		wsName := v.selectedWs
		v.state = stateAddingWorktree
		v.setupLines = nil
		ch := runWithProgress(func(opts CheckoutOptions, ch chan tea.Msg) tea.Msg {
			if err := AddWorktree(wsName, name, opts); err != nil {
				return errMsg{err}
			}
			smokeInto(ch, Ref{Workspace: wsName, Worktree: name})
			return worktreeAddedMsg{ref: Ref{Workspace: wsName, Worktree: name}}
		})
		return v, tea.Batch(v.spinner.Tick, listen(ch))
	}

	var cmd tea.Cmd
	v.input, cmd = v.input.Update(msg)
	return v, cmd
}

func (v View) handleConfirmRemoveKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "y", "Y":
		v.state = stateList
		return v, removeWorkspace(v.selectedWs)
	default:
		v.state = stateList
		return v, nil
	}
}

func (v View) handleConfirmRemoveWorktreeKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "y", "Y":
		v.state = stateWorktrees
		row, _ := v.selectedRow()
		if len(row.Worktrees) <= 1 {
			v.state = stateList
			return v, removeWorkspace(v.selectedWs)
		}
		// Removing a large checkout takes a while; the list would look idle
		// and a second d would start a concurrent removal on the next row.
		v.state = stateRemovingWorktree
		return v, tea.Batch(removeWorktree(v.selectedRef), v.spinner.Tick)
	default:
		v.state = stateWorktrees
		return v, nil
	}
}

// ── Project management within workspace ──

// ── View rendering ──

func (v View) View() string {
	var b strings.Builder

	switch v.state {
	case stateList:
		v.renderList(&b)
	case stateCreate:
		v.renderCreate(&b)
	case stateConfirmRemove:
		v.renderConfirmRemove(&b)
	case stateProjects:
		v.renderProjects(&b)
	case stateProjectPick:
		v.renderProjectPick(&b)
	case stateProjectRole:
		v.renderProjectRole(&b)
	case stateProjectMode:
		v.renderProjectMode(&b)
	case stateAddingProject:
		b.WriteString("  ")
		b.WriteString(v.spinner.View())
		b.WriteString(" Adding project...\n")
	case stateRemovingProject:
		b.WriteString("  ")
		b.WriteString(v.spinner.View())
		b.WriteString(" Removing project...\n")
	case stateProjectConfirmRemove:
		v.renderProjectConfirmRemove(&b)
	case stateDuplicate:
		v.renderDuplicate(&b)
	case stateDuplicating:
		v.renderSetupProgress(&b, "Duplicating worktree...")
	case stateNewWorktree:
		v.renderNewWorktree(&b)
	case stateWorktrees:
		v.renderWorktrees(&b)
	case stateConfirmRemoveWorktree:
		b.WriteString(fmt.Sprintf("  Remove worktree '%s'? Its checkouts will be deleted; the workspace stays. (y/n)\n", v.selectedRef))
	case stateAddingWorktree:
		v.renderSetupProgress(&b, "Creating worktree...")
	case stateRemovingWorktree:
		b.WriteString(fmt.Sprintf("  %s Removing %s — large checkouts take a while\n", v.spinner.View(), v.selectedRef))
	}

	return b.String()
}

func (v View) renderList(b *strings.Builder) {
	rows := v.workspaceRows()
	if len(rows) == 0 {
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render("No workspaces yet."))
		b.WriteString("\n\n  ")
		b.WriteString(app.HelpStyle.Render("n new  esc back"))
		b.WriteString("\n")
		return
	}

	for i, r := range rows {
		b.WriteString(app.RowPrefix(i == v.cursor))
		b.WriteString(app.RowName(r.Name, i == v.cursor))
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render(fmt.Sprintf("%d projects · %s", r.ProjectCount, worktreeSummary(r.Worktrees))))
		if r.DevRunning {
			b.WriteString("  " + app.Highlight.Render("[dev]"))
		}
		b.WriteString("\n")
	}

	renderTrashNotice(b)
	v.renderStatus(b)
	b.WriteString("  ")
	b.WriteString(app.HelpStyle.Render("enter worktrees  n new  p projects  d delete  esc back"))
	b.WriteString("\n")
}

// worktreeSummary reads "2 worktrees" or, for a pre-migration workspace, the
// hint to migrate.
func worktreeSummary(worktrees []Summary) string {
	if len(worktrees) == 1 && worktrees[0].Worktree == "" {
		return "run crew migrate"
	}
	if len(worktrees) == 1 {
		return "1 worktree"
	}
	return fmt.Sprintf("%d worktrees", len(worktrees))
}

func (v View) renderWorktrees(b *strings.Builder) {
	row, ok := v.selectedRow()
	if !ok {
		return
	}

	width := 0
	for _, s := range row.Worktrees {
		width = max(width, len(s.Worktree))
	}
	for i, s := range row.Worktrees {
		b.WriteString(app.RowPrefix(i == v.wtCursor))
		b.WriteString(renderSummaryName(s, i == v.wtCursor))
		if s.Worktree != "" {
			b.WriteString(strings.Repeat(" ", width-len(s.Worktree)))
			b.WriteString("  " + v.renderSize(s))
		}
		if s.DevRunning {
			b.WriteString("  " + app.Highlight.Render("[dev]"))
		}
		b.WriteString("\n")
	}

	newIdx := len(row.Worktrees)
	b.WriteString(app.RowPrefix(v.wtCursor == newIdx))
	b.WriteString(app.RowName("+ new worktree", v.wtCursor == newIdx))
	b.WriteString("\n")

	renderTrashNotice(b)
	v.renderStatus(b)
	b.WriteString("  ")
	if v.wtCursor == newIdx {
		b.WriteString(app.HelpStyle.Render("enter create  esc back"))
	} else {
		b.WriteString(app.HelpStyle.Render("enter open  u duplicate  n new  d delete  esc back"))
	}
	b.WriteString("\n")
}

func (v View) renderStatus(b *strings.Builder) {
	b.WriteString("\n")
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
}

// renderSize is right-aligned so the column reads as numbers; a worktree
// still being walked shows the spinner in its place.
func (v View) renderSize(s Summary) string {
	n, ok := v.sizes[s.Ref.String()]
	if !ok {
		// %7s would count the glyph's bytes, not its width.
		return strings.Repeat(" ", 6) + v.spinner.View()
	}
	return app.Subtle.Render(fmt.Sprintf("%7s", app.FormatBytes(n)))
}

// renderTrashNotice says when removed checkouts are still being cleared —
// the bytes are not back yet, which matters right before creating the next.
func renderTrashNotice(b *strings.Builder) {
	if notice := TrashNotice(); notice != "" {
		b.WriteString("\n  " + app.Subtle.Render(notice) + "\n")
	}
}

// renderSummaryName shows ws/wt with the worktree highlighted, or the bare
// workspace with a migrate hint when it predates worktrees.
func renderSummaryName(s Summary, selected bool) string {
	if s.Worktree == "" {
		return app.RowName("(flat)", selected) + "  " + app.Subtle.Render("run crew migrate to name it")
	}
	return app.RowName(s.Worktree, selected)
}

func (v View) renderCreate(b *strings.Builder) {
	b.WriteString("  Name: ")
	b.WriteString(v.input.View())
	b.WriteString("\n\n")

	if v.err != nil {
		b.WriteString("  ")
		b.WriteString(app.Error.Render(v.err.Error()))
		b.WriteString("\n\n")
	}

	b.WriteString("  ")
	b.WriteString(app.HelpStyle.Render("enter create  esc cancel"))
	b.WriteString("\n")
}

func (v View) renderNewWorktree(b *strings.Builder) {
	renderTrashNotice(b)
	b.WriteString("  Branching from\n\n")
	switch {
	case v.baseLoading:
		b.WriteString("  " + v.spinner.View() + " checking base branches against origin...\n")
	default:
		for _, line := range strings.Split(strings.TrimRight(FormatBaseStatuses(v.baseStatuses), "\n"), "\n") {
			b.WriteString(styleBaseLine(line) + "\n")
		}
		if warn := StaleWarning(v.baseStatuses); warn != "" {
			b.WriteString("\n  " + app.Highlight.Render(warn) + "\n")
			b.WriteString("  " + app.Subtle.Render("ctrl+p pulls the latest into the local bases (fast-forward only)") + "\n")
		}
	}

	b.WriteString(fmt.Sprintf("\n  New worktree: %s/", v.selectedWs))
	b.WriteString(v.input.View())
	b.WriteString("\n\n")

	if v.err != nil {
		b.WriteString("  ")
		b.WriteString(app.Error.Render(v.err.Error()))
		b.WriteString("\n\n")
	}

	b.WriteString("  ")
	b.WriteString(app.HelpStyle.Render("enter create  esc cancel"))
	b.WriteString("\n")
}

func (v View) renderSetupProgress(b *strings.Builder, label string) {
	for _, line := range v.setupLines {
		b.WriteString("  " + line + "\n")
	}
	if len(v.setupLines) > 0 {
		b.WriteString("\n")
	}
	b.WriteString("  ")
	b.WriteString(v.spinner.View())
	b.WriteString(" " + label + "\n")
}

// styleBaseLine colours a base-status line by what it says.
func styleBaseLine(line string) string {
	switch {
	case strings.Contains(line, "behind"):
		return app.Highlight.Render(line)
	case strings.Contains(line, "failed") || strings.Contains(line, "no origin") || strings.Contains(line, "not in"):
		return app.Error.Render(line)
	default:
		return line
	}
}

func (v View) renderDuplicate(b *strings.Builder) {
	b.WriteString(fmt.Sprintf("  Duplicate worktree '%s' as %s/", v.selectedRef, v.selectedRef.Workspace))
	b.WriteString(v.input.View())
	b.WriteString("\n\n")

	if v.err != nil {
		b.WriteString("  ")
		b.WriteString(app.Error.Render(v.err.Error()))
		b.WriteString("\n\n")
	}

	b.WriteString("  ")
	b.WriteString(app.HelpStyle.Render("enter duplicate  esc cancel"))
	b.WriteString("\n")
}

func (v View) renderConfirmRemove(b *strings.Builder) {
	name := v.selectedWs
	worktreeCount, directCount := countModes(name)
	switch {
	case worktreeCount == 0 && directCount > 0:
		b.WriteString(fmt.Sprintf("  Remove workspace '%s'? No worktrees to delete; %d direct project(s) will be untouched. (y/n)\n", name, directCount))
	case worktreeCount > 0 && directCount > 0:
		b.WriteString(fmt.Sprintf("  Remove workspace '%s'? Will delete %d worktree(s); %d direct project(s) untouched. (y/n)\n", name, worktreeCount, directCount))
	default:
		b.WriteString(fmt.Sprintf("  Remove workspace '%s'? This will delete all worktrees. (y/n)\n", name))
	}
}

// ── Commands ──

// loadMissingSizes walks the selected workspace's worktrees that have no size
// yet. Nothing is rewalked: a removed or added worktree drops out of or never
// enters the map, everything else keeps the number it got.
func (v View) loadMissingSizes() tea.Cmd {
	if v.state != stateWorktrees {
		return nil
	}
	row, ok := v.selectedRow()
	if !ok {
		return nil
	}
	var missing []Summary
	for _, s := range row.Worktrees {
		// A flat pre-2.0 workspace has no size column to fill.
		if _, done := v.sizes[s.Ref.String()]; !done && s.Worktree != "" {
			missing = append(missing, s)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	// One walk per worktree, so a small one is not held up by a huge sibling.
	cmds := []tea.Cmd{v.spinner.Tick}
	for _, s := range missing {
		ref, path := s.Ref.String(), s.Path
		cmds = append(cmds, func() tea.Msg {
			return worktreeSizesMsg{map[string]int64{ref: dirsize.Of(path)}}
		})
	}
	return tea.Batch(cmds...)
}

func (v View) sizesLoading() bool {
	if v.state != stateWorktrees {
		return false
	}
	row, ok := v.selectedRow()
	if !ok {
		return false
	}
	for _, s := range row.Worktrees {
		if _, done := v.sizes[s.Ref.String()]; !done && s.Worktree != "" {
			return true
		}
	}
	return false
}

func loadWorkspaces() tea.Msg {
	summaries, err := ListSummaries()
	if err != nil {
		return errMsg{err}
	}
	return workspacesLoadedMsg{summaries}
}

func createWorkspace(name string) tea.Cmd {
	return func() tea.Msg {
		if err := Create(name); err != nil {
			return errMsg{err}
		}
		return workspaceCreatedMsg{name}
	}
}

func removeWorkspace(name string) tea.Cmd {
	return func() tea.Msg {
		if err := Remove(name); err != nil {
			return errMsg{err}
		}
		return workspaceRemovedMsg{name}
	}
}

// runWithProgress runs a checkout in the background, streaming one line per
// finished install step, then the final message. listen drains the channel.
func runWithProgress(run func(CheckoutOptions, chan tea.Msg) tea.Msg) <-chan tea.Msg {
	ch := make(chan tea.Msg, 64)
	go func() {
		opts := CheckoutOptions{
			Install: true,
			Progress: func(project string, r exec.SetupResult) {
				ch <- setupProgressMsg{line: setupLine(project, r), ch: ch}
			},
		}
		ch <- run(opts, ch)
		close(ch)
	}()
	return ch
}

// smokeInto starts the new worktree's servers, reports which survive a few
// seconds as progress lines, and stops them again. Failures carry their last
// log lines. Skipped when nothing is configured.
func smokeInto(ch chan tea.Msg, ref Ref) {
	res, err := Resolve(ref)
	if err != nil {
		return
	}
	if len(res.DevProjects()) == 0 {
		return
	}
	ch <- setupProgressMsg{line: app.Subtle.Render("smoke-starting dev servers…"), ch: ch}

	results, err := SmokeStart(res)
	if err != nil {
		ch <- setupProgressMsg{line: app.Error.Render("could not start: " + err.Error()), ch: ch}
		return
	}
	for _, r := range results {
		if r.Alive {
			ch <- setupProgressMsg{line: fmt.Sprintf("%-16s %s %s", r.Project, app.Success.Render("✓"), r.Server), ch: ch}
			continue
		}
		ch <- setupProgressMsg{line: fmt.Sprintf("%-16s %s %s exited within seconds", r.Project, app.Error.Render("✗"), r.Server), ch: ch}
		for _, line := range strings.Split(r.Tail, "\n") {
			if line != "" {
				ch <- setupProgressMsg{line: "    " + app.Subtle.Render(line), ch: ch}
			}
		}
	}
	if failed := SmokeFailures(results); len(failed) > 0 {
		ch <- setupProgressMsg{line: app.Highlight.Render(fmt.Sprintf("! %d server(s) died on start — check dependencies and env in the new checkout", len(failed))), ch: ch}
	}
}

func listen(ch <-chan tea.Msg) tea.Cmd {
	return func() tea.Msg { return <-ch }
}

// setupLine is one finished step as the progress list shows it.
func setupLine(project string, r exec.SetupResult) string {
	mark := app.Success.Render("✓")
	if r.Err != nil {
		mark = app.Error.Render("✗")
	}
	return fmt.Sprintf("%-16s %s %-14s %s", project, mark, r.Step.Name, app.Subtle.Render(r.Duration.Round(time.Second).String()))
}

func pullBases(wsName string, statuses []BaseStatus) tea.Cmd {
	return func() tea.Msg {
		ws, err := Load(wsName)
		if err != nil {
			return errMsg{err}
		}
		return basesPulledMsg{failed: UpdateBases(ws, statuses)}
	}
}

func loadBaseStatuses(wsName string) tea.Cmd {
	return func() tea.Msg {
		ws, err := Load(wsName)
		if err != nil {
			return errMsg{err}
		}
		return baseStatusesMsg{statuses: BaseStatuses(ws)}
	}
}

func removeWorktree(ref Ref) tea.Cmd {
	return func() tea.Msg {
		if err := RemoveWorktree(ref.Workspace, ref.Worktree); err != nil {
			return errMsg{err}
		}
		return worktreeRemovedMsg{ref}
	}
}

func openCode(ref Ref) tea.Cmd {
	return func() tea.Msg {
		settings := config.LoadSettings()
		if settings.SSHHost == "" {
			return errMsg{fmt.Errorf("ssh_host not configured — set it in crew config")}
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
