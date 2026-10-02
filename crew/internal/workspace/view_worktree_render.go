package workspace

import (
	"fmt"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/words"
)

// ── View ──

func (v WorktreeView) View() string {
	var b strings.Builder
	renderWorktreePage(&b, v.page, v.rows, v.cursor)

	if v.loading {
		b.WriteString("\n  ")
		b.WriteString(v.spinner.View())
		b.WriteString(" ")
		b.WriteString(v.actionMsg)
		b.WriteString("\n")
	}
	if v.statusMsg != "" {
		b.WriteString("\n  ")
		b.WriteString(app.Success.Render(v.statusMsg))
		b.WriteString("\n")
	}
	if v.err != nil {
		b.WriteString("\n  ")
		b.WriteString(app.Error.Render(v.err.Error()))
		b.WriteString("\n")
	}
	b.WriteString("\n  ")
	help := "enter launch  l logs  o shell"
	if v.page.installing() {
		help = "l runner logs  o shell"
	}
	b.WriteString(app.HelpStyle.Render(help + "  esc back"))
	b.WriteString("\n")
	return b.String()
}

// manageLine is where the page sends everything it no longer does: crew's
// page in the browser, or the command. Pure.
func manageLine(page worktreePage) string {
	where := page.ManageURL
	if where == "" {
		where = "run crew"
	}
	return fmt.Sprintf("manage it in crew: %s · crew dev start %s", where, page.Ref)
}

// renderWorktreePage draws the page body. Pure over its inputs so the layout
// can be asserted as a whole.
func renderWorktreePage(b *strings.Builder, page worktreePage, rows []rowKind, cursor int) {
	fmt.Fprintf(b, "  %s\n", app.Subtle.Render(page.Dir))

	// What is recorded comes first; while runners are alive, their table.
	if page.Health != nil {
		renderHealth(b, page.Health, page.Now)
	}
	if page.installing() {
		b.WriteString("\n  " + app.Highlight.Render("installing") + app.Subtle.Render(" · one runner per project") + "\n")
		b.WriteString(RenderSetupTable(*page.Setup, spinnerFrame, page.Now))
	}
	b.WriteString("\n")

	selected := func(kind rowKind) bool { return len(rows) > 0 && rows[cursor] == kind }
	name := func(label string, kind rowKind, sel bool) string {
		if page.installing() && kind != rowOpenShell {
			return app.Subtle.Render(label)
		}
		return app.RowName(label, sel)
	}

	b.WriteString("  Servers")
	if page.Session != "" {
		b.WriteString("  " + app.Subtle.Render(page.Session))
	}
	b.WriteString("\n")
	if len(page.Items) == 0 {
		b.WriteString("    " + app.Subtle.Render("none configured") + "\n")
	}
	width := 0
	for _, item := range page.Items {
		width = max(width, len(item.Server.Name))
	}
	for _, item := range page.Items {
		b.WriteString("    " + fmt.Sprintf("%-*s", width, item.Server.Name))
		port := item.portLabel()
		switch {
		case item.Running && !item.Server.Listens():
			fmt.Fprintf(b, "  %s %s", app.Success.Render("●"), port)
		case item.Running:
			fmt.Fprintf(b, "  %s %s   %s", app.Success.Render("●"), port, app.Subtle.Render(item.URL))
		default:
			fmt.Fprintf(b, "  %s %s", app.Subtle.Render("○"), app.Subtle.Render("stopped"))
		}
		b.WriteString("\n")
	}
	if page.Anomalies != "" {
		b.WriteString("\n")
		for _, line := range strings.Split(strings.TrimRight(page.Anomalies, "\n"), "\n") {
			b.WriteString("  " + app.Highlight.Render(line) + "\n")
		}
	}
	b.WriteString("  " + app.Subtle.Render(manageLine(page)) + "\n")

	launch := "Launch"
	if page.installing() {
		launch += "  " + app.Subtle.Render("after the install")
	}
	b.WriteString("\n  " + launch + "\n")
	if page.HasEditor {
		sel := selected(rowLaunchEditor)
		b.WriteString("  " + app.RowPrefix(sel))
		b.WriteString(name(fmt.Sprintf("%-28s", "Editor + Claude"), rowLaunchEditor, sel))
		b.WriteString(app.Subtle.Render(leadHint(page)))
		b.WriteString("\n")
	}
	sel := selected(rowLaunchClaude)
	b.WriteString("  " + app.RowPrefix(sel))
	b.WriteString(name(fmt.Sprintf("%-28s", "Claude in terminal"), rowLaunchClaude, sel))
	if !page.HasEditor {
		b.WriteString(app.Subtle.Render(leadHint(page)))
	}
	b.WriteString("\n")

	b.WriteString("\n  Open\n")
	if page.HasSSH {
		sel := selected(rowOpenRemote)
		b.WriteString("  " + app.RowPrefix(sel))
		b.WriteString(name("Cursor / VS Code (remote)", rowOpenRemote, sel))
		b.WriteString("\n")
	}
	sel = selected(rowOpenShell)
	b.WriteString("  " + app.RowPrefix(sel))
	b.WriteString(name("Shell here", rowOpenShell, sel))
	b.WriteString("\n")
}

// renderHealth is what is recorded on the worktree, per issue with its
// stage and a few lines of evidence; crew fix hands Claude all of it.
func renderHealth(b *strings.Builder, h *Health, now time.Time) {
	if h == nil {
		return
	}
	b.WriteString("\n  " + app.Error.Render("! "+h.Summary()) + app.Subtle.Render(" · "+AgoAt(h.At, now)) + "\n")
	width := 0
	for _, issue := range h.Issues {
		width = max(width, len(issue.Name()))
	}
	for _, issue := range h.Issues {
		lines := strings.Split(strings.TrimRight(issue.Detail, "\n"), "\n")
		hidden := 0
		if len(lines) > 3 {
			hidden = len(lines) - 3
			lines = lines[len(lines)-3:]
		}
		for j, line := range lines {
			label := strings.Repeat(" ", 10+width)
			if j == 0 {
				label = fmt.Sprintf("%-9s %-*s", issue.Stage, width, issue.Name())
			}
			b.WriteString("    " + app.Subtle.Render(label[:9]) + label[9:] + "   " + app.Subtle.Render(line) + "\n")
		}
		if hidden > 0 {
			b.WriteString("    " + strings.Repeat(" ", 10+width) + "   " + app.Subtle.Render(fmt.Sprintf("… %d more lines — crew fix hands Claude all of it", hidden)) + "\n")
		}
	}
}

// spinnerFrame is the page's mark on a running step. Static: the page
// re-renders every couple of seconds, not every tick.
const spinnerFrame = "▸"

// AgoAt is "2 minutes ago" for a timestamp against a given clock, so a
// render can be pure over it; nothing older than days needs finer.
func AgoAt(t, now time.Time) string {
	d := now.Sub(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return words.Count(int(d.Minutes()), "minute") + " ago"
	case d < 24*time.Hour:
		return words.Count(int(d.Hours()), "hour") + " ago"
	default:
		return words.Count(int(d.Hours()/24), "day") + " ago"
	}
}

func leadHint(page worktreePage) string {
	if page.LeadProject == "" {
		return ""
	}
	if page.LeadBranch == "" {
		return page.LeadProject
	}
	return page.LeadProject + " · " + page.LeadBranch
}
