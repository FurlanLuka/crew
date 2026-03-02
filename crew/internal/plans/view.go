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
	running bool
	url     string
}
type startedMsg struct{ url string }
type stoppedMsg struct{}
type errMsg struct{ err error }

// ── Model ──

type View struct {
	running   bool
	url       string
	loading   bool
	actionMsg string
	spinner   spinner.Model
	statusMsg string
	err       error
}

func NewView() View {
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
		v.running = msg.running
		v.url = msg.url
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
		v.url = ""
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

	case msg.String() == "s":
		if !v.running {
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
	b.WriteString(app.HelpStyle.Render("s start  x stop  esc back"))
	b.WriteString("\n")

	return b.String()
}

// ── Commands ──

func loadStatus() tea.Msg {
	running := IsRunning()
	url := ""
	if running {
		url = URL()
	}
	return statusLoadedMsg{
		running: running,
		url:     url,
	}
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
