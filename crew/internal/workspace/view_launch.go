package workspace

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/exec"
)

// ── Messages ──

type launchDataLoadedMsg struct {
	hasEditor bool
}
type launchExecutedMsg struct{}

type claudeSessionReadyMsg struct {
	session string
}
type claudeSessionExistsMsg struct {
	wsName          string
	skipPermissions bool
}

// ── Launch modes ──

const (
	launchModeEditorAgents = iota
	launchModeClaude
	launchModeClaudeYolo
)

var launchModeLabels = []string{
	"Editor + Agents",
	"Claude",
	"Claude (Skip permissions)",
}

// ── States ──

type launchState int

const (
	launchStateMode launchState = iota
	launchStateLaunching
	launchStateSessionExists
)

// ── Model ──

type LaunchView struct {
	base             string
	state            launchState
	hasEditor        bool
	modeCursor       int
	sessionCursor    int
	sessionWsName    string
	sessionSkipPerms bool
	spinner          spinner.Model
	err              error
}

func NewLaunchView(base string) LaunchView {
	sp := spinner.New()
	sp.Spinner = spinner.Dot

	return LaunchView{
		base:    base,
		state:   launchStateMode,
		spinner: sp,
	}
}

func (v LaunchView) Title() string {
	return fmt.Sprintf("Launch \"%s\"", v.base)
}

func (v LaunchView) Init() tea.Cmd {
	return func() tea.Msg {
		editor := exec.DetectEditor()
		return launchDataLoadedMsg{
			hasEditor: editor != "",
		}
	}
}

func (v LaunchView) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return v, nil

	case launchDataLoadedMsg:
		v.hasEditor = msg.hasEditor
		return v, nil

	case launchExecutedMsg:
		return v, tea.Quit

	case claudeSessionReadyMsg:
		cmd := ClaudeAttachCmd(msg.session)
		return v, tea.ExecProcess(cmd, func(err error) tea.Msg {
			return launchExecutedMsg{}
		})

	case claudeSessionExistsMsg:
		v.state = launchStateSessionExists
		v.sessionCursor = 0
		v.sessionWsName = msg.wsName
		v.sessionSkipPerms = msg.skipPermissions
		return v, nil

	case errMsg:
		v.err = msg.err
		if v.state == launchStateLaunching {
			v.state = launchStateMode
		}
		return v, nil

	case spinner.TickMsg:
		if v.state == launchStateLaunching {
			var cmd tea.Cmd
			v.spinner, cmd = v.spinner.Update(msg)
			return v, cmd
		}
		return v, nil

	case tea.KeyMsg:
		return v.handleKey(msg)
	}

	return v, nil
}

func (v LaunchView) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch v.state {
	case launchStateMode:
		return v.handleModeKey(msg)
	case launchStateSessionExists:
		return v.handleSessionExistsKey(msg)
	}
	return v, nil
}

func (v LaunchView) handleModeKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		return v, func() tea.Msg { return app.PopPageMsg{} }
	case key.Matches(msg, app.Keys.Up):
		if v.modeCursor > 0 {
			v.modeCursor--
		}
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		if v.modeCursor < len(launchModeLabels)-1 {
			v.modeCursor++
		}
		return v, nil
	case msg.String() == "enter":
		v.state = launchStateLaunching
		return v, tea.Batch(v.spinner.Tick, v.executeLaunch())
	}
	return v, nil
}

func (v LaunchView) handleSessionExistsKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		v.state = launchStateMode
		return v, nil
	case key.Matches(msg, app.Keys.Up):
		if v.sessionCursor > 0 {
			v.sessionCursor--
		}
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		if v.sessionCursor < 1 {
			v.sessionCursor++
		}
		return v, nil
	case msg.String() == "enter":
		if v.sessionCursor == 0 {
			// Attach to existing session
			session := claudeSessionName(v.sessionWsName)
			return v, func() tea.Msg {
				return claudeSessionReadyMsg{session: session}
			}
		}
		// Stop and start new
		v.state = launchStateLaunching
		return v, tea.Batch(v.spinner.Tick, func() tea.Msg {
			KillClaudeSession(v.sessionWsName)
			session, err := CreateClaudeSession(v.sessionWsName, v.sessionSkipPerms)
			if err != nil {
				return errMsg{err}
			}
			return claudeSessionReadyMsg{session: session}
		})
	}
	return v, nil
}

func (v LaunchView) View() string {
	var b strings.Builder

	switch v.state {
	case launchStateMode:
		v.renderModeSelect(&b)
	case launchStateLaunching:
		b.WriteString("  ")
		b.WriteString(v.spinner.View())
		b.WriteString(" Launching...\n")
	case launchStateSessionExists:
		v.renderSessionExists(&b)
	}

	if v.err != nil {
		b.WriteString("\n  ")
		b.WriteString(app.Error.Render(v.err.Error()))
		b.WriteString("\n")
	}

	return b.String()
}

func (v LaunchView) renderModeSelect(b *strings.Builder) {
	b.WriteString("  ")
	b.WriteString(app.Subtle.Render("Mode:"))
	b.WriteString("\n")

	for i, label := range launchModeLabels {
		cursor := "  "
		if i == v.modeCursor {
			cursor = app.Selected.Render("> ")
		}
		display := label
		if i == v.modeCursor {
			display = app.Selected.Render(label)
		}
		b.WriteString("  ")
		b.WriteString(cursor)
		b.WriteString(display)
		b.WriteString("\n")
	}

	b.WriteString("\n  ")
	b.WriteString(app.HelpStyle.Render("enter launch  esc back"))
	b.WriteString("\n")
}

func (v LaunchView) renderSessionExists(b *strings.Builder) {
	b.WriteString("  ")
	b.WriteString(app.Subtle.Render("A Claude session already exists for this workspace:"))
	b.WriteString("\n")

	options := []string{"Attach to existing", "Stop and start new"}
	for i, label := range options {
		cursor := "  "
		if i == v.sessionCursor {
			cursor = app.Selected.Render("> ")
		}
		display := label
		if i == v.sessionCursor {
			display = app.Selected.Render(label)
		}
		b.WriteString("  ")
		b.WriteString(cursor)
		b.WriteString(display)
		b.WriteString("\n")
	}

	b.WriteString("\n  ")
	b.WriteString(app.HelpStyle.Render("enter select  esc back"))
	b.WriteString("\n")
}

// ── Launch logic ──

func (v LaunchView) executeLaunch() tea.Cmd {
	wsName := v.base
	mode := v.modeCursor

	return func() tea.Msg {
		switch mode {
		case launchModeEditorAgents:
			ws, err := Load(wsName)
			if err != nil {
				return errMsg{err}
			}
			if len(ws.Projects) == 0 {
				return errMsg{fmt.Errorf("workspace '%s' has no projects", wsName)}
			}
			editor := exec.DetectEditor()
			if editor == "" {
				return errMsg{fmt.Errorf("no editor detected — install VS Code or Cursor, or use 'Claude' mode")}
			}
			if _, err := GeneratePrompt(ws); err != nil {
				return errMsg{err}
			}
			promptFile := PromptFilePath(wsName)
			return launchWithEditor(ws, editor, promptFile, WorkspaceDir(wsName))

		case launchModeClaude, launchModeClaudeYolo:
			return launchClaude(wsName, mode == launchModeClaudeYolo)
		}

		return launchExecutedMsg{}
	}
}

func launchClaude(wsName string, skipPermissions bool) tea.Msg {
	if ClaudeSessionExists(wsName) {
		return claudeSessionExistsMsg{
			wsName:          wsName,
			skipPermissions: skipPermissions,
		}
	}

	session, err := CreateClaudeSession(wsName, skipPermissions)
	if err != nil {
		return errMsg{err}
	}
	return claudeSessionReadyMsg{session: session}
}

func launchWithEditor(ws *Workspace, editor, promptFile, editorRoot string) tea.Msg {
	wsFile := CodeWorkspaceFilePath(ws.Name)

	projects := make([]exec.WorkspaceProject, len(ws.Projects))
	for i, wp := range ws.Projects {
		projects[i] = exec.WorkspaceProject{
			Name: wp.Name,
			Path: ProjectPath(ws.Name, wp.Name),
		}
	}

	claudeDir := ""
	if config.UserSetClaudeConfig {
		claudeDir = config.ClaudeConfigDir
	}

	if err := exec.GenerateCodeWorkspace(wsFile, projects, promptFile, editorRoot, claudeDir, true); err != nil {
		return errMsg{err}
	}

	if err := exec.OpenEditor(editor, wsFile); err != nil {
		return errMsg{err}
	}

	return launchExecutedMsg{}
}
