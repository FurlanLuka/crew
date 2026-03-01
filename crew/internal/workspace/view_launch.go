package workspace

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/homebrew-tap/crew/internal/app"
	"github.com/FurlanLuka/homebrew-tap/crew/internal/config"
	"github.com/FurlanLuka/homebrew-tap/crew/internal/exec"
)

// ── Messages ──

type launchDataLoadedMsg struct {
	worktrees []string
	hasEditor bool
}
type launchExecutedMsg struct{}
type worktreeCreatedForLaunchMsg struct{ name string }

// ── Launch modes ──

const (
	launchModeEditorAgents = iota
	launchModeAgentsOnly
	launchModeHappy
)

var launchModeLabels = []string{
	"Editor + Agents",
	"Agents only (tmux)",
	"Happy Coder",
}

// ── Special worktree options ──

const (
	optNewWorktree = "+ New worktree"
	optNoWorktree  = "No worktree (original)"
)

// ── States ──

type launchState int

const (
	launchStateWorktree launchState = iota
	launchStateNewWorktree
	launchStateMode
	launchStateLaunching
)

// ── Model ──

type LaunchView struct {
	base       string
	state      launchState
	worktrees  []string // existing worktree names
	options    []string // display options: worktrees + "New worktree" + "No worktree"
	wtCursor   int
	hasEditor  bool
	modeCursor int
	nameInput  textinput.Model
	branchInput textinput.Model
	formField   int // 0=name, 1=branch
	selectedWt string // resolved worktree name or "" for base
	err        error
}

func NewLaunchView(base string) LaunchView {
	ni := textinput.New()
	ni.Placeholder = "feature-name"
	ni.CharLimit = 64

	bi := textinput.New()
	bi.Placeholder = "leave empty for HEAD"
	bi.CharLimit = 128

	return LaunchView{
		base:        base,
		state:       launchStateWorktree,
		nameInput:   ni,
		branchInput: bi,
	}
}

func (v LaunchView) Title() string {
	return fmt.Sprintf("Launch \"%s\"", v.base)
}

func (v LaunchView) Init() tea.Cmd {
	base := v.base
	return func() tea.Msg {
		wts, _ := ListWorktrees(base)
		editor := exec.DetectEditor()
		return launchDataLoadedMsg{
			worktrees: wts,
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
		v.worktrees = msg.worktrees
		v.buildOptions()
		return v, nil

	case worktreeCreatedForLaunchMsg:
		// Worktree was created, select it and proceed to mode
		v.selectedWt = msg.name
		v.state = launchStateMode
		v.nameInput.Reset()
		v.branchInput.Reset()
		return v, nil

	case launchExecutedMsg:
		return v, tea.Quit

	case errMsg:
		v.err = msg.err
		return v, nil

	case tea.KeyMsg:
		return v.handleKey(msg)
	}

	// Forward to text inputs in new worktree form
	if v.state == launchStateNewWorktree {
		return v.updateInputs(msg)
	}

	return v, nil
}

func (v *LaunchView) buildOptions() {
	v.options = nil
	for _, wt := range v.worktrees {
		v.options = append(v.options, wt)
	}
	v.options = append(v.options, optNewWorktree, optNoWorktree)
}

func (v LaunchView) updateInputs(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	if v.formField == 0 {
		v.nameInput, cmd = v.nameInput.Update(msg)
	} else {
		v.branchInput, cmd = v.branchInput.Update(msg)
	}
	return v, cmd
}

func (v LaunchView) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch v.state {
	case launchStateWorktree:
		return v.handleWorktreeKey(msg)
	case launchStateNewWorktree:
		return v.handleNewWorktreeKey(msg)
	case launchStateMode:
		return v.handleModeKey(msg)
	}
	return v, nil
}

func (v LaunchView) handleWorktreeKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		return v, func() tea.Msg { return app.PopPageMsg{} }
	case key.Matches(msg, app.Keys.Up):
		if v.wtCursor > 0 {
			v.wtCursor--
		}
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		if v.wtCursor < len(v.options)-1 {
			v.wtCursor++
		}
		return v, nil
	case msg.String() == "enter":
		selected := v.options[v.wtCursor]
		switch selected {
		case optNewWorktree:
			v.state = launchStateNewWorktree
			v.formField = 0
			v.nameInput.Focus()
			return v, v.nameInput.Cursor.BlinkCmd()
		case optNoWorktree:
			v.selectedWt = ""
			v.state = launchStateMode
			return v, nil
		default:
			// Existing worktree
			v.selectedWt = selected
			v.state = launchStateMode
			return v, nil
		}
	}
	return v, nil
}

func (v LaunchView) handleNewWorktreeKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		v.state = launchStateWorktree
		v.nameInput.Reset()
		v.branchInput.Reset()
		return v, nil
	case "tab":
		if v.formField == 0 {
			v.formField = 1
			v.nameInput.Blur()
			v.branchInput.Focus()
			return v, v.branchInput.Cursor.BlinkCmd()
		}
		v.formField = 0
		v.branchInput.Blur()
		v.nameInput.Focus()
		return v, v.nameInput.Cursor.BlinkCmd()
	case "enter":
		name := strings.TrimSpace(v.nameInput.Value())
		if name == "" {
			return v, nil
		}
		fromBranch := strings.TrimSpace(v.branchInput.Value())
		return v, v.createWorktreeForLaunch(name, fromBranch)
	}

	return v.updateInputs(msg)
}

func (v LaunchView) handleModeKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		v.state = launchStateWorktree
		return v, nil
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
		return v, v.executeLaunch()
	}
	return v, nil
}

func (v LaunchView) View() string {
	var b strings.Builder

	switch v.state {
	case launchStateWorktree:
		v.renderWorktreeSelect(&b)
	case launchStateNewWorktree:
		v.renderNewWorktreeForm(&b)
	case launchStateMode:
		v.renderModeSelect(&b)
	case launchStateLaunching:
		b.WriteString("  Launching...\n")
	}

	if v.err != nil {
		b.WriteString("\n  ")
		b.WriteString(app.Error.Render(v.err.Error()))
		b.WriteString("\n")
	}

	return b.String()
}

func (v LaunchView) renderWorktreeSelect(b *strings.Builder) {
	b.WriteString("  ")
	b.WriteString(app.Subtle.Render("Worktree:"))
	b.WriteString("\n")

	for i, opt := range v.options {
		cursor := "  "
		if i == v.wtCursor {
			cursor = app.Selected.Render("> ")
		}
		display := opt
		if i == v.wtCursor {
			display = app.Selected.Render(opt)
		}
		b.WriteString("  ")
		b.WriteString(cursor)
		b.WriteString(display)
		b.WriteString("\n")
	}

	b.WriteString("\n  ")
	b.WriteString(app.HelpStyle.Render("enter select  esc cancel"))
	b.WriteString("\n")
}

func (v LaunchView) renderNewWorktreeForm(b *strings.Builder) {
	b.WriteString("  Name:   ")
	b.WriteString(v.nameInput.View())
	b.WriteString("\n")
	b.WriteString("  Branch: ")
	b.WriteString(v.branchInput.View())
	b.WriteString("\n\n")

	b.WriteString("  ")
	b.WriteString(app.HelpStyle.Render("tab switch field  enter create  esc cancel"))
	b.WriteString("\n")
}

func (v LaunchView) renderModeSelect(b *strings.Builder) {
	// Show selected worktree context
	if v.selectedWt != "" {
		b.WriteString("  Worktree: ")
		b.WriteString(app.Highlight.Render(v.selectedWt))
		b.WriteString("\n\n")
	}

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

func (v LaunchView) resolvedWorkspace() string {
	if v.selectedWt == "" {
		return v.base
	}
	return WorktreeWorkspaceName(v.base, v.selectedWt)
}

func (v LaunchView) createWorktreeForLaunch(name, fromBranch string) tea.Cmd {
	base := v.base
	return func() tea.Msg {
		safeName := NormalizeName(name)
		wtWs := WorktreeWorkspaceName(base, safeName)

		if Exists(wtWs) {
			if worktreeDirsExist(base, safeName) {
				return errMsg{fmt.Errorf("worktree '%s' already exists", safeName)}
			}
			Remove(wtWs)
		}

		safeName, err := CreateWorktree(base, name, fromBranch)
		if err != nil {
			return errMsg{err}
		}
		return worktreeCreatedForLaunchMsg{safeName}
	}
}

func (v LaunchView) executeLaunch() tea.Cmd {
	launchWs := v.resolvedWorkspace()
	mode := v.modeCursor

	return func() tea.Msg {
		ws, err := Load(launchWs)
		if err != nil {
			return errMsg{err}
		}
		if len(ws.Projects) == 0 {
			return errMsg{fmt.Errorf("workspace '%s' has no projects", launchWs)}
		}

		if !exec.HasClaude() {
			return errMsg{fmt.Errorf("claude not found — install Claude Code first")}
		}

		if _, err := GeneratePrompt(ws); err != nil {
			return errMsg{err}
		}
		promptFile := PromptFilePath(launchWs)

		projectPath := ws.Projects[0].Path
		editor := exec.DetectEditor()

		switch mode {
		case launchModeEditorAgents:
			if editor != "" {
				editorRoot := filepath.Dir(projectPath)
				return launchWithEditor(ws, editor, promptFile, editorRoot)
			}
			return launchWithTmux(ws, promptFile, projectPath)
		case launchModeAgentsOnly:
			return launchWithTmux(ws, promptFile, projectPath)
		case launchModeHappy:
			return launchWithHappy(ws)
		}

		return launchExecutedMsg{}
	}
}

func launchWithEditor(ws *Workspace, editor, promptFile, editorRoot string) tea.Msg {
	wsFile := CodeWorkspaceFilePath(ws.Name)

	projects := make([]exec.WorkspaceProject, len(ws.Projects))
	for i, p := range ws.Projects {
		projects[i] = exec.WorkspaceProject{Name: p.Name, Path: p.Path}
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

	claudeCmd := fmt.Sprintf(`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude "$(cat '%s')"`, promptFile)
	exec.TmuxSendKeys(session, claudeCmd)

	exec.AttachTmuxSession(session)
	return launchExecutedMsg{}
}

func launchWithHappy(ws *Workspace) tea.Msg {
	session, err := StartHappySession(ws)
	if err != nil {
		return errMsg{err}
	}
	exec.AttachTmuxSession(session)
	return launchExecutedMsg{}
}

// StartHappySession creates (or reuses) a Happy Coder tmux session for the
// given workspace. Returns the session name.
func StartHappySession(ws *Workspace) (string, error) {
	if !exec.HasHappy() {
		return "", fmt.Errorf("happy CLI not found — install from https://happycoder.ai")
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

	if err := exec.CreateTmuxSession(session, ws.Projects[0].Path); err != nil {
		return "", err
	}

	promptFile := PromptFilePath(ws.Name)
	happyCmd := fmt.Sprintf("happy --prompt-file %s", promptFile)
	for _, p := range ws.Projects[1:] {
		happyCmd += fmt.Sprintf(" --add-dir %s", p.Path)
	}
	exec.TmuxSendKeys(session, happyCmd)

	return session, nil
}
