package workspaceui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// The workspace list: one row per workspace, enter opens its page, n runs
// the wizard in place, d removes. Sits above workspace and projectui —
// the page pushes the project page, the wizard's picker pushes the
// add-project wizard.

// ── Messages ──

type workspacesLoadedMsg struct{ summaries []workspace.Summary }
type workspaceRemovedMsg struct{ name string }
type errMsg struct{ err error }

// ── Model ──

type View struct {
	summaries []workspace.Summary // every worktree, across workspaces
	cursor    int                 // over workspaceRows()
	// wizard is the new-workspace walk, drawn in place while open.
	wizard *wizard
	// confirm is d's question, resolved when d was pressed.
	confirm   *confirmAsk
	err       error
	statusMsg string
}

func NewView() View { return View{} }

func (v View) Title() string {
	if v.wizard != nil {
		return "Add workspace"
	}
	return "Workspaces"
}

// Init runs on the first push and on every pop back: the list re-reads,
// and an open wizard re-reads its pool — the pop may be from the
// add-project wizard its picker pushed.
func (v View) Init() tea.Cmd {
	if v.wizard != nil {
		return tea.Batch(loadWorkspaces, v.wizard.reload())
	}
	return loadWorkspaces
}

func (v View) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return v, nil

	case workspacesLoadedMsg:
		v.summaries = msg.summaries
		v.err = nil
		if v.cursor >= len(v.workspaceRows()) {
			v.cursor = max(0, len(v.workspaceRows())-1)
		}
		return v, nil

	case workspaceRemovedMsg:
		v.statusMsg = fmt.Sprintf("Removed workspace '%s'", msg.name)
		v.err = nil
		return v, loadWorkspaces

	case app.StatusMsg:
		v.statusMsg, v.err = msg.Status, nil
		return v, nil

	case wizardCreatedMsg:
		// The list stays under the pushed page and is what esc comes
		// back to, so the wizard is dropped here even though the page
		// takes over now.
		v.wizard = nil
		v.statusMsg, v.err = "", nil
		page := workspace.NewWorktreeView(msg.ref)
		page.SetStatus(fmt.Sprintf("Created %s — installing", msg.ref))
		return v, tea.Batch(loadWorkspaces, func() tea.Msg { return app.PushPageMsg{Page: page} })

	case errMsg:
		if v.wizard != nil {
			w, cmd := v.wizard.Update(msg)
			v.wizard = &w
			return v, cmd
		}
		v.err = msg.err
		return v, nil

	case tea.KeyMsg:
		return v.handleKey(msg)
	}

	if v.wizard != nil {
		w, cmd := v.wizard.Update(msg)
		v.wizard = &w
		return v, cmd
	}
	return v, nil
}

func (v View) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if msg.String() == "ctrl+c" {
		return v, tea.Quit
	}
	if v.wizard != nil {
		w, cmd := v.wizard.Update(msg)
		if w.closed {
			v.wizard = nil
			return v, nil
		}
		v.wizard = &w
		return v, cmd
	}
	if v.confirm != nil {
		return v.handleConfirmKey(msg)
	}
	rows := v.workspaceRows()
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		return v, func() tea.Msg { return app.PopPageMsg{} }
	case key.Matches(msg, app.Keys.Up):
		v.cursor = app.MoveCursor(v.cursor, -1, len(rows))
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		v.cursor = app.MoveCursor(v.cursor, 1, len(rows))
		return v, nil
	case msg.String() == "n":
		w := newWizard()
		v.wizard = &w
		v.statusMsg, v.err = "", nil
		return v, w.init()
	case msg.String() == "d":
		if len(rows) > 0 {
			v.confirm = &confirmAsk{prompt: removeWorkspacePrompt(rows[v.cursor].Name, membersOf(rows[v.cursor].Name)), name: rows[v.cursor].Name}
			v.statusMsg, v.err = "", nil
		}
		return v, nil
	case msg.String() == "enter":
		if len(rows) > 0 {
			page := NewPage(rows[v.cursor].Name)
			return v, func() tea.Msg { return app.PushPageMsg{Page: page} }
		}
		return v, nil
	}
	return v, nil
}

func (v View) handleConfirmKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	ask := *v.confirm
	v.confirm = nil
	switch msg.String() {
	case "y", "Y":
		return v, removeWorkspace(ask.name)
	}
	return v, nil
}

// membersOf reads a workspace's members once, when d is pressed.
func membersOf(name string) []workspace.WorkspaceProject {
	ws, err := workspace.Load(name)
	if err != nil {
		return nil
	}
	return ws.Projects
}

// removeWorkspacePrompt is d's (y/n) question over a workspace, saying
// what goes with it: every worktree checkout; direct members are never
// touched. Pure.
func removeWorkspacePrompt(name string, members []workspace.WorkspaceProject) string {
	worktree, direct := 0, 0
	for _, wp := range members {
		if workspace.IsDirect(wp) {
			direct++
		} else {
			worktree++
		}
	}
	switch {
	case worktree == 0 && direct > 0:
		return fmt.Sprintf("Remove workspace '%s'? No worktrees to delete; %d direct project(s) will be untouched. (y/n)", name, direct)
	case worktree > 0 && direct > 0:
		return fmt.Sprintf("Remove workspace '%s'? Will delete %d worktree(s); %d direct project(s) untouched. (y/n)", name, worktree, direct)
	}
	return fmt.Sprintf("Remove workspace '%s'? This will delete all worktrees. (y/n)", name)
}

// workspaceRow is one workspace as the list shows it, with its worktrees
// underneath for the page.
type workspaceRow struct {
	Name         string
	ProjectCount int
	Worktrees    []workspace.Summary
	DevRunning   bool
}

// workspaceRows groups the flat worktree summaries by workspace, in order.
func (v View) workspaceRows() []workspaceRow {
	var rows []workspaceRow
	index := map[string]int{}
	for _, s := range v.summaries {
		i, ok := index[s.Workspace]
		if !ok {
			i = len(rows)
			index[s.Workspace] = i
			rows = append(rows, workspaceRow{Name: s.Workspace, ProjectCount: s.ProjectCount})
		}
		rows[i].Worktrees = append(rows[i].Worktrees, s)
		rows[i].DevRunning = rows[i].DevRunning || s.DevRunning
	}
	return rows
}

// ── View rendering ──

func (v View) View() string {
	var b strings.Builder
	if v.wizard != nil {
		return v.wizard.View()
	}
	v.renderList(&b)
	return b.String()
}

func (v View) renderList(b *strings.Builder) {
	rows := v.workspaceRows()
	if len(rows) == 0 {
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render("No workspaces yet."))
		b.WriteString("\n\n  ")
		b.WriteString(app.HelpStyle.Render("n new  esc back"))
		b.WriteString("\n")
		return
	}

	for i, r := range rows {
		b.WriteString(app.RowPrefix(i == v.cursor))
		b.WriteString(app.RowName(r.Name, i == v.cursor))
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render(fmt.Sprintf("%s · %s", plural(r.ProjectCount, "project"), worktreeSummary(r.Worktrees))))
		if r.DevRunning {
			b.WriteString("  " + app.Highlight.Render("[dev]"))
		}
		b.WriteString("\n")
	}

	renderTrashNotice(b)
	b.WriteString("\n")
	switch {
	case v.confirm != nil:
		b.WriteString("  " + app.Highlight.Render(v.confirm.prompt) + "\n\n")
	case v.statusMsg != "":
		b.WriteString("  " + app.Success.Render(v.statusMsg) + "\n\n")
	case v.err != nil:
		b.WriteString("  " + app.Error.Render(v.err.Error()) + "\n\n")
	}
	b.WriteString("  ")
	b.WriteString(app.HelpStyle.Render("enter open  n new  d delete  esc back"))
	b.WriteString("\n")
}

// worktreeSummary reads "2 worktrees" or, for a pre-migration workspace, the
// hint to migrate.
func worktreeSummary(worktrees []workspace.Summary) string {
	if len(worktrees) == 1 && worktrees[0].Worktree == "" {
		return "run crew migrate"
	}
	return plural(len(worktrees), "worktree")
}

// renderTrashNotice says when removed checkouts are still being cleared —
// the bytes are not back yet, which matters right before creating the next.
func renderTrashNotice(b *strings.Builder) {
	if notice := workspace.TrashNotice(); notice != "" {
		b.WriteString("\n  " + app.Subtle.Render(notice) + "\n")
	}
}

// ── Commands ──

func loadWorkspaces() tea.Msg {
	summaries, err := workspace.ListSummaries()
	if err != nil {
		return errMsg{err}
	}
	return workspacesLoadedMsg{summaries}
}

func removeWorkspace(name string) tea.Cmd {
	return func() tea.Msg {
		if err := workspace.Remove(name); err != nil {
			return errMsg{err}
		}
		return workspaceRemovedMsg{name}
	}
}
