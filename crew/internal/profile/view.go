package profile

import (
	"strings"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
)

// ── Messages ──

type profileStatusMsg struct {
	installed bool
	path      string
}
type profileContentMsg struct{ content string }
type profileInstalledMsg struct{}
type profileRemovedMsg struct{}
type profileUpdatedMsg struct{ updated bool }
type errMsg struct{ err error }

// ── States ──

type viewState int

const (
	stateStatus viewState = iota
	stateShow
)

// ── Model ──

type View struct {
	state     viewState
	installed bool
	path      string
	viewport  viewport.Model
	statusMsg string
	err       error
	width     int
	height    int
}

func NewView() View {
	return View{state: stateStatus}
}

func (v View) Title() string { return "Profile" }

func (v View) Init() tea.Cmd {
	return checkProfileStatus
}

func (v View) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		v.width = msg.Width
		v.height = msg.Height
		if v.state == stateShow {
			v.viewport.Width = msg.Width
			v.viewport.Height = msg.Height - 8
		}
		return v, nil

	case profileStatusMsg:
		v.installed = msg.installed
		v.path = msg.path
		return v, nil

	case profileContentMsg:
		v.state = stateShow
		v.viewport = viewport.New(v.width, max(v.height-8, 10))
		v.viewport.SetContent(msg.content)
		return v, nil

	case profileInstalledMsg:
		v.installed = true
		v.statusMsg = "Profile installed"
		return v, nil

	case profileRemovedMsg:
		v.installed = false
		v.statusMsg = "Profile removed"
		return v, nil

	case profileUpdatedMsg:
		if msg.updated {
			v.statusMsg = "Profile updated"
		} else {
			v.statusMsg = "Profile already up to date"
		}
		return v, nil

	case errMsg:
		v.err = msg.err
		return v, nil

	case tea.KeyMsg:
		if v.state == stateShow {
			return v.handleShowKey(msg)
		}
		return v.handleStatusKey(msg)
	}

	if v.state == stateShow {
		var cmd tea.Cmd
		v.viewport, cmd = v.viewport.Update(msg)
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
	case msg.String() == "i":
		if !v.installed {
			return v, installProfile
		}
		return v, nil
	case msg.String() == "s":
		if v.installed {
			return v, showProfile
		}
		return v, nil
	case msg.String() == "u":
		if v.installed {
			return v, updateProfile
		}
		return v, nil
	case msg.String() == "d":
		if v.installed {
			return v, removeProfile
		}
		return v, nil
	}
	return v, nil
}

func (v View) handleShowKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, app.Keys.Back):
		v.state = stateStatus
		return v, nil
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	}

	var cmd tea.Cmd
	v.viewport, cmd = v.viewport.Update(msg)
	return v, cmd
}

func (v View) View() string {
	var b strings.Builder

	switch v.state {
	case stateStatus:
		v.renderStatus(&b)
	case stateShow:
		b.WriteString(v.viewport.View())
		b.WriteString("\n\n  ")
		b.WriteString(app.HelpStyle.Render("↑/↓ scroll  esc back"))
		b.WriteString("\n")
	}

	return b.String()
}

func (v View) renderStatus(b *strings.Builder) {
	status := app.Error.Render("Not installed")
	if v.installed {
		status = app.Success.Render("Installed")
	}

	b.WriteString("  Status: ")
	b.WriteString(status)
	b.WriteString("\n")
	b.WriteString("  Path:   ")
	b.WriteString(app.Subtle.Render(v.path))
	b.WriteString("\n\n")

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
	b.WriteString(app.HelpStyle.Render("i install  s show  u update  d remove  esc back"))
	b.WriteString("\n")
}

// ── Commands ──

func checkProfileStatus() tea.Msg {
	return profileStatusMsg{
		installed: IsInstalled(),
		path:      Path(),
	}
}

func installProfile() tea.Msg {
	if err := Install(); err != nil {
		return errMsg{err}
	}
	return profileInstalledMsg{}
}

func showProfile() tea.Msg {
	content, err := Content()
	if err != nil {
		return errMsg{err}
	}
	return profileContentMsg{content}
}

func updateProfile() tea.Msg {
	updated, err := Update()
	if err != nil {
		return errMsg{err}
	}
	return profileUpdatedMsg{updated}
}

func removeProfile() tea.Msg {
	if err := Remove(); err != nil {
		return errMsg{err}
	}
	return profileRemovedMsg{}
}
