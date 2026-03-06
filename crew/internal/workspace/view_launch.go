package workspace

import (
	"fmt"
	"os"
	osexec "os/exec"
	"strings"
	"syscall"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
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
	launchModeClaude
)

var launchModeLabels = []string{
	"Editor + Agents",
	"Claude",
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
		editor := exec.DetectEditor()

		switch mode {
		case launchModeEditorAgents:
			if editor == "" {
				return errMsg{fmt.Errorf("no editor detected — install VS Code or Cursor, or use 'Claude' mode")}
			}
			return launchWithEditor(ws, editor, promptFile, WorkspaceDir(wsName))
		case launchModeClaude:
			return launchWithClaude(ws, promptFile)
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

func launchWithClaude(ws *Workspace, promptFile string) tea.Msg {
	claudePath, err := osexec.LookPath("claude")
	if err != nil {
		return errMsg{fmt.Errorf("claude not found in PATH")}
	}

	debug.Log("claude", "launching claude session for workspace %s", ws.Name)

	args := []string{"claude"}
	env := os.Environ()
	workDir := ProjectPath(ws.Name, ws.Projects[0].Name)

	if len(ws.Projects) > 1 {
		workDir = WorkspaceDir(ws.Name)
		for _, wp := range ws.Projects {
			args = append(args, "--add-dir", ProjectPath(ws.Name, wp.Name))
		}

		prompt, err := os.ReadFile(promptFile)
		if err != nil {
			return errMsg{fmt.Errorf("failed to read prompt file: %w", err)}
		}
		args = append(args, "--", string(prompt))
		env = setEnv(env, "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "1")
	}

	if config.UserSetClaudeConfig {
		env = setEnv(env, "CLAUDE_CONFIG_DIR", config.ClaudeConfigDir)
	}

	debug.Log("claude", "exec %s (cwd: %s, args: %v)", claudePath, workDir, args)

	if err := os.Chdir(workDir); err != nil {
		return errMsg{fmt.Errorf("failed to chdir to %s: %w", workDir, err)}
	}

	if err := syscall.Exec(claudePath, args, env); err != nil {
		return errMsg{fmt.Errorf("exec claude: %w", err)}
	}

	return launchExecutedMsg{}
}

func setEnv(env []string, key, value string) []string {
	prefix := key + "="
	for i, e := range env {
		if strings.HasPrefix(e, prefix) {
			env[i] = prefix + value
			return env
		}
	}
	return append(env, prefix+value)
}
