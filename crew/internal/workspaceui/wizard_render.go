package workspaceui

import (
	"fmt"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// The wizard's three cards. Each opens with what the step means, shows
// the facts, and closes with its keys and the CLI line they stand for.

func (w wizard) View() string {
	var b strings.Builder
	switch w.card {
	case cardName:
		w.renderName(&b)
	case cardProjects:
		w.renderProjects(&b)
	case cardCreate:
		w.renderCreate(&b)
	}
	return b.String()
}

func (w wizard) header() string {
	name := ""
	if w.wsName != "" {
		name = " " + w.wsName
	}
	return fmt.Sprintf("  Add workspace%s · %d of 3 · %s\n\n", name, int(w.card)+1, w.card.label())
}

func (w wizard) renderName(b *strings.Builder) {
	b.WriteString(w.header())
	b.WriteString("  " + app.Subtle.Render("A workspace is membership: which projects it holds. It owns nothing on disk. Its first") + "\n")
	b.WriteString("  " + app.Subtle.Render("worktree — main — is one fresh checkout of every member, on its own ports.") + "\n\n")
	b.WriteString("  name      " + w.name.View() + "\n\n")
	w.renderErr(b)
	b.WriteString("  " + app.HelpStyle.Render("enter next  esc stop") + "\n")
	b.WriteString("  " + app.Subtle.Render(cliLine(strings.TrimSpace(w.name.Value()), nil)) + "\n")
}

func (w wizard) renderProjects(b *strings.Builder) {
	b.WriteString(w.header())
	b.WriteString("  " + app.Subtle.Render(fmt.Sprintf("Tick the projects. worktree = a fresh checkout on crew/%s/main/<project>; direct = the", w.wsName)) + "\n")
	b.WriteString("  " + app.Subtle.Render("canonical checkout, not isolated — m switches a row.") + "\n\n")
	w.picker.render(b)
	if wires := renderBindingLines(bindingLines(w.pool, w.picker.ticked(), nil)); wires != "" {
		b.WriteString("\n" + wires)
	}
	b.WriteString("\n")
	w.renderErr(b)
	b.WriteString("  " + app.HelpStyle.Render(pickerKeys+"  enter next  esc back") + "\n")
	b.WriteString("  " + app.Subtle.Render(cliLine(w.wsName, w.picker.specs())) + "\n")
}

func (w wizard) renderCreate(b *strings.Builder) {
	b.WriteString(w.header())
	specs := w.picker.specs()
	parts := make([]string, 0, len(specs))
	for _, s := range specs {
		parts = append(parts, s.Name+"   "+app.Subtle.Render(workspace.ModeLabel(s.Mode)))
	}
	b.WriteString("  " + strings.Join(parts, "      ") + "\n\n")
	b.WriteString(w.bases.render(w.spinner.View()) + "\n")
	if w.creating {
		b.WriteString(fmt.Sprintf("  %s creating %s — reserving ports, starting one runner per project…\n\n", w.spinner.View(), w.wsName))
		return
	}
	b.WriteString("  " + app.Subtle.Render("y creates the main worktree the way crew add worktree does: checkouts, installs, a smoke start; what fails is recorded.") + "\n\n")
	w.renderErr(b)
	keys := "y create  esc back"
	if w.bases.stale() {
		keys = "y create  ctrl+p pull first  esc back"
	}
	b.WriteString("  " + app.HelpStyle.Render(keys) + "\n")
	b.WriteString("  " + app.Subtle.Render(cliLine(w.wsName, specs)+" --wait") + "\n")
}

func (w wizard) renderErr(b *strings.Builder) {
	if w.err != nil {
		b.WriteString("  " + app.Error.Render("! "+w.err.Error()) + "\n\n")
	}
}
