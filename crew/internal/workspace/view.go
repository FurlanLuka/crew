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
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// ── Messages ──

type workspacesLoadedMsg struct{ summaries []Summary }
type workspaceCreatedMsg struct{ name string }
type workspaceRemovedMsg struct{ name string }
type workspaceDuplicatedMsg struct{ src, dst string }
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
	stateAddingProject   // async: creating git worktree
	stateRemovingProject // async: removing git worktree
	stateProjectConfirmRemove
	stateDuplicate
	stateDuplicating
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
	wsProjects    []WorkspaceProject
	projCursor    int
	poolNames     []string // available from pool
	poolCursor    int
	roleInput     textinput.Model
	pickedProject string // name of project being added
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
	case stateProjects, stateProjectPick, stateProjectRole, stateAddingProject, stateRemovingProject, stateProjectConfirmRemove:
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
		return v, loadWsProjects(v.selectedWs)

	case wsProjectRemovedMsg:
		v.state = stateProjects
		v.statusMsg = fmt.Sprintf("Removed '%s'", msg.name)
		v.err = nil
		return v, loadWsProjects(v.selectedWs)

	case errMsg:
		v.err = msg.err
		// If we were in an async state, go back to projects
		if v.state == stateAddingProject || v.state == stateRemovingProject {
			v.state = stateProjects
		}
		if v.state == stateDuplicating {
			v.state = stateList
		}
		return v, nil

	case spinner.TickMsg:
		if v.state == stateAddingProject || v.state == stateRemovingProject || v.state == stateDuplicating {
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
	case stateCreate, stateDuplicate:
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
	case stateProjectConfirmRemove:
		return v.handleProjectConfirmRemoveKey(msg)
	case stateDuplicate:
		return v.handleDuplicateKey(msg)
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
		if v.cursor > 0 {
			v.cursor--
		}
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		if v.cursor < len(v.summaries)-1 {
			v.cursor++
		}
		return v, nil
	case msg.String() == "n":
		v.state = stateCreate
		v.statusMsg = ""
		v.err = nil
		v.input.Focus()
		return v, v.input.Cursor.BlinkCmd()
	case msg.String() == "u":
		if len(v.summaries) > 0 {
			v.selectedWs = v.summaries[v.cursor].Name
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
			v.selectedWs = v.summaries[v.cursor].Name
			v.state = stateProjects
			v.projCursor = 0
			v.statusMsg = ""
			v.err = nil
			return v, loadWsProjects(v.selectedWs)
		}
		return v, nil
	case msg.String() == "s":
		if len(v.summaries) > 0 {
			s := v.summaries[v.cursor]
			page := NewDevView(s.Name)
			return v, func() tea.Msg { return app.PushPageMsg{Page: page} }
		}
		return v, nil
	case msg.String() == "g":
		if len(v.summaries) > 0 {
			s := v.summaries[v.cursor]
			return v, launchLazygit(s.Name)
		}
		return v, nil
	case msg.String() == "c":
		if len(v.summaries) > 0 {
			s := v.summaries[v.cursor]
			return v, openCode(s.Name)
		}
		return v, nil
	case msg.String() == "o":
		if len(v.summaries) > 0 {
			s := v.summaries[v.cursor]
			dir := WorkspaceDir(s.Name)
			return v, func() tea.Msg { return app.ExitWithOutputMsg{Output: dir} }
		}
		return v, nil
	case msg.String() == "enter":
		if len(v.summaries) > 0 {
			s := v.summaries[v.cursor]
			page := NewLaunchView(s.Name)
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
		srcName := v.selectedWs
		v.state = stateDuplicating
		return v, tea.Batch(v.spinner.Tick, func() tea.Msg {
			if err := Duplicate(srcName, name); err != nil {
				return errMsg{err}
			}
			return workspaceDuplicatedMsg{src: srcName, dst: name}
		})
	}

	var cmd tea.Cmd
	v.input, cmd = v.input.Update(msg)
	return v, cmd
}

func (v View) handleConfirmRemoveKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "y", "Y":
		name := v.summaries[v.cursor].Name
		v.state = stateList
		return v, removeWorkspace(name)
	default:
		v.state = stateList
		return v, nil
	}
}

// ── Project management within workspace ──

func (v View) handleProjectsKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		v.state = stateList
		v.selectedWs = ""
		v.statusMsg = ""
		return v, loadWorkspaces
	case key.Matches(msg, app.Keys.Up):
		if v.projCursor > 0 {
			v.projCursor--
		}
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		if v.projCursor < len(v.wsProjects)-1 {
			v.projCursor++
		}
		return v, nil
	case msg.String() == "a":
		v.err = nil
		if len(v.poolNames) > 0 {
			v.state = stateProjectPick
			v.poolCursor = 0
			v.statusMsg = ""
		} else {
			v.err = fmt.Errorf("no projects available — add projects in the Projects view first")
		}
		return v, nil
	case msg.String() == "d":
		if len(v.wsProjects) > 0 {
			v.state = stateProjectConfirmRemove
			v.statusMsg = ""
		}
		return v, nil
	}
	return v, nil
}

func (v View) handleProjectPickKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, app.Keys.Back):
		v.state = stateProjects
		return v, nil
	case key.Matches(msg, app.Keys.Up):
		if v.poolCursor > 0 {
			v.poolCursor--
		}
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		if v.poolCursor < len(v.poolNames)-1 {
			v.poolCursor++
		}
		return v, nil
	case msg.String() == "enter":
		if len(v.poolNames) > 0 {
			v.pickedProject = v.poolNames[v.poolCursor]
			v.state = stateProjectRole
			v.roleInput.Focus()
			return v, v.roleInput.Cursor.BlinkCmd()
		}
		return v, nil
	}
	return v, nil
}

func (v View) handleProjectRoleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		v.state = stateProjectPick
		v.roleInput.Reset()
		v.pickedProject = ""
		return v, nil
	case "enter":
		role := strings.TrimSpace(v.roleInput.Value())
		name := v.pickedProject
		wsName := v.selectedWs
		if role == "" {
			role = "works on " + name
		}
		v.state = stateAddingProject
		return v, tea.Batch(v.spinner.Tick, addProjectToWorkspace(wsName, name, role))
	}

	var cmd tea.Cmd
	v.roleInput, cmd = v.roleInput.Update(msg)
	return v, cmd
}

func (v View) handleProjectConfirmRemoveKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "y", "Y":
		name := v.wsProjects[v.projCursor].Name
		wsName := v.selectedWs
		v.state = stateRemovingProject
		return v, tea.Batch(v.spinner.Tick, removeProjectFromWorkspace(wsName, name))
	default:
		v.state = stateProjects
		return v, nil
	}
}

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
	case stateAddingProject:
		b.WriteString("  ")
		b.WriteString(v.spinner.View())
		b.WriteString(" Creating git worktree...\n")
	case stateRemovingProject:
		b.WriteString("  ")
		b.WriteString(v.spinner.View())
		b.WriteString(" Removing git worktree...\n")
	case stateProjectConfirmRemove:
		v.renderProjectConfirmRemove(&b)
	case stateDuplicate:
		v.renderDuplicate(&b)
	case stateDuplicating:
		b.WriteString("  ")
		b.WriteString(v.spinner.View())
		b.WriteString(" Duplicating workspace...\n")
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
		cursor := "  "
		if i == v.cursor {
			cursor = app.Selected.Render("> ")
		}

		name := s.Name
		if i == v.cursor {
			name = app.Selected.Render(name)
		}

		details := fmt.Sprintf("%d projects", s.ProjectCount)

		var badges []string
		if s.DevRunning {
			badges = append(badges, app.Highlight.Render("[dev]"))
		}

		b.WriteString(cursor)
		b.WriteString(name)
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

	help := "n new  u duplicate  d delete  p projects  s servers  g git  c code  o open  enter launch  esc back"
	b.WriteString("  ")
	b.WriteString(app.HelpStyle.Render(help))
	b.WriteString("\n")
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

func (v View) renderDuplicate(b *strings.Builder) {
	b.WriteString(fmt.Sprintf("  Duplicate '%s' as: ", v.selectedWs))
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
	name := v.summaries[v.cursor].Name
	b.WriteString(fmt.Sprintf("  Remove workspace '%s'? This will delete all worktrees. (y/n)\n", name))
}

func (v View) renderProjects(b *strings.Builder) {
	if len(v.wsProjects) == 0 {
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render("No projects in this workspace."))
		b.WriteString("\n\n")
	} else {
		for i, wp := range v.wsProjects {
			cursor := "  "
			if i == v.projCursor {
				cursor = app.Selected.Render("> ")
			}

			name := wp.Name
			if i == v.projCursor {
				name = app.Selected.Render(name)
			}

			b.WriteString(cursor)
			b.WriteString(name)
			b.WriteString("  ")
			b.WriteString(app.Subtle.Render(ProjectPath(v.selectedWs, wp.Name)))
			b.WriteString("\n")

			if wp.Role != "" {
				b.WriteString("    ")
				b.WriteString(app.Subtle.Render(wp.Role))
				b.WriteString("\n")
			}
		}
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

	b.WriteString("  ")
	b.WriteString(app.HelpStyle.Render("a add  d delete  esc back"))
	b.WriteString("\n")
}

func (v View) renderProjectPick(b *strings.Builder) {
	b.WriteString("  ")
	b.WriteString(app.Subtle.Render("Select project to add:"))
	b.WriteString("\n\n")

	for i, name := range v.poolNames {
		cursor := "  "
		if i == v.poolCursor {
			cursor = app.Selected.Render("> ")
		}
		display := name
		if i == v.poolCursor {
			display = app.Selected.Render(name)
		}

		b.WriteString(cursor)
		b.WriteString(display)

		// Show path
		if p := project.Get(name); p != nil {
			b.WriteString("  ")
			b.WriteString(app.Subtle.Render(p.Path))
		}
		b.WriteString("\n")
	}

	b.WriteString("\n  ")
	b.WriteString(app.HelpStyle.Render("enter select  esc back"))
	b.WriteString("\n")
}

func (v View) renderProjectRole(b *strings.Builder) {
	b.WriteString(fmt.Sprintf("  Adding '%s'\n\n", v.pickedProject))
	b.WriteString("  Role: ")
	b.WriteString(v.roleInput.View())
	b.WriteString("\n\n")

	b.WriteString("  ")
	b.WriteString(app.HelpStyle.Render("enter add  esc cancel"))
	b.WriteString("\n")
}

func (v View) renderProjectConfirmRemove(b *strings.Builder) {
	name := v.wsProjects[v.projCursor].Name
	b.WriteString(fmt.Sprintf("  Remove '%s' from workspace? This will delete the worktree. (y/n)\n", name))
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

func loadWsProjects(wsName string) tea.Cmd {
	return func() tea.Msg {
		ws, err := Load(wsName)
		if err != nil {
			return errMsg{err}
		}

		// Find pool projects not already in workspace
		pool, _ := project.List()
		inWs := make(map[string]bool)
		for _, wp := range ws.Projects {
			inWs[wp.Name] = true
		}
		var available []string
		for _, p := range pool {
			if !inWs[p.Name] {
				available = append(available, p.Name)
			}
		}

		return wsProjectsLoadedMsg{
			wsProjects: ws.Projects,
			poolNames:  available,
		}
	}
}

func addProjectToWorkspace(wsName, projName, role string) tea.Cmd {
	return func() tea.Msg {
		if err := AddProject(wsName, projName, role); err != nil {
			return errMsg{err}
		}
		return wsProjectAddedMsg{projName}
	}
}

func removeProjectFromWorkspace(wsName, projName string) tea.Cmd {
	return func() tea.Msg {
		if err := RemoveProject(wsName, projName); err != nil {
			return errMsg{err}
		}
		return wsProjectRemovedMsg{projName}
	}
}

func launchLazygit(wsName string) tea.Cmd {
	return func() tea.Msg {
		session, err := EnsureGitSession(wsName)
		if err != nil {
			return errMsg{err}
		}
		return gitSessionReadyMsg{session}
	}
}

func openCode(wsName string) tea.Cmd {
	return func() tea.Msg {
		settings := config.LoadSettings()
		if settings.SSHHost == "" {
			return errMsg{fmt.Errorf("ssh_host not configured — set it in crew config")}
		}

		ws, err := Load(wsName)
		if err != nil {
			return errMsg{err}
		}

		var remotePath string
		if len(ws.Projects) == 1 {
			remotePath = ProjectPath(wsName, ws.Projects[0].Name)
		} else {
			wsFile := CodeWorkspaceFilePath(wsName)
			var projects []exec.WorkspaceProject
			for _, wp := range ws.Projects {
				projects = append(projects, exec.WorkspaceProject{
					Name: wp.Name,
					Path: ProjectPath(wsName, wp.Name),
				})
			}
			if err := exec.GenerateCodeWorkspace(wsFile, projects, nil); err != nil {
				return errMsg{err}
			}
			remotePath = wsFile
		}

		var b strings.Builder
		for _, ed := range []struct{ name, scheme string }{
			{"cursor", "cursor://"},
			{"vscode", "vscode://"},
		} {
			uri := ed.scheme + "vscode-remote/ssh-remote+" + settings.SSHHost + remotePath
			display := ed.name + " → " + wsName
			// OSC 8 clickable hyperlink
			fmt.Fprintf(&b, "\033]8;;%s\033\\%s\033]8;;\033\\\n", uri, display)
		}

		return codeOpenedMsg{output: b.String()}
	}
}
