package workspace

import (
	"fmt"
	"os"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/exec"
)

// ── Messages ──

type sessionsLoadedMsg struct{ sessions []SessionInfo }
type sessionStoppedMsg struct{ name string }
type sessionRemovedMsg struct{ name string }
type allSessionsStoppedMsg struct{}

// ── States ──

type sessViewState int

const (
	sessStateList sessViewState = iota
	sessStateConfirmStop
	sessStateConfirmRemove
	sessStateConfirmStopAll
	sessStateStopping
)

// ── Model ──

// SessionsView is the TUI for managing active sessions.
type SessionsView struct {
	state     sessViewState
	sessions  []SessionInfo
	cursor    int
	spinner   spinner.Model
	statusMsg string
	err       error
}

// NewSessionsView creates a new sessions TUI view.
func NewSessionsView() SessionsView {
	sp := spinner.New()
	sp.Spinner = spinner.Dot

	return SessionsView{
		state:   sessStateList,
		spinner: sp,
	}
}

func (v SessionsView) Title() string { return "Sessions" }

func (v SessionsView) Init() tea.Cmd {
	return loadSessions
}

func (v SessionsView) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return v, nil

	case sessionsLoadedMsg:
		v.sessions = msg.sessions
		if v.cursor >= len(v.sessions) {
			v.cursor = max(0, len(v.sessions)-1)
		}
		return v, nil

	case sessionStoppedMsg:
		v.state = sessStateList
		v.statusMsg = fmt.Sprintf("Stopped session '%s'", msg.name)
		v.err = nil
		return v, loadSessions

	case sessionRemovedMsg:
		v.state = sessStateList
		v.statusMsg = fmt.Sprintf("Removed session '%s'", msg.name)
		v.err = nil
		return v, loadSessions

	case allSessionsStoppedMsg:
		v.state = sessStateList
		v.statusMsg = "Stopped all sessions"
		v.err = nil
		return v, loadSessions

	case errMsg:
		v.err = msg.err
		v.state = sessStateList
		return v, loadSessions

	case spinner.TickMsg:
		if v.state == sessStateStopping {
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

func (v SessionsView) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch v.state {
	case sessStateList:
		return v.handleListKey(msg)
	case sessStateConfirmStop:
		return v.handleConfirmStopKey(msg)
	case sessStateConfirmRemove:
		return v.handleConfirmRemoveKey(msg)
	case sessStateConfirmStopAll:
		return v.handleConfirmStopAllKey(msg)
	}
	return v, nil
}

func (v SessionsView) handleListKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
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
		if v.cursor < len(v.sessions)-1 {
			v.cursor++
		}
		return v, nil
	case msg.String() == "s":
		if len(v.sessions) > 0 {
			v.state = sessStateConfirmStop
			v.statusMsg = ""
			v.err = nil
		}
		return v, nil
	case msg.String() == "r":
		if len(v.sessions) > 0 {
			s := v.sessions[v.cursor]
			if !s.IsWorktree {
				v.statusMsg = ""
				v.err = fmt.Errorf("cannot remove base session — use 's' to stop it")
				return v, nil
			}
			v.state = sessStateConfirmRemove
			v.statusMsg = ""
			v.err = nil
		}
		return v, nil
	case msg.String() == "S":
		if len(v.sessions) > 0 {
			v.state = sessStateConfirmStopAll
			v.statusMsg = ""
			v.err = nil
		}
		return v, nil
	}
	return v, nil
}

func (v SessionsView) handleConfirmStopKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if len(v.sessions) == 0 || v.cursor >= len(v.sessions) {
		v.state = sessStateList
		return v, loadSessions
	}
	switch msg.String() {
	case "y", "Y":
		s := v.sessions[v.cursor]
		v.state = sessStateStopping
		return v, tea.Batch(v.spinner.Tick, stopSession(s))
	default:
		v.state = sessStateList
		return v, nil
	}
}

func (v SessionsView) handleConfirmRemoveKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if len(v.sessions) == 0 || v.cursor >= len(v.sessions) {
		v.state = sessStateList
		return v, loadSessions
	}
	switch msg.String() {
	case "y", "Y":
		s := v.sessions[v.cursor]
		v.state = sessStateStopping
		return v, tea.Batch(v.spinner.Tick, removeSession(s))
	default:
		v.state = sessStateList
		return v, nil
	}
}

func (v SessionsView) handleConfirmStopAllKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "y", "Y":
		sessions := v.sessions
		v.state = sessStateStopping
		return v, tea.Batch(v.spinner.Tick, stopAllSessions(sessions))
	default:
		v.state = sessStateList
		return v, nil
	}
}

func (v SessionsView) View() string {
	var b strings.Builder

	switch v.state {
	case sessStateList:
		v.renderList(&b)
	case sessStateConfirmStop:
		v.renderConfirmStop(&b)
	case sessStateConfirmRemove:
		v.renderConfirmRemove(&b)
	case sessStateConfirmStopAll:
		v.renderConfirmStopAll(&b)
	case sessStateStopping:
		b.WriteString("  ")
		b.WriteString(v.spinner.View())
		b.WriteString(" Working...\n")
	}

	return b.String()
}

func (v SessionsView) renderList(b *strings.Builder) {
	if len(v.sessions) == 0 {
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render("No active sessions."))
		b.WriteString("\n\n")
		b.WriteString("  ")
		b.WriteString(app.HelpStyle.Render("esc back"))
		b.WriteString("\n")
		return
	}

	for i, s := range v.sessions {
		cursor := "  "
		if i == v.cursor {
			cursor = app.Selected.Render("> ")
		}

		display := s.DisplayName
		if i == v.cursor {
			display = app.Selected.Render(display)
		}

		b.WriteString(cursor)
		b.WriteString(display)

		// Project count
		label := fmt.Sprintf("%d projects", s.ProjectCount)
		if s.ProjectCount == 1 {
			label = "1 project"
		}
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render(label))

		// Badges
		var badges []string
		if s.DevRunning {
			badges = append(badges, app.Highlight.Render("[dev]"))
		}
		if len(badges) > 0 {
			b.WriteString("  ")
			b.WriteString(strings.Join(badges, " "))
		}

		// Age
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render(s.Age))

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
	b.WriteString(app.HelpStyle.Render("s stop  r remove  S stop all  esc back"))
	b.WriteString("\n")
}

func (v SessionsView) renderConfirmStop(b *strings.Builder) {
	if v.cursor >= len(v.sessions) {
		return
	}
	name := v.sessions[v.cursor].DisplayName
	b.WriteString(fmt.Sprintf("  Stop session '%s'? (y/n)\n", name))
}

func (v SessionsView) renderConfirmRemove(b *strings.Builder) {
	if v.cursor >= len(v.sessions) {
		return
	}
	name := v.sessions[v.cursor].DisplayName
	b.WriteString(fmt.Sprintf("  Remove session + worktree '%s'? (y/n)\n", name))
}

func (v SessionsView) renderConfirmStopAll(b *strings.Builder) {
	b.WriteString(fmt.Sprintf("  Stop all %d sessions? (y/n)\n", len(v.sessions)))
}

// ── Commands ──

func loadSessions() tea.Msg {
	return sessionsLoadedMsg{ListSessionInfos()}
}

func stopSession(s SessionInfo) tea.Cmd {
	return func() tea.Msg {
		StopSession(s.BaseName, s.WorktreeName)

		// Clean up .code-workspace file
		loadName := s.BaseName
		if s.WorktreeName != "" {
			loadName = WorktreeWorkspaceName(s.BaseName, s.WorktreeName)
		}
		wsFile := CodeWorkspaceFilePath(loadName)
		if _, err := os.Stat(wsFile); err == nil {
			editor := exec.DetectEditor()
			exec.CloseEditorWindow(exec.EditorProcessName(editor), loadName)
			os.Remove(wsFile)
		}

		return sessionStoppedMsg{s.DisplayName}
	}
}

func removeSession(s SessionInfo) tea.Cmd {
	return func() tea.Msg {
		StopSession(s.BaseName, s.WorktreeName)

		wtWsName := WorktreeWorkspaceName(s.BaseName, s.WorktreeName)

		// Clean up .code-workspace file
		wsFile := CodeWorkspaceFilePath(wtWsName)
		if _, err := os.Stat(wsFile); err == nil {
			editor := exec.DetectEditor()
			exec.CloseEditorWindow(exec.EditorProcessName(editor), wtWsName)
			os.Remove(wsFile)
		}

		// Remove git worktrees using base project paths
		ws, err := Load(s.BaseName)
		if err == nil {
			for _, p := range ws.Projects {
				wtDir := p.Path + "/.claude/worktrees/" + s.WorktreeName
				exec.RemoveGitWorktree(p.Path, wtDir)
			}
		}

		// Delete workspace JSON
		Remove(wtWsName)

		return sessionRemovedMsg{s.DisplayName}
	}
}

func stopAllSessions(sessions []SessionInfo) tea.Cmd {
	return func() tea.Msg {
		editor := exec.DetectEditor()
		editorProc := exec.EditorProcessName(editor)

		for _, s := range sessions {
			StopSession(s.BaseName, s.WorktreeName)

			loadName := s.BaseName
			if s.WorktreeName != "" {
				loadName = WorktreeWorkspaceName(s.BaseName, s.WorktreeName)
			}
			wsFile := CodeWorkspaceFilePath(loadName)
			if _, err := os.Stat(wsFile); err == nil {
				exec.CloseEditorWindow(editorProc, loadName)
				os.Remove(wsFile)
			}
		}
		return allSessionsStoppedMsg{}
	}
}
