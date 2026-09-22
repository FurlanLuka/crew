package workspaceui

import (
	"fmt"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// pageChrome is what app.View draws above a page: a blank, the title, a
// blank. The window the page fits itself into is the terminal minus that.
const pageChrome = 3

// formBlock is an open form rendered to a string, and the section it
// goes under.
type formBlock struct {
	underProjects bool
	body          string
}

// renderWorkspacePage draws the page body and says which line the cursor
// is on, so the view can window around it. Pure over its inputs: paths,
// sizes and the spinner frame all come in as facts. While a form is open
// the form has the cursor: the row keeps its line for the window but is
// not drawn as selected.
func renderWorkspacePage(f pageFacts, rows []pageRow, cursor int, open formBlock) (string, int) {
	var b strings.Builder
	cursorLine := 0
	line := func() int { return strings.Count(b.String(), "\n") }
	formOpen := open.body != ""
	sel := func(kind rowKind, idx int) bool {
		if cursor < 0 || cursor >= len(rows) || rows[cursor].Kind != kind {
			return false
		}
		switch kind {
		case rowProject, rowWorktree:
			return rows[cursor].Index == idx
		}
		return true
	}
	// mark keeps the cursor's line and says whether to draw it selected.
	mark := func(s bool) bool {
		if s {
			cursorLine = line()
		}
		return s && !formOpen
	}

	members := f.members()
	b.WriteString("  " + app.Subtle.Render(fmt.Sprintf("%s · %s", plural(len(members), "project"), worktreeSummary(f.summaries))) + "\n\n")

	b.WriteString("  " + app.Title.Render("Projects") + "\n")
	width := 0
	for _, wp := range members {
		width = max(width, len(wp.Name))
	}
	for i, wp := range members {
		s := mark(sel(rowProject, i))
		path := "not in the pool"
		if p, ok := f.pool[wp.Name]; ok {
			path = config.Tildify(p.Path)
		}
		b.WriteString("  " + app.RowPrefix(s) + app.RowName(fmt.Sprintf("%-*s", width, wp.Name), s) + "   " + renderMode(wp.Mode) + "   " + app.Subtle.Render(path) + "\n")
	}
	if len(members) == 0 {
		s := mark(sel(rowNoProjects, 0))
		b.WriteString("  " + app.RowPrefix(s) + app.Subtle.Render("no projects yet — a adds one") + "\n")
	}
	if open.underProjects && open.body != "" {
		b.WriteString("\n" + open.body)
	}

	b.WriteString("\n  " + app.Title.Render("Worktrees") + "\n")
	width = 0
	for _, sm := range f.summaries {
		width = max(width, len(sm.Worktree))
	}
	for i, sm := range f.summaries {
		s := mark(sel(rowWorktree, i))
		b.WriteString("  " + app.RowPrefix(s) + renderSummaryName(sm, s))
		if sm.Worktree != "" {
			b.WriteString(strings.Repeat(" ", width-len(sm.Worktree)))
			b.WriteString("  " + renderSize(f.sizes, sm, f.spinner))
		}
		if sm.DevRunning {
			b.WriteString("  " + app.Highlight.Render("[dev]"))
		}
		if sm.Installing {
			b.WriteString("  " + app.Highlight.Render("installing…"))
		}
		if sm.Health != "" {
			b.WriteString("  " + app.Error.Render("! "+sm.Health))
		}
		b.WriteString("\n")
	}
	s := mark(sel(rowNewWorktree, 0))
	b.WriteString("  " + app.RowPrefix(s) + app.RowName("+ new worktree", s) + "\n")
	if !open.underProjects && open.body != "" {
		b.WriteString("\n" + open.body)
	}
	return b.String(), cursorLine
}

// renderSummaryName shows the worktree name, or the flat pre-2.0 row with
// its migrate hint.
func renderSummaryName(s workspace.Summary, selected bool) string {
	if s.Worktree == "" {
		return app.RowName("(flat)", selected) + "  " + app.Subtle.Render("run crew migrate to name it")
	}
	return app.RowName(s.Worktree, selected)
}

// renderSize is right-aligned so the column reads as numbers; a worktree
// still being walked shows the spinner in its place.
func renderSize(sizes map[string]int64, s workspace.Summary, spinner string) string {
	n, ok := sizes[s.Ref.String()]
	if !ok {
		// %7s would count the glyph's bytes, not its width.
		return strings.Repeat(" ", 6) + spinner
	}
	return app.Subtle.Render(fmt.Sprintf("%7s", app.FormatBytes(n)))
}

func plural(n int, unit string) string {
	if n == 1 {
		return fmt.Sprintf("1 %s", unit)
	}
	return fmt.Sprintf("%d %ss", n, unit)
}

// window keeps height lines of the body, the cursor's line among them.
func window(lines []string, cursorLine, height int) []string {
	if height <= 0 || len(lines) <= height {
		return lines
	}
	start := 0
	if cursorLine >= height {
		start = cursorLine - height + 1
	}
	if start+height > len(lines) {
		start = len(lines) - height
	}
	return lines[start : start+height]
}

func (p Page) View() string {
	f := p.facts
	f.spinner = p.spinner.View()
	var open formBlock
	switch p.open {
	case openPicker:
		var pb strings.Builder
		p.picker.render(&pb)
		open = formBlock{underProjects: true, body: pb.String()}
	case openNewWorktree:
		var nb strings.Builder
		nb.WriteString(p.bases.render(p.spinner.View()))
		nb.WriteString(fmt.Sprintf("\n  New worktree: %s/", p.name) + p.input.View() + "\n")
		open = formBlock{body: nb.String()}
	case openDuplicate:
		open = formBlock{body: fmt.Sprintf("  Duplicate worktree '%s' as %s/", p.formRef, p.formRef.Workspace) + p.input.View() + "\n"}
	case openRename:
		open = formBlock{body: fmt.Sprintf("  Rename worktree '%s' to %s/", p.formRef, p.formRef.Workspace) + p.input.View() + "\n" +
			"  " + app.Subtle.Render("checkouts, branches and logs move — shells and editors opened on the old paths keep them") + "\n"}
	}
	body, cursorLine := renderWorkspacePage(f, p.rows, p.cursor, open)

	var tail strings.Builder
	if f.trash != "" {
		tail.WriteString("\n  " + app.Subtle.Render(f.trash) + "\n")
	}
	switch {
	case p.busy != "":
		tail.WriteString("  " + p.spinner.View() + " " + p.busy + "\n")
	case p.confirm != nil:
		tail.WriteString("  " + app.Highlight.Render(p.confirm.prompt) + "\n")
	case p.status != "":
		tail.WriteString("  " + app.Success.Render(p.status) + "\n")
	case p.err != nil:
		tail.WriteString("  " + app.Error.Render(p.err.Error()) + "\n")
	}
	if p.busy == "" && p.confirm == nil {
		keys := pageKeys(p.rows, p.cursor, p.open, f.flat(), p.bases.stale())
		tail.WriteString("  " + app.HelpStyle.Render(strings.Join(keys, "  ")) + "\n")
		if p.open == openNone {
			if cli := pageCLI(p.rows, p.cursor, p.name); cli != "" {
				tail.WriteString("  " + app.Subtle.Render(cli) + "\n")
			}
		}
	}

	// The tail is pinned; the body gets what height is left.
	tailLines := strings.Count(tail.String(), "\n")
	lines := strings.Split(strings.TrimRight(body, "\n"), "\n")
	if p.height > 0 {
		lines = window(lines, cursorLine, p.height-pageChrome-tailLines-1)
	}
	return strings.Join(lines, "\n") + "\n\n" + tail.String()
}
