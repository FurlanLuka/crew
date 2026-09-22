package projectui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// ── Messages ──

type projectsLoadedMsg struct{ projects []project.Project }
type projectRemovedMsg struct{ name string }

// ── States ──

type viewState int

const (
	stateList viewState = iota
	stateConfirmRemove
)

// commandField is which of a project's two commands the page's one-line
// form edits: the install (`t`) or the env fetch (`e`). Same form, same
// save; the enum owns everything that differs.
type commandField int

const (
	cmdSetup commandField = iota
	cmdEnvCmd
)

func (f commandField) label() string {
	if f == cmdEnvCmd {
		return "Env command"
	}
	return "Setup command"
}

func (f commandField) value(p project.Project) string {
	if f == cmdEnvCmd {
		return p.EnvCmd
	}
	return p.Setup
}

func (f commandField) placeholder() string {
	if f == cmdEnvCmd {
		return "make get-env   (empty: the copied .env is all)"
	}
	return "make sync   (empty: detect from lockfile)"
}

func (f commandField) hint() string {
	if f == cmdEnvCmd {
		return "Writes the checkout's env files; runs after the install. Must write files, not print values — its output is logged."
	}
	return "Runs in every new checkout after mise install. Leave empty to detect from the lockfile."
}

func (f commandField) save(name, command string) error {
	if f == cmdEnvCmd {
		return project.SetEnvCmd(name, command)
	}
	return project.SetSetup(name, command)
}

// ── Model ──

type View struct {
	state     viewState
	projects  []project.Project
	cursor    int
	statusMsg string
	err       error
}

func NewView() View {
	return View{state: stateList}
}

func (v View) Title() string { return "Projects" }

func (v View) Init() tea.Cmd {
	return loadProjects
}

func (v View) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return v, nil

	case projectsLoadedMsg:
		// Every success reloads; an error shown is the last thing that failed.
		v.err = nil
		v.projects = msg.projects
		if v.cursor >= len(v.projects) {
			v.cursor = max(0, len(v.projects)-1)
		}
		return v, nil

	case projectRemovedMsg:
		v.state = stateList
		v.statusMsg = fmt.Sprintf("Removed '%s'", msg.name)
		return v, loadProjects

	case errMsg:
		v.err = msg.err
		return v, nil

	case tea.KeyMsg:
		return v.handleKey(msg)
	}

	return v, nil
}

func (v View) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch v.state {
	case stateList:
		return v.handleListKey(msg)
	case stateConfirmRemove:
		return v.handleConfirmRemoveKey(msg)
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
		if v.cursor < len(v.projects)-1 {
			v.cursor++
		}
		return v, nil
	case msg.String() == "a":
		page := New()
		return v, func() tea.Msg { return app.PushPageMsg{Page: page} }
	case msg.String() == "d":
		if len(v.projects) > 0 {
			v.state = stateConfirmRemove
			v.statusMsg = ""
		}
		return v, nil
	case msg.String() == "enter":
		return v.openPage(rowSetup)
	case msg.String() == "t":
		return v.openPage(rowSetup)
	case msg.String() == "e":
		return v.openPage(rowEnv)
	case msg.String() == "s":
		return v.openPage(rowServer)
	case msg.String() == "b":
		return v.openPage(rowBinding)
	}
	return v, nil
}

// openPage is enter and the section letters: the project page, the cursor
// on the section asked for.
func (v View) openPage(jump rowKind) (tea.Model, tea.Cmd) {
	if len(v.projects) == 0 {
		return v, nil
	}
	page := NewPage(v.projects[v.cursor].Name, jump)
	return v, func() tea.Msg { return app.PushPageMsg{Page: page} }
}

func (v View) handleConfirmRemoveKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "y", "Y":
		name := v.projects[v.cursor].Name
		v.state = stateList
		return v, func() tea.Msg {
			if err := project.Remove(name); err != nil {
				return errMsg{err}
			}
			return projectRemovedMsg{name}
		}
	default:
		v.state = stateList
		return v, nil
	}
}

func (v View) View() string {
	var b strings.Builder

	switch v.state {
	case stateList:
		v.renderList(&b)
	case stateConfirmRemove:
		v.renderConfirmRemove(&b)
	}

	return b.String()
}

func (v View) renderList(b *strings.Builder) {
	if len(v.projects) == 0 {
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render("No projects yet."))
		b.WriteString("\n\n")
	} else {
		for i, p := range v.projects {
			cursor := "  "
			if i == v.cursor {
				cursor = app.Selected.Render("> ")
			}

			name := p.Name
			if i == v.cursor {
				name = app.Selected.Render(name)
			}

			b.WriteString(cursor)
			b.WriteString(name)
			b.WriteString("  ")
			b.WriteString(app.Subtle.Render(p.Path))
			if p.Setup != "" {
				b.WriteString("  " + app.Subtle.Render("setup: "+p.Setup))
			}
			if p.EnvCmd != "" {
				b.WriteString("  " + app.Subtle.Render("env: "+p.EnvCmd))
			}
			b.WriteString("\n")
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
	b.WriteString(app.HelpStyle.Render(listHelp))
	b.WriteString("\n")
}

const listHelp = "enter open  a add  d delete  s servers  b bindings  t setup  e env cmd  esc back"

func (v View) renderConfirmRemove(b *strings.Builder) {
	name := v.projects[v.cursor].Name
	b.WriteString(fmt.Sprintf("  project.Remove project '%s'? (y/n)\n", name))
}

// ── Commands ──

func loadProjects() tea.Msg {
	projects, err := project.List()
	if err != nil {
		return errMsg{err}
	}
	return projectsLoadedMsg{projects}
}
