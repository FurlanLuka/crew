package project

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
)

// ── Messages ──

type projectsLoadedMsg struct{ projects []Project }
type projectRemovedMsg struct{ name string }
type commandSavedMsg struct {
	name  string
	field commandField
}
type errMsg struct{ err error }

// ── States ──

type viewState int

const (
	stateList viewState = iota
	stateConfirmRemove
	stateCommandForm
)

// commandField is which of a project's two commands the one-line form
// edits: the install (`t`) or the env fetch (`e`). Same form, same save;
// the enum owns everything that differs.
type commandField int

const (
	fieldSetup commandField = iota
	fieldEnvCmd
)

func (f commandField) label() string {
	if f == fieldEnvCmd {
		return "Env command"
	}
	return "Setup command"
}

func (f commandField) value(p Project) string {
	if f == fieldEnvCmd {
		return p.EnvCmd
	}
	return p.Setup
}

func (f commandField) placeholder() string {
	if f == fieldEnvCmd {
		return "make get-env   (empty: the copied .env is all)"
	}
	return "make sync   (empty: detect from lockfile)"
}

func (f commandField) hint() string {
	if f == fieldEnvCmd {
		return "Writes the checkout's env files; runs after the install. Must write files, not print values — its output is logged."
	}
	return "Runs in every new checkout after mise install. Leave empty to detect from the lockfile."
}

func (f commandField) save(name, command string) error {
	if f == fieldEnvCmd {
		return SetEnvCmd(name, command)
	}
	return SetSetup(name, command)
}

// AddWizard opens the add-project walk — source, install, servers,
// bindings, check. Its check step needs the workspace package, which
// imports this one, so main wires the constructor in (as with Previewer);
// nil leaves the list without an add key.
var AddWizard func() app.Page

// ── Model ──

type View struct {
	state        viewState
	projects     []Project
	cursor       int
	commandInput textinput.Model
	editing      commandField
	statusMsg    string
	err          error
}

func NewView() View {
	si := textinput.New()
	si.CharLimit = 256

	return View{
		state:        stateList,
		commandInput: si,
	}
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

	case commandSavedMsg:
		v.state = stateList
		v.statusMsg = fmt.Sprintf("%s for '%s' saved", msg.field.label(), msg.name)
		v.commandInput.Blur()
		return v, loadProjects

	case errMsg:
		v.err = msg.err
		return v, nil

	case tea.KeyMsg:
		return v.handleKey(msg)
	}

	if v.state == stateCommandForm {
		var cmd tea.Cmd
		v.commandInput, cmd = v.commandInput.Update(msg)
		return v, cmd
	}

	return v, nil
}

func (v View) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch v.state {
	case stateList:
		return v.handleListKey(msg)
	case stateConfirmRemove:
		return v.handleConfirmRemoveKey(msg)
	case stateCommandForm:
		return v.handleCommandFormKey(msg)
	}
	return v, nil
}

// handleCommandFormKey is the one-line form for the two commands worth
// changing after the fact: the install and the env fetch.
func (v View) handleCommandFormKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		v.state = stateList
		v.commandInput.Blur()
		return v, nil
	case "enter":
		name := v.projects[v.cursor].Name
		command := strings.TrimSpace(v.commandInput.Value())
		field := v.editing
		return v, func() tea.Msg {
			if err := field.save(name, command); err != nil {
				return errMsg{err}
			}
			return commandSavedMsg{name, field}
		}
	}
	var cmd tea.Cmd
	v.commandInput, cmd = v.commandInput.Update(msg)
	return v, cmd
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
	case msg.String() == "a" && AddWizard != nil:
		page := AddWizard()
		return v, func() tea.Msg { return app.PushPageMsg{Page: page} }
	case msg.String() == "d":
		if len(v.projects) > 0 {
			v.state = stateConfirmRemove
			v.statusMsg = ""
		}
		return v, nil
	case msg.String() == "s":
		if len(v.projects) > 0 {
			p := v.projects[v.cursor]
			page := NewDevServerView(p.Name)
			return v, func() tea.Msg { return app.PushPageMsg{Page: page} }
		}
		return v, nil
	case msg.String() == "b":
		if len(v.projects) > 0 {
			p := v.projects[v.cursor]
			page := NewBindingsView(p.Name)
			return v, func() tea.Msg { return app.PushPageMsg{Page: page} }
		}
		return v, nil
	case msg.String() == "t":
		return v.openCommandForm(fieldSetup)
	case msg.String() == "e":
		return v.openCommandForm(fieldEnvCmd)
	}
	return v, nil
}

func (v View) handleConfirmRemoveKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "y", "Y":
		name := v.projects[v.cursor].Name
		v.state = stateList
		return v, func() tea.Msg {
			if err := Remove(name); err != nil {
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
	case stateCommandForm:
		v.renderCommandForm(&b)
	}

	return b.String()
}

func (v View) openCommandForm(field commandField) (tea.Model, tea.Cmd) {
	if len(v.projects) == 0 {
		return v, nil
	}
	v.state = stateCommandForm
	v.editing = field
	v.statusMsg = ""
	v.err = nil
	v.commandInput.Placeholder = field.placeholder()
	v.commandInput.SetValue(field.value(v.projects[v.cursor]))
	v.commandInput.Focus()
	return v, v.commandInput.Cursor.BlinkCmd()
}

func (v View) renderCommandForm(b *strings.Builder) {
	fmt.Fprintf(b, "  %s for %s\n\n", v.editing.label(), v.projects[v.cursor].Name)
	b.WriteString("  " + v.editing.hint() + "\n\n")
	b.WriteString("  ")
	b.WriteString(v.commandInput.View())
	b.WriteString("\n\n  ")
	b.WriteString(app.HelpStyle.Render("enter save  esc cancel"))
	b.WriteString("\n")
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
	b.WriteString(app.HelpStyle.Render(listHelp(AddWizard != nil)))
	b.WriteString("\n")
}

// listHelp is the list's key line; a is offered only when the wizard is
// wired, so the help never names a key the handler drops. Pure.
func listHelp(canAdd bool) string {
	keys := "d delete  s servers  b bindings  t setup  e env cmd  esc back"
	if canAdd {
		return "a add  " + keys
	}
	return keys
}

func (v View) renderConfirmRemove(b *strings.Builder) {
	name := v.projects[v.cursor].Name
	b.WriteString(fmt.Sprintf("  Remove project '%s'? (y/n)\n", name))
}

// ── Commands ──

func loadProjects() tea.Msg {
	projects, err := List()
	if err != nil {
		return errMsg{err}
	}
	return projectsLoadedMsg{projects}
}
