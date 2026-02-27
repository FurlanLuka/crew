package workspace

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/homebrew-tap/crew/internal/app"
	"github.com/FurlanLuka/homebrew-tap/crew/internal/exec"
)

// ── Messages ──

type worktreesLoadedMsg struct{ names []string }
type worktreeCreatedMsg struct{ name string }
type worktreeRemovedMsg struct{ name string }
type worktreePushedMsg struct{ name string }

// ── States ──

type wtViewState int

const (
	wtStateList wtViewState = iota
	wtStateCreate
	wtStateConfirmRemove
)

// ── Model ──

type WorktreeView struct {
	base        string
	state       wtViewState
	worktrees   []string
	cursor      int
	input       textinput.Model
	branchInput textinput.Model
	focusField  int // 0=name, 1=branch
	statusMsg   string
	err         error
}

func NewWorktreeView(base string) WorktreeView {
	ti := textinput.New()
	ti.Placeholder = "feature-name"
	ti.CharLimit = 64

	bi := textinput.New()
	bi.Placeholder = "leave empty for HEAD"
	bi.CharLimit = 128

	return WorktreeView{
		base:        base,
		state:       wtStateList,
		input:       ti,
		branchInput: bi,
	}
}

func (v WorktreeView) Title() string {
	return fmt.Sprintf("Worktrees for \"%s\"", v.base)
}

func (v WorktreeView) Init() tea.Cmd {
	return v.loadWorktrees()
}

func (v WorktreeView) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return v, nil

	case worktreesLoadedMsg:
		v.worktrees = msg.names
		if v.cursor >= len(v.worktrees) {
			v.cursor = max(0, len(v.worktrees)-1)
		}
		return v, nil

	case worktreeCreatedMsg:
		v.state = wtStateList
		v.statusMsg = fmt.Sprintf("Created worktree '%s'", msg.name)
		v.input.Reset()
		v.branchInput.Reset()
		return v, v.loadWorktrees()

	case worktreeRemovedMsg:
		v.state = wtStateList
		v.statusMsg = fmt.Sprintf("Removed worktree '%s'", msg.name)
		return v, v.loadWorktrees()

	case worktreePushedMsg:
		v.statusMsg = fmt.Sprintf("Pushed worktree '%s'", msg.name)
		return v, nil

	case errMsg:
		v.err = msg.err
		v.state = wtStateList
		return v, nil

	case tea.KeyMsg:
		return v.handleKey(msg)
	}

	// Forward to text inputs
	if v.state == wtStateCreate {
		return v.updateInputs(msg)
	}

	return v, nil
}

func (v WorktreeView) updateInputs(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	if v.focusField == 0 {
		v.input, cmd = v.input.Update(msg)
	} else {
		v.branchInput, cmd = v.branchInput.Update(msg)
	}
	return v, cmd
}

func (v WorktreeView) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch v.state {
	case wtStateList:
		return v.handleListKey(msg)
	case wtStateCreate:
		return v.handleCreateKey(msg)
	case wtStateConfirmRemove:
		return v.handleConfirmRemoveKey(msg)
	}
	return v, nil
}

func (v WorktreeView) handleListKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		return v, func() tea.Msg { return app.PopPageMsg{} }
	case key.Matches(msg, app.Keys.Up):
		if v.cursor > 0 {
			v.cursor--
		}
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		if v.cursor < len(v.worktrees)-1 {
			v.cursor++
		}
		return v, nil
	case msg.String() == "n":
		v.state = wtStateCreate
		v.focusField = 0
		v.statusMsg = ""
		v.err = nil
		v.input.Focus()
		return v, v.input.Cursor.BlinkCmd()
	case msg.String() == "d":
		if len(v.worktrees) > 0 {
			v.state = wtStateConfirmRemove
			v.statusMsg = ""
		}
		return v, nil
	case msg.String() == "p":
		if len(v.worktrees) > 0 {
			name := v.worktrees[v.cursor]
			return v, v.pushWorktree(name)
		}
		return v, nil
	}
	return v, nil
}

func (v WorktreeView) handleCreateKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		v.state = wtStateList
		v.input.Reset()
		v.branchInput.Reset()
		return v, nil
	case "tab":
		if v.focusField == 0 {
			v.focusField = 1
			v.input.Blur()
			v.branchInput.Focus()
			return v, v.branchInput.Cursor.BlinkCmd()
		}
		v.focusField = 0
		v.branchInput.Blur()
		v.input.Focus()
		return v, v.input.Cursor.BlinkCmd()
	case "enter":
		name := strings.TrimSpace(v.input.Value())
		if name == "" {
			return v, nil
		}
		return v, v.startWorktreeCreation(name, strings.TrimSpace(v.branchInput.Value()))
	}

	return v.updateInputs(msg)
}

func (v WorktreeView) handleConfirmRemoveKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "y", "Y":
		name := v.worktrees[v.cursor]
		v.state = wtStateList
		return v, v.removeWorktree(name)
	default:
		v.state = wtStateList
		return v, nil
	}
}

func (v WorktreeView) View() string {
	var b strings.Builder

	switch v.state {
	case wtStateList:
		v.renderList(&b)
	case wtStateCreate:
		v.renderCreate(&b)
	case wtStateConfirmRemove:
		v.renderConfirmRemove(&b)
	}

	return b.String()
}

func (v WorktreeView) renderList(b *strings.Builder) {
	if len(v.worktrees) == 0 {
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render("No worktrees."))
		b.WriteString("\n\n")
		b.WriteString("  ")
		b.WriteString(app.HelpStyle.Render("n new  esc back"))
		b.WriteString("\n")
		return
	}

	for i, name := range v.worktrees {
		cursor := "  "
		if i == v.cursor {
			cursor = app.Selected.Render("> ")
		}

		display := name
		if i == v.cursor {
			display = app.Selected.Render(name)
		}

		b.WriteString(cursor)
		b.WriteString(display)
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
	b.WriteString(app.HelpStyle.Render("n new  d delete  p push  esc back"))
	b.WriteString("\n")
}

func (v WorktreeView) renderCreate(b *strings.Builder) {
	b.WriteString("  Name:   ")
	b.WriteString(v.input.View())
	b.WriteString("\n")
	b.WriteString("  Branch: ")
	b.WriteString(v.branchInput.View())
	b.WriteString("\n\n")

	if v.err != nil {
		b.WriteString("  ")
		b.WriteString(app.Error.Render(v.err.Error()))
		b.WriteString("\n\n")
	}

	b.WriteString("  ")
	b.WriteString(app.HelpStyle.Render("tab switch field  enter create  esc cancel"))
	b.WriteString("\n")
}

func (v WorktreeView) renderConfirmRemove(b *strings.Builder) {
	name := v.worktrees[v.cursor]
	b.WriteString(fmt.Sprintf("  Remove worktree '%s'? (y/n)\n", name))
}

// ── Commands ──

func (v WorktreeView) loadWorktrees() tea.Cmd {
	base := v.base
	return func() tea.Msg {
		names, err := ListWorktrees(base)
		if err != nil {
			return errMsg{err}
		}
		return worktreesLoadedMsg{names}
	}
}

func (v WorktreeView) startWorktreeCreation(name, fromBranch string) tea.Cmd {
	base := v.base
	return func() tea.Msg {
		safeName := NormalizeName(name)
		wtWs := WorktreeWorkspaceName(base, safeName)
		if Exists(wtWs) {
			return errMsg{fmt.Errorf("worktree '%s' already exists", safeName)}
		}

		ws, err := Load(base)
		if err != nil {
			return errMsg{err}
		}

		if len(ws.Projects) == 0 {
			return errMsg{fmt.Errorf("workspace '%s' has no projects", base)}
		}

		// Create worktree workspace config
		branch := "worktree-" + name
		wtWorkspace := &Workspace{
			Name: wtWs,
			Worktree: &WorktreeInfo{
				BaseWorkspace: base,
				Name:          safeName,
			},
			Projects: make([]Project, len(ws.Projects)),
		}
		for i, p := range ws.Projects {
			wtWorkspace.Projects[i] = Project{
				Name: p.Name,
				Path: p.Path + "/.claude/worktrees/" + safeName,
				Role: p.Role,
			}
		}
		if err := Save(wtWorkspace); err != nil {
			return errMsg{err}
		}

		// Create git worktrees for each project
		for _, p := range ws.Projects {
			wtDir := p.Path + "/.claude/worktrees/" + safeName
			if err := exec.CreateGitWorktree(p.Path, wtDir, branch, fromBranch); err != nil {
				return errMsg{fmt.Errorf("failed to create worktree for %s: %w", p.Name, err)}
			}
			exec.EnsureGitignore(p.Path)
			exec.CopyEnvFiles(p.Path, wtDir)
			exec.RunNpmInstall(wtDir)
		}

		return worktreeCreatedMsg{safeName}
	}
}

func (v WorktreeView) removeWorktree(name string) tea.Cmd {
	base := v.base
	return func() tea.Msg {
		wtWs := WorktreeWorkspaceName(base, name)

		// Kill tmux session
		session := "crew-" + wtWs
		exec.KillTmuxSession(session)

		// Remove git worktrees using base project paths
		ws, err := Load(base)
		if err == nil {
			for _, p := range ws.Projects {
				wtDir := p.Path + "/.claude/worktrees/" + name
				exec.RemoveGitWorktree(p.Path, wtDir)
			}
		}

		Remove(wtWs)
		return worktreeRemovedMsg{name}
	}
}

func (v WorktreeView) pushWorktree(name string) tea.Cmd {
	base := v.base
	return func() tea.Msg {
		wtWs := WorktreeWorkspaceName(base, name)
		ws, err := Load(wtWs)
		if err != nil {
			return errMsg{err}
		}

		for _, p := range ws.Projects {
			exec.PushBranch(p.Path)
		}

		return worktreePushedMsg{name}
	}
}
