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
	hasEditor bool
}
type launchExecutedMsg struct{}

// claudeExecReadyMsg carries a Claude command to run directly in the current
// terminal. Claude takes over the terminal until it exits — no tmux, no
// session tracking, no reattach.
type claudeExecReadyMsg struct {
	cmd *osexec.Cmd
}

// ── Launch modes ──

// Both modes skip permissions and run a single flat Claude instance; agent
// teams are no longer offered.
const (
	launchModeEditorClaude = iota
	launchModeClaude
)

var launchModeLabels = []string{
	"Editor + Claude (Skip permissions)",
	"Claude (Skip permissions)",
}

// availableLaunchModes returns the launch modes to display. The editor mode is
// hidden rather than offered-and-failed when no editor is installed — with only
// two modes, leaving it in would make half the menu a dead end.
func availableLaunchModes(hasEditor bool) []int {
	if !hasEditor {
		return []int{launchModeClaude}
	}
	return []int{launchModeEditorClaude, launchModeClaude}
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
	modes      []int
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
		return launchDataLoadedMsg{hasEditor: exec.DetectEditor() != ""}
	}
}

func (v LaunchView) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return v, nil

	case launchDataLoadedMsg:
		v.modes = availableLaunchModes(msg.hasEditor)
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
		case launchModeEditorClaude:
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
			return launchWithEditor(ws, editor)

		case launchModeClaude:
			return launchClaude(wsName)
		}

		return launchExecutedMsg{}
	}
}

// launchWithEditor opens the workspace in the editor with a Claude task wired
// up. A multi-project workspace runs one flat Claude at the workspace root with
// every project exposed via --add-dir; a single-project workspace starts in the
// project itself and needs no orientation prompt.
func launchWithEditor(ws *Workspace, editor string) tea.Msg {
	wsFile := CodeWorkspaceFilePath(ws.Name)

	projects := make([]exec.WorkspaceProject, len(ws.Projects))
	for i, wp := range ws.Projects {
		projects[i] = exec.WorkspaceProject{
			Name: wp.Name,
			Path: ResolvePath(ws.Name, wp),
		}
	}

	if needsPrompt(ws) {
		if _, err := GeneratePrompt(ws); err != nil {
			return errMsg{err}
		}
	}

	if err := exec.GenerateCodeWorkspace(wsFile, projects, claudeTaskFor(ws)); err != nil {
		return errMsg{err}
	}
	if err := exec.OpenEditor(editor, wsFile); err != nil {
		return errMsg{err}
	}
	return launchExecutedMsg{}
}

// claudeTaskFor builds the editor's Claude task for a workspace. It mirrors
// buildClaudeParts, which does the same job for the terminal launch mode — the
// two must agree on working directory and exposed directories.
func claudeTaskFor(ws *Workspace) *exec.ClaudeTask {
	claude := &exec.ClaudeTask{
		LeadPath:        ResolvePath(ws.Name, ws.Projects[0]),
		SkipPermissions: true,
	}
	if config.UserSetClaudeConfig {
		claude.ClaudeConfigDir = config.ClaudeConfigDir
	}

	if len(ws.Projects) > 1 {
		claude.LeadPath = WorkspaceDir(ws.Name)
		for _, wp := range ws.Projects {
			claude.AddDirs = append(claude.AddDirs, ResolvePath(ws.Name, wp))
		}
	}
	if needsPrompt(ws) {
		claude.PromptFile = PromptFilePath(ws.Name)
	}
	return claude
}

// launchClaude runs Claude for the workspace directly in the current terminal
// via tea.ExecProcess — no tmux, no session tracking.
func launchClaude(wsName string) tea.Msg {
	cmd, err := ClaudeCommand(wsName)
	if err != nil {
		return errMsg{err}
	}
	return claudeExecReadyMsg{cmd: cmd}
}
