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

// ── Launch modes ──

const (
	launchModeEditorAgents = iota
	launchModeAgentsOnly
	launchModeHappier
)

var launchModeLabels = []string{
	"Editor + Agents",
	"Agents only (tmux)",
	"Happier",
}

// ── States ──

type launchState int

const (
	launchStateMode launchState = iota
	launchStateLaunching
)

// ── Model ──

type LaunchView struct {
	base       string
	state      launchState
	hasEditor  bool
	modeCursor int
	spinner    spinner.Model
	err        error
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
	if v.state == launchStateMode {
		return v.handleModeKey(msg)
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

func (v LaunchView) View() string {
	var b strings.Builder

	switch v.state {
	case launchStateMode:
		v.renderModeSelect(&b)
	case launchStateLaunching:
		b.WriteString("  ")
		b.WriteString(v.spinner.View())
		b.WriteString(" Launching...\n")
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

// ── Launch logic ──

func (v LaunchView) executeLaunch() tea.Cmd {
	wsName := v.base
	mode := v.modeCursor

	return func() tea.Msg {
		ws, err := Load(wsName)
		if err != nil {
			return errMsg{err}
		}
		if len(ws.Projects) == 0 {
			return errMsg{fmt.Errorf("workspace '%s' has no projects", wsName)}
		}

		if !exec.HasClaude() {
			return errMsg{fmt.Errorf("claude not found — install Claude Code first")}
		}

		if _, err := GeneratePrompt(ws); err != nil {
			return errMsg{err}
		}
		promptFile := PromptFilePath(wsName)
		firstProjectDir := ProjectPath(wsName, ws.Projects[0].Name)
		editor := exec.DetectEditor()

		switch mode {
		case launchModeEditorAgents:
			if editor != "" {
				return launchWithEditor(ws, editor, promptFile, WorkspaceDir(wsName))
			}
			return launchWithTmux(ws, promptFile, firstProjectDir)
		case launchModeAgentsOnly:
			return launchWithTmux(ws, promptFile, firstProjectDir)
		case launchModeHappier:
			return launchWithHappier(ws)
		}

		return launchExecutedMsg{}
	}
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

func launchWithTmux(ws *Workspace, promptFile, sessionDir string) tea.Msg {
	if !exec.HasTmux() {
		return errMsg{fmt.Errorf("tmux not found — install with: brew install tmux")}
	}

	session := "crew-" + ws.Name

	if exec.TmuxSessionExists(session) {
		exec.AttachTmuxSession(session)
		return launchExecutedMsg{}
	}

	if err := exec.CreateTmuxSession(session, sessionDir); err != nil {
		return errMsg{err}
	}

	claudeCmd := "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude"
	for _, wp := range ws.Projects[1:] {
		claudeCmd += fmt.Sprintf(" --add-dir %s", ProjectPath(ws.Name, wp.Name))
	}
	claudeCmd += fmt.Sprintf(` "$(cat '%s')"`, promptFile)
	exec.TmuxSendKeys(session, claudeCmd)

	exec.AttachTmuxSession(session)
	return launchExecutedMsg{}
}

func launchWithHappier(ws *Workspace) tea.Msg {
	_, err := StartHappierSession(ws)
	if err != nil {
		return errMsg{err}
	}
	return launchExecutedMsg{}
}

// StartHappierSession creates (or reuses) a Happier tmux session for the
// given workspace. Returns the session name.
func StartHappierSession(ws *Workspace) (string, error) {
	if !exec.HasHappier() {
		return "", fmt.Errorf("happier CLI not found — install from https://happier.dev/install")
	}
	if !exec.HasTmux() {
		return "", fmt.Errorf("tmux not found — install with: brew install tmux")
	}
	if len(ws.Projects) == 0 {
		return "", fmt.Errorf("workspace has no projects")
	}

	session := "crew-" + ws.Name

	if exec.TmuxSessionExists(session) {
		return session, nil
	}

	if _, err := GeneratePrompt(ws); err != nil {
		return "", err
	}

	sessionDir := WorkspaceDir(ws.Name)
	if err := exec.CreateTmuxSession(session, sessionDir); err != nil {
		return "", err
	}

	promptFile := PromptFilePath(ws.Name)
	happierCmd := fmt.Sprintf(`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 happier "$(cat '%s')"`, promptFile)
	exec.TmuxSendKeys(session, happierCmd)

	return session, nil
}
