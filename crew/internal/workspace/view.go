package workspace

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
)

// ── Messages ──

type workspacesLoadedMsg struct{ summaries []Summary }
type workspaceCreatedMsg struct{ name string }
type workspaceRemovedMsg struct{ name string }
type workspaceDuplicatedMsg struct{ src, dst string }
type worktreeAddedMsg struct{ ref Ref }
type worktreeRemovedMsg struct{ ref Ref }
type errMsg struct{ err error }

// Project management messages
type wsProjectsLoadedMsg struct {
	wsProjects []WorkspaceProject
	poolNames  []string // names from pool not yet in workspace
}
type codeOpenedMsg struct{ output string }
type gitSessionReadyMsg struct{ session string }
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

	sp := spinner.New()
	sp.Spinner = spinner.Dot

	return View{
		state:     stateList,
		input:     ti,
		roleInput: ri,
		spinner:   sp,
	}
}

func (v View) Title() string {
	switch v.state {
	case stateProjects, stateProjectPick, stateProjectRole, stateProjectMode, stateAddingProject, stateRemovingProject, stateProjectConfirmRemove:
		return fmt.Sprintf("Projects in \"%s\"", v.selectedWs)
	case stateWorktrees, stateNewWorktree, stateAddingWorktree, stateDuplicate, stateDuplicating, stateConfirmRemoveWorktree:
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
		return v, nil

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
		v.err = nil
		v.input.Reset()
		return v, loadWorkspaces

	case worktreeRemovedMsg:
		v.state = stateWorktrees
		v.statusMsg = fmt.Sprintf("Removed worktree '%s'", msg.ref)
		v.err = nil
		return v, loadWorkspaces

	case worktreeAddedMsg:
		v.state = stateWorktrees
		v.statusMsg = fmt.Sprintf("Created worktree '%s'", msg.ref)
		v.err = nil
		v.input.Reset()
		return v, loadWorkspaces

	case codeOpenedMsg:
		return v, func() tea.Msg { return app.ExitWithOutputMsg{Output: msg.output} }

	case gitSessionReadyMsg:
		cmd := GitAttachCmd(msg.session)
		return v, tea.ExecProcess(cmd, func(err error) tea.Msg {
			return loadWorkspaces()
		})

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
		if v.state == stateDuplicating || v.state == stateAddingWorktree {
			v.state = stateWorktrees
		}
		return v, nil

	case spinner.TickMsg:
		if v.state == stateAddingProject || v.state == stateRemovingProject || v.state == stateDuplicating || v.state == stateAddingWorktree {
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
		v.input.SetValue("")
		v.input.Placeholder = fmt.Sprintf("wrk%d", len(worktrees)+1)
		v.input.Focus()
		return v, v.input.Cursor.BlinkCmd()
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
		page := NewLaunchView(worktrees[v.wtCursor].Ref)
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
	case "s":
		page := NewDevView(selected.Ref)
		return v, func() tea.Msg { return app.PushPageMsg{Page: page} }
	case "g":
		return v, launchLazygit(selected.Ref)
	case "c":
		return v, openCode(selected.Ref)
	case "o":
		return v, func() tea.Msg { return app.ExitWithOutputMsg{Output: selected.Path} }
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
		return v, tea.Batch(v.spinner.Tick, func() tea.Msg {
			if err := DuplicateWorktree(src, name); err != nil {
				return errMsg{err}
			}
			return workspaceDuplicatedMsg{src: src.String(), dst: src.Workspace + "/" + name}
		})
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
	case "enter":
		name := strings.TrimSpace(v.input.Value())
		if name == "" {
			return v, nil
		}
		wsName := v.selectedWs
		v.state = stateAddingWorktree
		return v, tea.Batch(v.spinner.Tick, func() tea.Msg {
			if err := AddWorktree(wsName, name); err != nil {
				return errMsg{err}
			}
			return worktreeAddedMsg{ref: Ref{Workspace: wsName, Worktree: name}}
		})
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
		return v, removeWorktree(v.selectedRef)
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
		b.WriteString("  ")
		b.WriteString(v.spinner.View())
		b.WriteString(" Duplicating worktree...\n")
	case stateNewWorktree:
		v.renderNewWorktree(&b)
	case stateWorktrees:
		v.renderWorktrees(&b)
	case stateConfirmRemoveWorktree:
		b.WriteString(fmt.Sprintf("  Remove worktree '%s'? Its checkouts will be deleted; the workspace stays. (y/n)\n", v.selectedRef))
	case stateAddingWorktree:
		b.WriteString("  ")
		b.WriteString(v.spinner.View())
		b.WriteString(" Creating worktree...\n")
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

	for i, s := range row.Worktrees {
		b.WriteString(app.RowPrefix(i == v.wtCursor))
		b.WriteString(renderSummaryName(s, i == v.wtCursor))
		if s.DevRunning {
			b.WriteString("  " + app.Highlight.Render("[dev]"))
		}
		b.WriteString("\n")
	}

	newIdx := len(row.Worktrees)
	b.WriteString(app.RowPrefix(v.wtCursor == newIdx))
	b.WriteString(app.RowName("+ new worktree", v.wtCursor == newIdx))
	b.WriteString("\n")

	v.renderStatus(b)
	b.WriteString("  ")
	if v.wtCursor == newIdx {
		b.WriteString(app.HelpStyle.Render("enter create  esc back"))
	} else {
		b.WriteString(app.HelpStyle.Render("enter launch  s servers  g git  c code  o open  u duplicate  n new  d delete  esc back"))
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
	b.WriteString(fmt.Sprintf("  New worktree: %s/", v.selectedWs))
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

func removeWorktree(ref Ref) tea.Cmd {
	return func() tea.Msg {
		if err := RemoveWorktree(ref.Workspace, ref.Worktree); err != nil {
			return errMsg{err}
		}
		return worktreeRemovedMsg{ref}
	}
}

func launchLazygit(ref Ref) tea.Cmd {
	return func() tea.Msg {
		res, err := Resolve(ref)
		if err != nil {
			return errMsg{err}
		}
		session, err := EnsureGitSession(res)
		if err != nil {
			return errMsg{err}
		}
		return gitSessionReadyMsg{session}
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
