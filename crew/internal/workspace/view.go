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
)

// ── Model ──

type View struct {
	state     viewState
	summaries []Summary
	cursor    int
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
		v.state = stateList
		v.statusMsg = fmt.Sprintf("Duplicated '%s' → '%s'", msg.src, msg.dst)
		v.err = nil
		v.input.Reset()
		return v, loadWorkspaces

	case worktreeRemovedMsg:
		v.state = stateList
		v.statusMsg = fmt.Sprintf("Removed worktree '%s'", msg.ref)
		v.err = nil
		return v, loadWorkspaces

	case worktreeAddedMsg:
		v.state = stateList
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
			v.state = stateList
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
	}
	return v, nil
}

func (v View) handleListKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		return v, func() tea.Msg { return app.PopPageMsg{} }
	case key.Matches(msg, app.Keys.Up):
		v.cursor = app.MoveCursor(v.cursor, -1, len(v.summaries))
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		v.cursor = app.MoveCursor(v.cursor, 1, len(v.summaries))
		return v, nil
	case msg.String() == "n":
		v.state = stateCreate
		v.statusMsg = ""
		v.err = nil
		v.input.Focus()
		return v, v.input.Cursor.BlinkCmd()
	case msg.String() == "u":
		if len(v.summaries) > 0 {
			v.selectedWs = v.summaries[v.cursor].Workspace
			v.selectedRef = v.summaries[v.cursor].Ref
			v.state = stateDuplicate
			v.statusMsg = ""
			v.err = nil
			v.input.SetValue("")
			v.input.Focus()
			return v, v.input.Cursor.BlinkCmd()
		}
		return v, nil
	case msg.String() == "d":
		if len(v.summaries) > 0 {
			v.state = stateConfirmRemove
			v.statusMsg = ""
			v.err = nil
		}
		return v, nil
	case msg.String() == "p":
		if len(v.summaries) > 0 {
			v.selectedWs = v.summaries[v.cursor].Workspace
			v.selectedRef = v.summaries[v.cursor].Ref
			v.state = stateProjects
			v.projCursor = 0
			v.statusMsg = ""
			v.err = nil
			return v, loadWsProjects(v.selectedWs)
		}
		return v, nil
	case msg.String() == "w":
		if len(v.summaries) > 0 {
			v.selectedWs = v.summaries[v.cursor].Workspace
			v.selectedRef = v.summaries[v.cursor].Ref
			v.state = stateNewWorktree
			v.statusMsg = ""
			v.err = nil
			v.input.SetValue("")
			v.input.Focus()
			return v, v.input.Cursor.BlinkCmd()
		}
		return v, nil
	case msg.String() == "s":
		if len(v.summaries) > 0 {
			page := NewDevView(v.summaries[v.cursor].Ref)
			return v, func() tea.Msg { return app.PushPageMsg{Page: page} }
		}
		return v, nil
	case msg.String() == "g":
		if len(v.summaries) > 0 {
			return v, launchLazygit(v.summaries[v.cursor].Ref)
		}
		return v, nil
	case msg.String() == "c":
		if len(v.summaries) > 0 {
			return v, openCode(v.summaries[v.cursor].Ref)
		}
		return v, nil
	case msg.String() == "o":
		if len(v.summaries) > 0 {
			dir := v.summaries[v.cursor].Path
			return v, func() tea.Msg { return app.ExitWithOutputMsg{Output: dir} }
		}
		return v, nil
	case msg.String() == "enter":
		if len(v.summaries) > 0 {
			page := NewLaunchView(v.summaries[v.cursor].Ref)
			return v, func() tea.Msg { return app.PushPageMsg{Page: page} }
		}
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
		v.state = stateList
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
		v.state = stateList
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
		s := v.summaries[v.cursor]
		v.state = stateList
		if v.isLastWorktree(s) {
			return v, removeWorkspace(s.Workspace)
		}
		return v, removeWorktree(s.Ref)
	default:
		v.state = stateList
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
	case stateAddingWorktree:
		b.WriteString("  ")
		b.WriteString(v.spinner.View())
		b.WriteString(" Creating worktree...\n")
	}

	return b.String()
}

func (v View) renderList(b *strings.Builder) {
	if len(v.summaries) == 0 {
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render("No workspaces yet."))
		b.WriteString("\n\n")
		b.WriteString("  ")
		b.WriteString(app.HelpStyle.Render("n new  esc back"))
		b.WriteString("\n")
		return
	}

	for i, s := range v.summaries {
		details := fmt.Sprintf("%d projects", s.ProjectCount)

		var badges []string
		if s.DevRunning {
			badges = append(badges, app.Highlight.Render("[dev]"))
		}

		b.WriteString(app.RowPrefix(i == v.cursor))
		b.WriteString(renderSummaryName(s, i == v.cursor))
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render(details))
		if len(badges) > 0 {
			b.WriteString("  ")
			b.WriteString(strings.Join(badges, " "))
		}
		b.WriteString("\n")
	}

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

	help := "n new  w worktree  u duplicate  d delete  p projects  s servers  g git  c code  o open  enter launch  esc back"
	b.WriteString("  ")
	b.WriteString(app.HelpStyle.Render(help))
	b.WriteString("\n")
}

// renderSummaryName shows ws/wt with the worktree highlighted, or the bare
// workspace with a migrate hint when it predates worktrees.
func renderSummaryName(s Summary, selected bool) string {
	if s.Worktree == "" {
		return app.RowName(s.Workspace, selected) + "  " + app.Subtle.Render("(run crew migrate)")
	}
	if selected {
		return app.Selected.Render(s.Workspace + "/" + s.Worktree)
	}
	return s.Workspace + "/" + app.Highlight.Render(s.Worktree)
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
	b.WriteString(fmt.Sprintf("  New worktree in '%s': %s/", v.selectedWs, v.selectedWs))
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

// isLastWorktree reports whether removing this row's worktree would leave its
// workspace empty — in which case the workspace goes with it.
func (v View) isLastWorktree(s Summary) bool {
	count := 0
	for _, other := range v.summaries {
		if other.Workspace == s.Workspace {
			count++
		}
	}
	return count <= 1
}

func (v View) renderConfirmRemove(b *strings.Builder) {
	s := v.summaries[v.cursor]
	if !v.isLastWorktree(s) {
		b.WriteString(fmt.Sprintf("  Remove worktree '%s'? Its checkouts will be deleted; the workspace stays. (y/n)\n", s.Name))
		return
	}

	name := s.Workspace
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
