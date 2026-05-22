package workspace

import (
	"fmt"
	osexec "os/exec"
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
	hasEditor   bool
	noTeamsMode bool // workspace qualifies for the "no teams" launch modes
}
type launchExecutedMsg struct{}

// claudeExecReadyMsg carries a Claude command to run directly in the current
// terminal. Claude takes over the terminal until it exits — no tmux, no
// session tracking, no reattach.
type claudeExecReadyMsg struct {
	cmd *osexec.Cmd
}

// ── Launch modes ──

const (
	launchModeEditorClaude = iota
	launchModeEditorClaudeYolo
	launchModeEditorClaudeNoTeams
	launchModeEditorClaudeNoTeamsYolo
	launchModeClaude
	launchModeClaudeYolo
	launchModeClaudeNoTeams
	launchModeClaudeNoTeamsYolo
)

var launchModeLabels = []string{
	"Editor + Claude",
	"Editor + Claude (Skip permissions)",
	"Editor + Claude (No teams)",
	"Editor + Claude (No teams, Skip permissions)",
	"Claude",
	"Claude (Skip permissions)",
	"Claude (No teams)",
	"Claude (No teams, Skip permissions)",
}

// launchModeNoTeams reports whether mode runs Claude in flat (no-agent-team) form.
func launchModeNoTeams(mode int) bool {
	return mode == launchModeEditorClaudeNoTeams || mode == launchModeEditorClaudeNoTeamsYolo
}

// availableLaunchModes returns the launch modes to display for a workspace.
// The "no teams" modes only make sense when there's more than one worktree
// project — single-project workspaces never use teams, and direct-mode
// projects don't share a common root for Claude to start in.
func availableLaunchModes(includeNoTeams bool) []int {
	modes := []int{launchModeEditorClaude, launchModeEditorClaudeYolo}
	if includeNoTeams {
		modes = append(modes, launchModeEditorClaudeNoTeams, launchModeEditorClaudeNoTeamsYolo)
	}
	modes = append(modes, launchModeClaude, launchModeClaudeYolo)
	if includeNoTeams {
		modes = append(modes, launchModeClaudeNoTeams, launchModeClaudeNoTeamsYolo)
	}
	return modes
}

// ── States ──

type launchState int

const (
	launchStateMode launchState = iota
	launchStateLaunching
)

// ── Model ──

type LaunchView struct {
	base        string
	state       launchState
	hasEditor   bool
	noTeamsMode bool // true if workspace qualifies for no-teams launch (multi-project, all worktree)
	modes       []int
	modeCursor  int
	spinner     spinner.Model
	err         error
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
	wsName := v.base
	return func() tea.Msg {
		editor := exec.DetectEditor()
		noTeams := false
		if ws, err := Load(wsName); err == nil && len(ws.Projects) > 1 {
			allWorktree := true
			for _, wp := range ws.Projects {
				if IsDirect(wp) {
					allWorktree = false
					break
				}
			}
			noTeams = allWorktree
		}
		return launchDataLoadedMsg{
			hasEditor:   editor != "",
			noTeamsMode: noTeams,
		}
	}
}

func (v LaunchView) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return v, nil

	case launchDataLoadedMsg:
		v.hasEditor = msg.hasEditor
		v.noTeamsMode = msg.noTeamsMode
		v.modes = availableLaunchModes(v.noTeamsMode)
		if v.modeCursor >= len(v.modes) {
			v.modeCursor = 0
		}
		return v, nil

	case launchExecutedMsg:
		return v, tea.Quit

	case claudeExecReadyMsg:
		return v, tea.ExecProcess(msg.cmd, func(err error) tea.Msg {
			if err != nil {
				return errMsg{err}
			}
			return launchExecutedMsg{}
		})

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
		if v.modeCursor < len(v.modes)-1 {
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

	for i, mode := range v.modes {
		cursor := "  "
		if i == v.modeCursor {
			cursor = app.Selected.Render("> ")
		}
		display := launchModeLabels[mode]
		if i == v.modeCursor {
			display = app.Selected.Render(display)
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
	if v.modeCursor >= len(v.modes) {
		return func() tea.Msg { return errMsg{fmt.Errorf("no launch mode selected")} }
	}
	mode := v.modes[v.modeCursor]

	return func() tea.Msg {
		switch mode {
		case launchModeEditorClaude, launchModeEditorClaudeYolo,
			launchModeEditorClaudeNoTeams, launchModeEditorClaudeNoTeamsYolo:
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
			skipPerms := mode == launchModeEditorClaudeYolo || mode == launchModeEditorClaudeNoTeamsYolo
			if launchModeNoTeams(mode) {
				return launchWithEditorNoTeams(ws, editor, skipPerms)
			}
			return launchWithEditor(ws, editor, skipPerms)

		case launchModeClaude, launchModeClaudeYolo:
			return launchClaude(wsName, mode == launchModeClaudeYolo, false)

		case launchModeClaudeNoTeams, launchModeClaudeNoTeamsYolo:
			return launchClaude(wsName, mode == launchModeClaudeNoTeamsYolo, true)
		}

		return launchExecutedMsg{}
	}
}

func launchWithEditor(ws *Workspace, editor string, skipPermissions bool) tea.Msg {
	wsFile := CodeWorkspaceFilePath(ws.Name)

	projects := make([]exec.WorkspaceProject, len(ws.Projects))
	for i, wp := range ws.Projects {
		projects[i] = exec.WorkspaceProject{
			Name: wp.Name,
			Path: ResolvePath(ws.Name, wp),
		}
	}

	multiProject := len(ws.Projects) > 1
	leadPath := ResolvePath(ws.Name, ws.Projects[0])

	claude := &exec.ClaudeTask{
		LeadPath:        leadPath,
		AgentTeams:      multiProject,
		SkipPermissions: skipPermissions,
	}

	if config.UserSetClaudeConfig {
		claude.ClaudeConfigDir = config.ClaudeConfigDir
	}

	if multiProject {
		if _, err := GeneratePrompt(ws); err != nil {
			return errMsg{err}
		}
		claude.PromptFile = PromptFilePath(ws.Name)
		claude.LeadPath = WorkspaceDir(ws.Name)
		for _, p := range projects[1:] {
			claude.AddDirs = append(claude.AddDirs, p.Path)
		}
	}

	if err := exec.GenerateCodeWorkspace(wsFile, projects, claude); err != nil {
		return errMsg{err}
	}
	if err := exec.OpenEditor(editor, wsFile); err != nil {
		return errMsg{err}
	}
	return launchExecutedMsg{}
}

// launchWithEditorNoTeams runs a single flat Claude instance at the workspace
// root with all project worktrees exposed via --add-dir. The initial prompt
// just lists project locations and roles — no agent team coordination.
func launchWithEditorNoTeams(ws *Workspace, editor string, skipPermissions bool) tea.Msg {
	wsFile := CodeWorkspaceFilePath(ws.Name)

	projects := make([]exec.WorkspaceProject, len(ws.Projects))
	addDirs := make([]string, 0, len(ws.Projects))
	for i, wp := range ws.Projects {
		path := ResolvePath(ws.Name, wp)
		projects[i] = exec.WorkspaceProject{Name: wp.Name, Path: path}
		addDirs = append(addDirs, path)
	}

	if _, err := GenerateNoTeamsPrompt(ws); err != nil {
		return errMsg{err}
	}

	claude := &exec.ClaudeTask{
		LeadPath:        WorkspaceDir(ws.Name),
		PromptFile:      NoTeamsPromptFilePath(ws.Name),
		AddDirs:         addDirs,
		AgentTeams:      false,
		SkipPermissions: skipPermissions,
	}
	if config.UserSetClaudeConfig {
		claude.ClaudeConfigDir = config.ClaudeConfigDir
	}

	if err := exec.GenerateCodeWorkspace(wsFile, projects, claude); err != nil {
		return errMsg{err}
	}
	if err := exec.OpenEditor(editor, wsFile); err != nil {
		return errMsg{err}
	}
	return launchExecutedMsg{}
}

// launchClaude runs Claude for the workspace directly in the current terminal
// via tea.ExecProcess — no tmux, no session tracking. noTeams selects the flat
// (no-agent-team) form for multi-project workspaces.
func launchClaude(wsName string, skipPermissions, noTeams bool) tea.Msg {
	cmd, err := ClaudeCommand(wsName, skipPermissions, noTeams)
	if err != nil {
		return errMsg{err}
	}
	return claudeExecReadyMsg{cmd: cmd}
}

