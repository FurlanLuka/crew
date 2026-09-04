package transfer

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// DefaultExportFile is where crew export writes when not told otherwise.
const DefaultExportFile = "crew-export.json"

type exportLoadedMsg struct {
	projects   []project.Project
	workspaces []*workspace.Workspace
}
type exportWrittenMsg struct {
	file                 string
	projects, workspaces int
}
type errMsg struct{ err error }

type exportState int

const (
	exportStateList exportState = iota
	exportStateFile
	exportStateDone
)

// ExportView is the picker: every project, then every workspace those ticks
// fully cover. One cursor over both sections.
type ExportView struct {
	state     exportState
	file      string
	fileInput textinput.Model

	projects   []project.Project
	workspaces []*workspace.Workspace
	picked     map[string]bool // projects
	wsPicked   map[string]bool // workspaces; only counts while covered
	cursor     int

	written   exportWrittenMsg
	statusMsg string
	err       error
}

func NewExportView(file string) ExportView {
	if file == "" {
		file = DefaultExportFile
	}
	in := textinput.New()
	in.CharLimit = 512
	return ExportView{file: file, fileInput: in, picked: map[string]bool{}, wsPicked: map[string]bool{}}
}

func (v ExportView) Title() string { return "Export" }

func (v ExportView) Init() tea.Cmd {
	return func() tea.Msg {
		projects, err := project.List()
		if err != nil {
			return errMsg{err}
		}
		names, err := workspace.List()
		if err != nil {
			return errMsg{err}
		}
		var workspaces []*workspace.Workspace
		for _, name := range names {
			if ws, err := workspace.Load(name); err == nil {
				workspaces = append(workspaces, ws)
			}
		}
		return exportLoadedMsg{projects: projects, workspaces: workspaces}
	}
}

func (v ExportView) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return v, nil
	case exportLoadedMsg:
		v.projects, v.workspaces = msg.projects, msg.workspaces
		// Everything starts ticked: the common export is "all of it".
		for _, p := range v.projects {
			v.picked[p.Name] = true
		}
		for _, ws := range v.workspaces {
			v.wsPicked[ws.Name] = true
		}
		return v, nil
	case exportWrittenMsg:
		v.state = exportStateDone
		v.written = msg
		v.err = nil
		return v, nil
	case errMsg:
		v.err = msg.err
		return v, nil
	case tea.KeyMsg:
		switch v.state {
		case exportStateList:
			return v.handleListKey(msg)
		case exportStateFile:
			return v.handleFileKey(msg)
		case exportStateDone:
			if key.Matches(msg, app.Keys.Back) || key.Matches(msg, app.Keys.Quit) || msg.String() == "enter" {
				return v, func() tea.Msg { return app.PopPageMsg{} }
			}
			return v, nil
		}
	}
	if v.state == exportStateFile {
		var cmd tea.Cmd
		v.fileInput, cmd = v.fileInput.Update(msg)
		return v, cmd
	}
	return v, nil
}

// rows is the cursor's world: projects first, then workspaces.
func (v ExportView) rows() int { return len(v.projects) + len(v.workspaces) }

func (v ExportView) onProject() bool { return v.cursor < len(v.projects) }

func (v ExportView) handleListKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		return v, func() tea.Msg { return app.PopPageMsg{} }
	case key.Matches(msg, app.Keys.Up):
		v.cursor = app.MoveCursor(v.cursor, -1, v.rows())
	case key.Matches(msg, app.Keys.Down):
		v.cursor = app.MoveCursor(v.cursor, 1, v.rows())
	case msg.String() == " ":
		v.toggleCursor()
	case msg.String() == "a":
		v.toggleSection()
	case msg.String() == "f":
		v.state = exportStateFile
		v.fileInput.SetValue(v.file)
		v.fileInput.CursorEnd()
		v.fileInput.Focus()
		return v, v.fileInput.Cursor.BlinkCmd()
	case msg.String() == "enter":
		projNames, wsNames := v.selection()
		if len(projNames) == 0 && len(wsNames) == 0 {
			v.statusMsg = "Nothing selected"
			return v, nil
		}
		return v, writeBundle(v.file, projNames, wsNames)
	}
	return v, nil
}

func (v *ExportView) toggleCursor() {
	v.statusMsg = ""
	if v.onProject() {
		name := v.projects[v.cursor].Name
		v.picked[name] = !v.picked[name]
		return
	}
	ws := v.workspaces[v.cursor-len(v.projects)]
	if len(Uncovered(ws, v.picked)) > 0 {
		return
	}
	v.wsPicked[ws.Name] = !v.wsPicked[ws.Name]
}

// toggleSection: all on unless already all on, then all off — for the
// section under the cursor only, since ticking a workspace means something
// different from ticking a project.
func (v *ExportView) toggleSection() {
	v.statusMsg = ""
	if v.onProject() {
		all := true
		for _, p := range v.projects {
			all = all && v.picked[p.Name]
		}
		for _, p := range v.projects {
			v.picked[p.Name] = !all
		}
		return
	}
	all := true
	for _, ws := range v.workspaces {
		if len(Uncovered(ws, v.picked)) == 0 {
			all = all && v.wsPicked[ws.Name]
		}
	}
	for _, ws := range v.workspaces {
		v.wsPicked[ws.Name] = !all
	}
}

// selection is what enter exports: ticked projects, and ticked workspaces
// that are still covered by them.
func (v ExportView) selection() (projNames, wsNames []string) {
	for _, p := range v.projects {
		if v.picked[p.Name] {
			projNames = append(projNames, p.Name)
		}
	}
	for _, ws := range v.workspaces {
		if v.wsPicked[ws.Name] && len(Uncovered(ws, v.picked)) == 0 {
			wsNames = append(wsNames, ws.Name)
		}
	}
	return projNames, wsNames
}

func (v ExportView) handleFileKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		v.state = exportStateList
		v.fileInput.Blur()
		return v, nil
	case "enter":
		if f := strings.TrimSpace(v.fileInput.Value()); f != "" {
			v.file = f
		}
		v.state = exportStateList
		v.fileInput.Blur()
		return v, nil
	}
	var cmd tea.Cmd
	v.fileInput, cmd = v.fileInput.Update(msg)
	return v, cmd
}

func writeBundle(file string, projNames, wsNames []string) tea.Cmd {
	return func() tea.Msg {
		b, err := Collect(projNames, wsNames)
		if err != nil {
			return errMsg{err}
		}
		if err := Write(expandHome(file), b); err != nil {
			return errMsg{err}
		}
		return exportWrittenMsg{file: file, projects: len(b.Projects), workspaces: len(b.Workspaces)}
	}
}

func expandHome(path string) string {
	if strings.HasPrefix(path, "~/") {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, path[2:])
	}
	return path
}

// ── Render ──

func (v ExportView) View() string {
	var b strings.Builder
	switch v.state {
	case exportStateDone:
		fmt.Fprintf(&b, "  Wrote %s — %s\n\n  ", v.written.file, CountPhrase(v.written.projects, v.written.workspaces))
		b.WriteString(app.HelpStyle.Render("esc back"))
		b.WriteString("\n")
		return b.String()
	case exportStateFile:
		b.WriteString("  Export to ")
		b.WriteString(v.fileInput.View())
		b.WriteString("\n\n")
	default:
		fmt.Fprintf(&b, "  Export to %s\n\n", v.file)
	}
	v.renderList(&b)
	return b.String()
}

func (v ExportView) renderList(b *strings.Builder) {
	width := 0
	for _, p := range v.projects {
		width = max(width, len(p.Name))
	}
	for _, ws := range v.workspaces {
		width = max(width, len(ws.Name))
	}

	b.WriteString("  " + app.Subtle.Render("Projects") + "\n")
	for i, p := range v.projects {
		mark := "○"
		if v.picked[p.Name] {
			mark = "✓"
		}
		b.WriteString(app.RowPrefix(i == v.cursor))
		b.WriteString(app.RowName(fmt.Sprintf("%s %-*s", mark, width, p.Name), i == v.cursor))
		b.WriteString("  " + app.Subtle.Render(describeProject(p)) + "\n")
	}

	b.WriteString("\n  " + app.Subtle.Render("Workspaces") + strings.Repeat(" ", max(0, width-6)) + app.Subtle.Render("only those whose projects are all ticked") + "\n")
	for i, ws := range v.workspaces {
		cur := i + len(v.projects)
		missing := Uncovered(ws, v.picked)
		mark, detail := "○", memberNames(ws)
		switch {
		case len(missing) > 0:
			mark, detail = "·", "needs "+strings.Join(missing, ", ")
		case v.wsPicked[ws.Name]:
			mark = "✓"
		}
		b.WriteString(app.RowPrefix(cur == v.cursor))
		name := fmt.Sprintf("%s %-*s", mark, width, ws.Name)
		if len(missing) > 0 {
			b.WriteString(app.Subtle.Render(name) + "  " + app.Highlight.Render(detail))
		} else {
			b.WriteString(app.RowName(name, cur == v.cursor) + "  " + app.Subtle.Render(detail))
		}
		b.WriteString("\n")
	}

	b.WriteString("\n")
	if v.statusMsg != "" {
		b.WriteString("  " + app.Highlight.Render(v.statusMsg) + "\n\n")
	}
	if v.err != nil {
		b.WriteString("  " + app.Error.Render(v.err.Error()) + "\n\n")
	}
	projNames, wsNames := v.selection()
	b.WriteString("  " + app.HelpStyle.Render(fmt.Sprintf("space toggle  a all/none  f file  enter export %s  esc cancel", CountPhrase(len(projNames), len(wsNames)))))
	b.WriteString("\n")
}

func describeProject(p project.Project) string {
	var parts []string
	if n := len(p.DevServers); n == 1 {
		parts = append(parts, "1 server")
	} else if n > 1 {
		parts = append(parts, fmt.Sprintf("%d servers", n))
	}
	if n := len(p.Bindings); n == 1 {
		parts = append(parts, "1 binding")
	} else if n > 1 {
		parts = append(parts, fmt.Sprintf("%d bindings", n))
	}
	if p.Setup != "" {
		parts = append(parts, "setup: "+p.Setup)
	}
	return strings.Join(parts, "  ")
}

func memberNames(ws *workspace.Workspace) string {
	names := make([]string, 0, len(ws.Projects))
	for _, wp := range ws.Projects {
		names = append(names, wp.Name)
	}
	return strings.Join(names, ", ")
}

// CountPhrase is "N projects, M workspaces", pluralised — the CLI and the
// picker say it the same way.
func CountPhrase(projects, workspaces int) string {
	return fmt.Sprintf("%s, %s", plural(projects, "project"), plural(workspaces, "workspace"))
}

func plural(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return fmt.Sprintf("%d %ss", n, noun)
}
