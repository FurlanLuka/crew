package notify

import (
	"strings"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
)

// ── Messages ──

type statusLoadedMsg struct {
	enabled bool
	topic   string
}
type setupDoneMsg struct{ topic string }
type testDoneMsg struct{}
type removedMsg struct{}
type errMsg struct{ err error }

// ── States ──

type viewState int

const (
	stateStatus viewState = iota
	stateSetup
)

// ── Model ──

type View struct {
	state     viewState
	enabled   bool
	topic     string
	input     textinput.Model
	statusMsg string
	err       error
}

func NewView() View {
	ti := textinput.New()
	ti.Placeholder = "crew-xxxxxxxx"
	ti.CharLimit = 64

	return View{
		state: stateStatus,
		input: ti,
	}
}

func (v View) Title() string { return "Notifications" }

func (v View) Init() tea.Cmd {
	return loadStatus
}

func (v View) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return v, nil

	case statusLoadedMsg:
		v.enabled = msg.enabled
		v.topic = msg.topic
		return v, nil

	case setupDoneMsg:
		v.enabled = true
		v.topic = msg.topic
		v.state = stateStatus
		v.statusMsg = "Notifications enabled"
		v.input.Reset()
		return v, nil

	case testDoneMsg:
		v.statusMsg = "Test notification sent"
		return v, nil

	case removedMsg:
		v.enabled = false
		v.topic = ""
		v.statusMsg = "Notifications removed"
		return v, nil

	case errMsg:
		v.err = msg.err
		return v, nil

	case tea.KeyMsg:
		if v.state == stateSetup {
			return v.handleSetupKey(msg)
		}
		return v.handleStatusKey(msg)
	}

	if v.state == stateSetup {
		var cmd tea.Cmd
		v.input, cmd = v.input.Update(msg)
		return v, cmd
	}

	return v, nil
}

func (v View) handleStatusKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		return v, func() tea.Msg { return app.PopPageMsg{} }
	case msg.String() == "s":
		v.state = stateSetup
		v.statusMsg = ""
		v.err = nil
		defaultTopic := GenerateTopic()
		v.input.SetValue(defaultTopic)
		v.input.Focus()
		return v, v.input.Cursor.BlinkCmd()
	case msg.String() == "t":
		if v.enabled {
			return v, testNotification(v.topic)
		}
		return v, nil
	case msg.String() == "d":
		if v.enabled {
			return v, removeNotification
		}
		return v, nil
	}
	return v, nil
}

func (v View) handleSetupKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		v.state = stateStatus
		v.input.Reset()
		return v, nil
	case "enter":
		topic := strings.TrimSpace(v.input.Value())
		if topic == "" {
			return v, nil
		}
		return v, setupNotification(topic)
	}

	var cmd tea.Cmd
	v.input, cmd = v.input.Update(msg)
	return v, cmd
}

func (v View) View() string {
	var b strings.Builder

	switch v.state {
	case stateStatus:
		v.renderStatus(&b)
	case stateSetup:
		v.renderSetup(&b)
	}

	return b.String()
}

func (v View) renderStatus(b *strings.Builder) {
	status := app.Error.Render("Disabled")
	if v.enabled {
		status = app.Success.Render("Enabled")
	}

	b.WriteString("  Status: ")
	b.WriteString(status)
	b.WriteString("\n")

	if v.topic != "" {
		b.WriteString("  Topic:  ")
		b.WriteString(v.topic)
		b.WriteString("\n")
		b.WriteString("  URL:    ")
		b.WriteString(app.Subtle.Render("https://ntfy.sh/" + v.topic))
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
	b.WriteString(app.HelpStyle.Render("s setup  t test  d remove  esc back"))
	b.WriteString("\n")
}

func (v View) renderSetup(b *strings.Builder) {
	b.WriteString("  Topic: ")
	b.WriteString(v.input.View())
	b.WriteString("\n\n")

	b.WriteString("  ")
	b.WriteString(app.HelpStyle.Render("enter setup  esc cancel"))
	b.WriteString("\n")
}

// ── Commands ──

func loadStatus() tea.Msg {
	topic := ExtractTopic()
	return statusLoadedMsg{
		enabled: topic != "",
		topic:   topic,
	}
}

func setupNotification(topic string) tea.Cmd {
	return func() tea.Msg {
		if err := Setup(topic); err != nil {
			return errMsg{err}
		}
		return setupDoneMsg{topic}
	}
}

func testNotification(topic string) tea.Cmd {
	return func() tea.Msg {
		if err := TestNotification(topic); err != nil {
			return errMsg{err}
		}
		return testDoneMsg{}
	}
}

func removeNotification() tea.Msg {
	if err := RemoveHook(); err != nil {
		return errMsg{err}
	}
	return removedMsg{}
}
