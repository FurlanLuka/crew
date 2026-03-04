package project

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
)

// ── Messages ──

type devServersLoadedMsg struct{ items []devItem }
type devServerSavedMsg struct{}
type devServerRemovedMsg struct{}

// ── States ──

type devViewState int

const (
	devStateList devViewState = iota
	devStateForm
	devStateConfirmRemove
)

// ── Data ──

type devItem struct {
	Server DevServer
}

// ── Model ──

type DevServerView struct {
	projName  string
	state     devViewState
	items     []devItem
	cursor    int
	inputs    [4]textinput.Model // name, port, command, dir
	formField int
	editIdx   int // -1 for add, >= 0 for edit
	statusMsg string
	err       error
}

func NewDevServerView(projName string) DevServerView {
	var inputs [4]textinput.Model
	placeholders := [4]string{"web", "5173", "npm run dev", "apps/web (optional)"}
	limits := [4]int{32, 6, 128, 128}
	for i := range inputs {
		inputs[i] = textinput.New()
		inputs[i].Placeholder = placeholders[i]
		inputs[i].CharLimit = limits[i]
	}

	return DevServerView{
		projName: projName,
		state:    devStateList,
		inputs:   inputs,
		editIdx:  -1,
	}
}

func (v DevServerView) Title() string {
	return fmt.Sprintf("Dev Servers for \"%s\"", v.projName)
}

func (v DevServerView) Init() tea.Cmd {
	return v.loadDevServers()
}

func (v DevServerView) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return v, nil

	case devServersLoadedMsg:
		v.items = msg.items
		if v.cursor >= len(v.items) {
			v.cursor = max(0, len(v.items)-1)
		}
		return v, nil

	case devServerSavedMsg:
		v.state = devStateList
		v.statusMsg = "Server saved"
		v.err = nil
		v.resetForm()
		return v, v.loadDevServers()

	case devServerRemovedMsg:
		v.state = devStateList
		v.statusMsg = "Server removed"
		v.err = nil
		return v, v.loadDevServers()

	case errMsg:
		v.err = msg.err
		return v, nil

	case tea.KeyMsg:
		return v.handleKey(msg)
	}

	if v.state == devStateForm {
		return v.updateFormInputs(msg)
	}

	return v, nil
}

func (v DevServerView) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch v.state {
	case devStateList:
		return v.handleListKey(msg)
	case devStateForm:
		return v.handleFormKey(msg)
	case devStateConfirmRemove:
		return v.handleConfirmRemoveKey(msg)
	}
	return v, nil
}

func (v DevServerView) handleListKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
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
		if v.cursor < len(v.items)-1 {
			v.cursor++
		}
		return v, nil
	case msg.String() == "a":
		v.resetForm()
		v.statusMsg = ""
		v.err = nil
		v.editIdx = -1
		v.state = devStateForm
		v.inputs[0].Focus()
		return v, v.inputs[0].Cursor.BlinkCmd()
	case msg.String() == "e":
		if len(v.items) > 0 {
			v.prefillForm(v.cursor)
			v.state = devStateForm
			v.inputs[0].Focus()
			return v, v.inputs[0].Cursor.BlinkCmd()
		}
		return v, nil
	case msg.String() == "d":
		if len(v.items) > 0 {
			v.state = devStateConfirmRemove
			v.statusMsg = ""
		}
		return v, nil
	}
	return v, nil
}

func (v DevServerView) handleFormKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		v.state = devStateList
		v.resetForm()
		return v, nil
	case "tab":
		v.inputs[v.formField].Blur()
		v.formField = (v.formField + 1) % 4
		v.inputs[v.formField].Focus()
		return v, v.inputs[v.formField].Cursor.BlinkCmd()
	case "enter":
		return v, v.saveServer()
	}
	return v.updateFormInputs(msg)
}

func (v DevServerView) handleConfirmRemoveKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "y", "Y":
		item := v.items[v.cursor]
		v.state = devStateList
		return v, v.removeServer(item.Server.Name)
	default:
		v.state = devStateList
		return v, nil
	}
}

func (v DevServerView) updateFormInputs(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	v.inputs[v.formField], cmd = v.inputs[v.formField].Update(msg)
	return v, cmd
}

func (v *DevServerView) resetForm() {
	for i := range v.inputs {
		v.inputs[i].Reset()
		v.inputs[i].Blur()
	}
	v.formField = 0
	v.editIdx = -1
}

func (v *DevServerView) prefillForm(idx int) {
	item := v.items[idx]
	v.editIdx = idx
	v.inputs[0].SetValue(item.Server.Name)
	v.inputs[1].SetValue(strconv.Itoa(item.Server.Port))
	v.inputs[2].SetValue(item.Server.Command)
	v.inputs[3].SetValue(item.Server.Dir)
	v.formField = 0
}

// ── View ──

func (v DevServerView) View() string {
	var b strings.Builder

	switch v.state {
	case devStateList:
		v.renderList(&b)
	case devStateForm:
		v.renderForm(&b)
	case devStateConfirmRemove:
		v.renderConfirmRemove(&b)
	}

	return b.String()
}

func (v DevServerView) renderList(b *strings.Builder) {
	if len(v.items) == 0 {
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render("No dev servers configured."))
		b.WriteString("\n\n")
		b.WriteString("  ")
		b.WriteString(app.HelpStyle.Render("a add  esc back"))
		b.WriteString("\n")
		return
	}

	for i, item := range v.items {
		cursor := "  "
		if i == v.cursor {
			cursor = app.Selected.Render("> ")
		}

		name := item.Server.Name
		if i == v.cursor {
			name = app.Selected.Render(name)
		}

		port := fmt.Sprintf(":%d", item.Server.Port)

		b.WriteString(cursor)
		b.WriteString(fmt.Sprintf("%-12s %-8s %s", name, port, app.Subtle.Render(item.Server.Command)))
		if item.Server.Dir != "" {
			b.WriteString("  ")
			b.WriteString(app.Subtle.Render("dir:" + item.Server.Dir))
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

	b.WriteString("  ")
	b.WriteString(app.HelpStyle.Render("a add  e edit  d delete  esc back"))
	b.WriteString("\n")
}

func (v DevServerView) renderForm(b *strings.Builder) {
	action := "Adding server"
	if v.editIdx >= 0 {
		action = "Editing server"
	}
	b.WriteString(fmt.Sprintf("  %s\n\n", action))

	labels := [4]string{"Name:    ", "Port:    ", "Command: ", "Dir:     "}
	for i, label := range labels {
		b.WriteString("  ")
		b.WriteString(label)
		b.WriteString(v.inputs[i].View())
		b.WriteString("\n")
	}

	b.WriteString("\n  ")
	b.WriteString(app.HelpStyle.Render("tab next field  enter save  esc cancel"))
	b.WriteString("\n")
}

func (v DevServerView) renderConfirmRemove(b *strings.Builder) {
	item := v.items[v.cursor]
	b.WriteString(fmt.Sprintf("  Remove server '%s'? (y/n)\n", item.Server.Name))
}

// ── Commands ──

func (v DevServerView) loadDevServers() tea.Cmd {
	projName := v.projName
	return func() tea.Msg {
		p := Get(projName)
		if p == nil {
			return errMsg{fmt.Errorf("project '%s' not found", projName)}
		}

		var items []devItem
		for _, ds := range p.DevServers {
			items = append(items, devItem{Server: ds})
		}
		return devServersLoadedMsg{items}
	}
}

func (v DevServerView) saveServer() tea.Cmd {
	projName := v.projName
	nameVal := strings.TrimSpace(v.inputs[0].Value())
	portStr := strings.TrimSpace(v.inputs[1].Value())
	cmdVal := strings.TrimSpace(v.inputs[2].Value())
	dirVal := strings.TrimSpace(v.inputs[3].Value())

	return func() tea.Msg {
		if nameVal == "" || portStr == "" || cmdVal == "" {
			return errMsg{fmt.Errorf("name, port, and command are required")}
		}

		port, err := strconv.Atoi(portStr)
		if err != nil || port <= 0 {
			return errMsg{fmt.Errorf("invalid port number")}
		}

		ds := DevServer{Name: nameVal, Port: port, Command: cmdVal, Dir: dirVal}
		if err := AddDevServer(projName, ds); err != nil {
			return errMsg{err}
		}
		return devServerSavedMsg{}
	}
}

func (v DevServerView) removeServer(serverName string) tea.Cmd {
	projName := v.projName
	return func() tea.Msg {
		if err := RemoveDevServer(projName, serverName); err != nil {
			return errMsg{err}
		}
		return devServerRemovedMsg{}
	}
}
