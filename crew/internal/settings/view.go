package settings

import (
	"strings"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/exec"
)

// ── Messages ──

type settingsLoadedMsg struct{ settings config.Settings }
type savedMsg struct{}
type refreshedMsg struct{}
type errMsg struct{ err error }

// ── States ──

type viewState int

const (
	stateView viewState = iota
	stateEdit
)

// ── Model ──

type View struct {
	state     viewState
	settings  config.Settings
	inputs    [3]textinput.Model
	focus     int
	statusMsg string
	err       error
}

func NewView() View {
	var inputs [3]textinput.Model

	inputs[0] = textinput.New()
	inputs[0].Placeholder = "10.138.0.32"
	inputs[0].CharLimit = 45

	inputs[1] = textinput.New()
	inputs[1].Placeholder = "crew-dev"
	inputs[1].CharLimit = 64

	inputs[2] = textinput.New()
	inputs[2].Placeholder = "example.com"
	inputs[2].CharLimit = 253

	return View{state: stateView, inputs: inputs}
}

func (v View) Title() string { return "Settings" }

func (v View) Init() tea.Cmd {
	return loadSettings
}

func (v View) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return v, nil

	case settingsLoadedMsg:
		v.settings = msg.settings
		return v, nil

	case savedMsg:
		v.state = stateView
		v.statusMsg = "Settings saved"
		v.settings = config.LoadSettings()
		return v, nil

	case refreshedMsg:
		v.statusMsg = "Configs refreshed"
		return v, nil

	case errMsg:
		v.err = msg.err
		return v, nil

	case tea.KeyMsg:
		if v.state == stateEdit {
			return v.handleEditKey(msg)
		}
		return v.handleViewKey(msg)
	}

	if v.state == stateEdit {
		return v.updateInputs(msg)
	}

	return v, nil
}

func (v View) handleViewKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		return v, func() tea.Msg { return app.PopPageMsg{} }
	case msg.String() == "e":
		v.state = stateEdit
		v.focus = 0
		v.statusMsg = ""
		v.err = nil
		v.inputs[0].SetValue(v.settings.ServerIP)
		v.inputs[1].SetValue(v.settings.SSHHost)
		v.inputs[2].SetValue(v.settings.Domain)
		v.inputs[0].Focus()
		v.inputs[1].Blur()
		v.inputs[2].Blur()
		return v, v.inputs[0].Cursor.BlinkCmd()
	case msg.String() == "r":
		return v, refreshConfigs
	}
	return v, nil
}

func (v View) handleEditKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		v.state = stateView
		return v, nil
	case "tab", "shift+tab":
		v.inputs[v.focus].Blur()
		v.focus = (v.focus + 1) % len(v.inputs)
		v.inputs[v.focus].Focus()
		return v, v.inputs[v.focus].Cursor.BlinkCmd()
	case "enter":
		s := config.Settings{
			ServerIP: strings.TrimSpace(v.inputs[0].Value()),
			SSHHost:  strings.TrimSpace(v.inputs[1].Value()),
			Domain:   strings.TrimSpace(v.inputs[2].Value()),
		}
		return v, saveSettings(s)
	}

	return v.updateInputs(msg)
}

func (v View) updateInputs(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd
	for i := range v.inputs {
		var cmd tea.Cmd
		v.inputs[i], cmd = v.inputs[i].Update(msg)
		cmds = append(cmds, cmd)
	}
	return v, tea.Batch(cmds...)
}

func (v View) View() string {
	var b strings.Builder

	switch v.state {
	case stateView:
		v.renderView(&b)
	case stateEdit:
		v.renderEdit(&b)
	}

	return b.String()
}

func (v View) renderView(b *strings.Builder) {
	serverIP := v.settings.ServerIP
	if serverIP == "" {
		serverIP = app.Subtle.Render("not set")
	}

	sshHost := v.settings.SSHHost
	if sshHost == "" {
		sshHost = app.Subtle.Render("not set")
	}

	domain := v.settings.Domain
	if domain == "" {
		domain = app.Subtle.Render("not set")
	}

	b.WriteString("  Server IP:  ")
	b.WriteString(serverIP)
	b.WriteString("\n")
	b.WriteString("  SSH Host:   ")
	b.WriteString(sshHost)
	b.WriteString("\n")
	b.WriteString("  Domain:     ")
	b.WriteString(domain)
	b.WriteString("\n")

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
	b.WriteString(app.HelpStyle.Render("e edit  r refresh configs  esc back"))
	b.WriteString("\n")
}

func (v View) renderEdit(b *strings.Builder) {
	b.WriteString("  Server IP:  ")
	b.WriteString(v.inputs[0].View())
	b.WriteString("\n")
	b.WriteString("  SSH Host:   ")
	b.WriteString(v.inputs[1].View())
	b.WriteString("\n")
	b.WriteString("  Domain:     ")
	b.WriteString(v.inputs[2].View())
	b.WriteString("\n\n")

	b.WriteString("  ")
	b.WriteString(app.HelpStyle.Render("tab next  enter save  esc cancel"))
	b.WriteString("\n")
}

// ── Commands ──

func loadSettings() tea.Msg {
	return settingsLoadedMsg{settings: config.LoadSettings()}
}

func saveSettings(s config.Settings) tea.Cmd {
	return func() tea.Msg {
		if err := config.SaveSettings(s); err != nil {
			return errMsg{err}
		}
		return savedMsg{}
	}
}

func refreshConfigs() tea.Msg {
	exec.EnsureTmuxConfig()
	exec.EnsureLazygitConfig()
	return refreshedMsg{}
}
