package project

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
)

// ── Messages ──

type projectsLoadedMsg struct{ projects []Project }
type projectAddedMsg struct{ name string }
type projectRemovedMsg struct{ name string }
type errMsg struct{ err error }

// ── States ──

type viewState int

const (
	stateList viewState = iota
	stateAddForm
	stateConfirmRemove
)

// ── Model ──

type View struct {
	state     viewState
	projects  []Project
	cursor    int
	pathInput textinput.Model
	nameInput textinput.Model
	formField int // 0=path, 1=name
	statusMsg string
	err       error
}

func NewView() View {
	pi := textinput.New()
	pi.Placeholder = "/path/to/project"
	pi.CharLimit = 256

	ni := textinput.New()
	ni.Placeholder = "project-name (auto-detected from path)"
	ni.CharLimit = 64

	return View{
		state:     stateList,
		pathInput: pi,
		nameInput: ni,
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
		v.projects = msg.projects
		if v.cursor >= len(v.projects) {
			v.cursor = max(0, len(v.projects)-1)
		}
		return v, nil

	case projectAddedMsg:
		v.state = stateList
		v.statusMsg = fmt.Sprintf("Added '%s'", msg.name)
		v.resetForm()
		return v, loadProjects

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

	if v.state == stateAddForm {
		return v.updateFormInput(msg)
	}

	return v, nil
}

func (v View) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch v.state {
	case stateList:
		return v.handleListKey(msg)
	case stateAddForm:
		return v.handleAddFormKey(msg)
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
		v.state = stateAddForm
		v.formField = 0
		v.err = nil
		v.statusMsg = ""
		v.pathInput.Focus()
		return v, v.pathInput.Cursor.BlinkCmd()
	case msg.String() == "d":
		if len(v.projects) > 0 {
			v.state = stateConfirmRemove
			v.statusMsg = ""
		}
		return v, nil
	}
	return v, nil
}

func (v View) handleAddFormKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		v.state = stateList
		v.resetForm()
		return v, nil
	case "tab":
		v.formField = (v.formField + 1) % 2
		v.pathInput.Blur()
		v.nameInput.Blur()
		if v.formField == 0 {
			v.pathInput.Focus()
			return v, v.pathInput.Cursor.BlinkCmd()
		}
		// Auto-detect name from path
		path := strings.TrimSpace(v.pathInput.Value())
		if path != "" && v.nameInput.Value() == "" {
			v.nameInput.SetValue(filepath.Base(expandHome(path)))
		}
		v.nameInput.Focus()
		return v, v.nameInput.Cursor.BlinkCmd()
	case "enter":
		return v, v.submitForm()
	}

	return v.updateFormInput(msg)
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

func (v View) updateFormInput(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	if v.formField == 0 {
		v.pathInput, cmd = v.pathInput.Update(msg)
	} else {
		v.nameInput, cmd = v.nameInput.Update(msg)
	}
	return v, cmd
}

func (v *View) resetForm() {
	v.pathInput.Reset()
	v.nameInput.Reset()
	v.formField = 0
	v.pathInput.Blur()
	v.nameInput.Blur()
}

func (v View) submitForm() tea.Cmd {
	path := strings.TrimSpace(v.pathInput.Value())
	name := strings.TrimSpace(v.nameInput.Value())

	return func() tea.Msg {
		if path == "" {
			return errMsg{fmt.Errorf("path cannot be empty")}
		}

		path = expandHome(path)
		info, err := os.Stat(path)
		if err != nil || !info.IsDir() {
			return errMsg{fmt.Errorf("directory not found: %s", path)}
		}

		absPath, err := filepath.Abs(path)
		if err != nil {
			return errMsg{err}
		}

		if name == "" {
			name = filepath.Base(absPath)
		}

		if err := Add(Project{Name: name, Path: absPath}); err != nil {
			return errMsg{err}
		}
		return projectAddedMsg{name}
	}
}

func (v View) View() string {
	var b strings.Builder

	switch v.state {
	case stateList:
		v.renderList(&b)
	case stateAddForm:
		v.renderAddForm(&b)
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
			b.WriteString("\n")
		}
	}

	b.WriteString("\n")
	if v.statusMsg != "" {
		b.WriteString("  ")
		b.WriteString(app.Success.Render(v.statusMsg))
		b.WriteString("\n\n")
	}

	b.WriteString("  ")
	b.WriteString(app.HelpStyle.Render("a add  d delete  esc back"))
	b.WriteString("\n")
}

func (v View) renderAddForm(b *strings.Builder) {
	b.WriteString("  Path: ")
	b.WriteString(v.pathInput.View())
	b.WriteString("\n")
	b.WriteString("  Name: ")
	b.WriteString(v.nameInput.View())
	b.WriteString("\n\n")

	if v.err != nil {
		b.WriteString("  ")
		b.WriteString(app.Error.Render(v.err.Error()))
		b.WriteString("\n\n")
	}

	b.WriteString("  ")
	b.WriteString(app.HelpStyle.Render("tab next field  enter add  esc cancel"))
	b.WriteString("\n")
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

func expandHome(path string) string {
	if strings.HasPrefix(path, "~/") {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, path[2:])
	}
	return path
}
