package plans

import (
	"strings"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
)

// ── Messages ──

type statusLoadedMsg struct {
	enabled bool
	running bool
	url     string
}
type enabledMsg struct{}
type disabledMsg struct{}
type startedMsg struct{ url string }
type stoppedMsg struct{}
type errMsg struct{ err error }

// ── Model ──

type View struct {
	enabled   bool
	running   bool
	url       string
	loading   bool
	actionMsg string
	spinner   spinner.Model
	statusMsg string
	err       error
}

func NewView() View {
	sp := spinner.New()
	sp.Spinner = spinner.Dot
	return View{}
}

func (v View) Title() string { return "Plans" }

func (v View) Init() tea.Cmd {
	return loadStatus
}

func (v View) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return v, nil

	case statusLoadedMsg:
		v.enabled = msg.enabled
		v.running = msg.running
		v.url = msg.url
		return v, nil

	case enabledMsg:
		v.loading = false
		v.enabled = true
		v.statusMsg = "Plan viewer enabled"
		return v, nil

	case disabledMsg:
		v.loading = false
		v.enabled = false
		v.running = false
		v.url = ""
		v.statusMsg = "Plan viewer disabled"
		return v, nil

	case startedMsg:
		v.loading = false
		v.running = true
		v.url = msg.url
		v.statusMsg = "Plan viewer started"
		return v, nil

	case stoppedMsg:
		v.loading = false
		v.running = false
		v.statusMsg = "Plan viewer stopped"
		return v, nil

	case errMsg:
		v.loading = false
		v.err = msg.err
		return v, nil

	case spinner.TickMsg:
		if v.loading {
			var cmd tea.Cmd
			v.spinner, cmd = v.spinner.Update(msg)
			return v, cmd
		}
		return v, nil

	case tea.KeyMsg:
		if v.loading {
			return v, nil
		}
		return v.handleKey(msg)
	}

	return v, nil
}

func (v View) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		return v, func() tea.Msg { return app.PopPageMsg{} }

	case msg.String() == "e":
		if !v.enabled {
			v.loading = true
			v.actionMsg = "Installing claude-plan-viewer..."
			v.statusMsg = ""
			v.err = nil
			v.spinner = spinner.New()
			v.spinner.Spinner = spinner.Dot
			return v, tea.Batch(v.spinner.Tick, enablePlans)
		}
		return v, nil

	case msg.String() == "d":
		if v.enabled {
			v.statusMsg = ""
			v.err = nil
			return v, disablePlans
		}
		return v, nil

	case msg.String() == "s":
		if v.enabled && !v.running {
			v.loading = true
			v.actionMsg = "Starting plan viewer..."
			v.statusMsg = ""
			v.err = nil
			v.spinner = spinner.New()
			v.spinner.Spinner = spinner.Dot
			return v, tea.Batch(v.spinner.Tick, startPlans)
		}
		return v, nil

	case msg.String() == "x":
		if v.running {
			v.statusMsg = ""
			v.err = nil
			return v, stopPlans
		}
		return v, nil
	}

	return v, nil
}

func (v View) View() string {
	var b strings.Builder

	if v.loading {
		b.WriteString("  ")
		b.WriteString(v.spinner.View())
		b.WriteString(" ")
		b.WriteString(v.actionMsg)
		b.WriteString("\n")
		return b.String()
	}

	status := app.Error.Render("disabled")
	if v.enabled {
		status = app.Success.Render("enabled")
	}
	b.WriteString("  Status:  ")
	b.WriteString(status)
	b.WriteString("\n")

	server := app.Error.Render("stopped")
	if v.running {
		server = app.Success.Render("running")
	}
	b.WriteString("  Server:  ")
	b.WriteString(server)
	b.WriteString("\n")

	if v.url != "" {
		b.WriteString("  URL:     ")
		b.WriteString(app.Subtle.Render(v.url))
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
	b.WriteString(app.HelpStyle.Render("e enable  d disable  s start  x stop  esc back"))
	b.WriteString("\n")

	return b.String()
}

// ── Commands ──

func loadStatus() tea.Msg {
	cfg := LoadConfig()
	running := IsRunning()
	url := ""
	if running {
		url = URL()
	}
	return statusLoadedMsg{
		enabled: cfg.Enabled,
		running: running,
		url:     url,
	}
}

func enablePlans() tea.Msg {
	if !IsInstalled() {
		if err := Install(); err != nil {
			return errMsg{err}
		}
	}
	cfg := LoadConfig()
	cfg.Enabled = true
	if err := SaveConfig(cfg); err != nil {
		return errMsg{err}
	}
	return enabledMsg{}
}

func disablePlans() tea.Msg {
	if IsRunning() {
		Stop()
	}
	cfg := LoadConfig()
	cfg.Enabled = false
	if err := SaveConfig(cfg); err != nil {
		return errMsg{err}
	}
	return disabledMsg{}
}

func startPlans() tea.Msg {
	cfg := LoadConfig()
	if err := Start(cfg.Port); err != nil {
		return errMsg{err}
	}
	return startedMsg{url: URL()}
}

func stopPlans() tea.Msg {
	Stop()
	return stoppedMsg{}
}
