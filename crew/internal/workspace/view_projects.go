package workspace

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// Project management inside one workspace: the list of member projects and
// the add/remove flows. Lives apart from the worktree list, which is the
// other thing view.go used to hold.

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
		v.projCursor = app.MoveCursor(v.projCursor, -1, len(v.wsProjects))
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		v.projCursor = app.MoveCursor(v.projCursor, 1, len(v.wsProjects))
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
		v.poolCursor = app.MoveCursor(v.poolCursor, -1, len(v.poolNames))
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		v.poolCursor = app.MoveCursor(v.poolCursor, 1, len(v.poolNames))
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
		if role == "" {
			role = "works on " + name
		}
		v.pickedRole = role
		v.modeCursor = 0
		v.state = stateProjectMode
		return v, nil
	}

	var cmd tea.Cmd
	v.roleInput, cmd = v.roleInput.Update(msg)
	return v, cmd
}

func (v View) handleProjectModeKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, app.Keys.Back):
		v.state = stateProjectRole
		return v, nil
	case key.Matches(msg, app.Keys.Up):
		if v.modeCursor > 0 {
			v.modeCursor--
		}
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		if v.modeCursor < 1 {
			v.modeCursor++
		}
		return v, nil
	case msg.String() == "w":
		v.modeCursor = 0
		return v, nil
	case msg.String() == "d":
		v.modeCursor = 1
		return v, nil
	case msg.String() == "enter":
		mode := ModeWorktree
		if v.modeCursor == 1 {
			mode = ModeDirect
		}
		v.state = stateAddingProject
		return v, tea.Batch(v.spinner.Tick, addProjectToWorkspace(v.selectedWs, v.pickedProject, v.pickedRole, mode))
	}
	return v, nil
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
			if IsDirect(wp) {
				b.WriteString("  ")
				b.WriteString(app.Highlight.Render("[direct]"))
			}
			b.WriteString("  ")
			b.WriteString(app.Subtle.Render(WorktreePath(v.selectedRef, wp.Name)))
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

func (v View) renderProjectMode(b *strings.Builder) {
	b.WriteString(fmt.Sprintf("  Adding '%s'\n\n", v.pickedProject))
	b.WriteString("  ")
	b.WriteString(app.Subtle.Render("Mode:"))
	b.WriteString("\n")

	options := []struct {
		label, desc string
	}{
		{"worktree", "Fresh git worktree on a new crew/ branch (default — isolated)"},
		{"direct", "Use the project's canonical checkout (NOT isolated; only one workspace at a time)"},
	}
	for i, opt := range options {
		cursor := "  "
		if i == v.modeCursor {
			cursor = app.Selected.Render("> ")
		}
		label := opt.label
		if i == v.modeCursor {
			label = app.Selected.Render(label)
		}
		b.WriteString(cursor)
		b.WriteString(label)
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render(opt.desc))
		b.WriteString("\n")
	}

	b.WriteString("\n  ")
	b.WriteString(app.HelpStyle.Render("w worktree  d direct  enter add  esc back"))
	b.WriteString("\n")
}

func (v View) renderProjectConfirmRemove(b *strings.Builder) {
	wp := v.wsProjects[v.projCursor]
	if IsDirect(wp) {
		b.WriteString(fmt.Sprintf("  Remove '%s' from workspace? Project repo will not be touched. (y/n)\n", wp.Name))
		return
	}
	b.WriteString(fmt.Sprintf("  Remove '%s' from workspace? This will delete the worktree. (y/n)\n", wp.Name))
}

func loadWsProjects(wsName string) tea.Cmd {
	return func() tea.Msg {
		ws, err := Load(wsName)
		if err != nil {
			return errMsg{err}
		}

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

func addProjectToWorkspace(wsName, projName, role, mode string) tea.Cmd {
	return func() tea.Msg {
		if err := AddProject(wsName, projName, role, mode, CheckoutOptions{Install: true}); err != nil {
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

func countModes(wsName string) (worktree, direct int) {
	ws, err := Load(wsName)
	if err != nil {
		return 0, 0
	}
	for _, wp := range ws.Projects {
		if IsDirect(wp) {
			direct++
		} else {
			worktree++
		}
	}
	return
}
