package settings

import (
	"fmt"
	"os"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/trash"
	"github.com/FurlanLuka/crew/crew/internal/uninstall"
)

// ── Messages ──

type settingsLoadedMsg struct{ settings config.Settings }
type savedMsg struct{}
type refreshedMsg struct{}
type uninstalledMsg struct{ report uninstall.Report }
type trashSizedMsg struct {
	bytes   int64
	entries int
}
type trashEmptiedMsg struct{}
type errMsg struct{ err error }

// ── States ──

type viewState int

const (
	stateView viewState = iota
	stateEdit
	stateConfirmUninstall
	stateConfirmEmptyTrash
)

// ── Model ──

type View struct {
	state     viewState
	settings  config.Settings
	inputs    [3]textinput.Model
	focus     int
	statusMsg string
	err       error

	// The trash walk can take a while on a big one, so its row shows the
	// spinner until the size lands.
	spinner      spinner.Model
	trashBytes   int64
	trashEntries int
	trashSized   bool
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

	sp := spinner.New()
	sp.Spinner = spinner.Dot
	sp.Style = app.Highlight

	return View{state: stateView, inputs: inputs, spinner: sp}
}

func (v View) Title() string { return "Settings" }

func (v View) Init() tea.Cmd {
	return tea.Batch(loadSettings, sizeTrash, v.spinner.Tick)
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

	case trashSizedMsg:
		v.trashBytes, v.trashEntries, v.trashSized = msg.bytes, msg.entries, true
		return v, nil

	case trashEmptiedMsg:
		v.state = stateView
		v.statusMsg = "Trash emptied"
		v.err = nil
		v.trashSized = false
		return v, tea.Batch(sizeTrash, v.spinner.Tick)

	case spinner.TickMsg:
		if v.trashSized {
			return v, nil
		}
		var cmd tea.Cmd
		v.spinner, cmd = v.spinner.Update(msg)
		return v, cmd

	case uninstalledMsg:
		// The binary is gone; say so on the way out.
		return v, func() tea.Msg {
			return app.ExitWithOutputMsg{Output: uninstallSummary(msg.report)}
		}

	case errMsg:
		v.state = stateView
		v.err = msg.err
		return v, nil

	case tea.KeyMsg:
		switch v.state {
		case stateEdit:
			return v.handleEditKey(msg)
		case stateConfirmUninstall:
			return v.handleConfirmUninstallKey(msg)
		case stateConfirmEmptyTrash:
			return v.handleConfirmEmptyTrashKey(msg)
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
	case msg.String() == "u":
		v.state = stateConfirmUninstall
		v.statusMsg = ""
		v.err = nil
		return v, nil
	case msg.String() == "t":
		if v.trashSized && v.trashEntries == 0 {
			v.statusMsg = "Trash is empty"
			return v, nil
		}
		v.state = stateConfirmEmptyTrash
		v.statusMsg = ""
		v.err = nil
		return v, nil
	}
	return v, nil
}

func (v View) handleConfirmEmptyTrashKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "y", "Y":
		return v, emptyTrash
	default:
		v.state = stateView
		return v, nil
	}
}

// handleConfirmUninstallKey: k keeps ~/.crew (config and every checkout),
// p removes it all. Anything else backs out.
func (v View) handleConfirmUninstallKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "k", "K":
		return v, runUninstall(false)
	case "p", "P":
		return v, runUninstall(true)
	default:
		v.state = stateView
		return v, nil
	}
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
	case stateConfirmUninstall:
		v.renderConfirmUninstall(&b)
	case stateConfirmEmptyTrash:
		fmt.Fprintf(&b, "  Delete %s from the trash now? (y/n)\n", v.trashSummary())
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
	b.WriteString("  Trash:      ")
	b.WriteString(v.renderTrash())
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
	b.WriteString(app.HelpStyle.Render("e edit  r refresh configs  t empty trash  u uninstall crew  esc back"))
	b.WriteString("\n")
}

// renderTrash: removed checkouts are cleared in the background; this row is
// where to see whether that happened, and t is the way to force it.
func (v View) renderTrash() string {
	if !v.trashSized {
		return v.spinner.View() + " " + app.Subtle.Render("measuring "+config.TrashDir)
	}
	if v.trashEntries == 0 {
		return app.Subtle.Render("empty")
	}
	return v.trashSummary() + "  " + app.Subtle.Render("clearing in background — t deletes now")
}

func (v View) trashSummary() string {
	noun := "entries"
	if v.trashEntries == 1 {
		noun = "entry"
	}
	return fmt.Sprintf("%s in %d %s", app.FormatBytes(v.trashBytes), v.trashEntries, noun)
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

func (v View) renderConfirmUninstall(b *strings.Builder) {
	bin, _ := os.Executable()
	b.WriteString("  Uninstall crew?\n\n")
	fmt.Fprintf(b, "  Stops every dev server and removes %s.\n\n", bin)
	fmt.Fprintf(b, "  %s  keep %s — workspace config and every checkout stay\n", app.Selected.Render("k"), config.ConfigDir)
	fmt.Fprintf(b, "  %s  purge — remove every checkout through git and delete %s\n", app.Error.Render("p"), config.ConfigDir)
	b.WriteString("\n  ")
	b.WriteString(app.HelpStyle.Render("k keep  p purge  esc cancel"))
	b.WriteString("\n")
}

// ── Commands ──

func uninstallSummary(r uninstall.Report) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Removed %s\n", r.Binary)
	for _, ws := range r.Workspaces {
		fmt.Fprintf(&b, "Removed workspace %s\n", ws)
	}
	if r.Kept != "" {
		fmt.Fprintf(&b, "Kept %s\n", r.Kept)
	}
	return b.String()
}

func runUninstall(purge bool) tea.Cmd {
	return func() tea.Msg {
		report, err := uninstall.Run(purge)
		if err != nil {
			return errMsg{err}
		}
		return uninstalledMsg{report}
	}
}

func sizeTrash() tea.Msg {
	bytes, entries := trash.Size()
	return trashSizedMsg{bytes: bytes, entries: entries}
}

func emptyTrash() tea.Msg {
	if err := trash.Empty(); err != nil {
		return errMsg{err}
	}
	return trashEmptiedMsg{}
}

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
	return refreshedMsg{}
}
