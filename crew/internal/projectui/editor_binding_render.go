package projectui

import (
	"fmt"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// grammarLine is the one-line reminder that always shows; the legend
// behind ctrl+t is the whole table.
const grammarLine = "{{proj}} · {{proj/server}} · .host · .port · {{worktree}} · {{workspace}}  —  ctrl+t legend"

func (e bindingEditor) View() string {
	var b strings.Builder
	action := "Adding binding"
	if e.orig != nil {
		action = "Editing binding"
	}
	b.WriteString(fmt.Sprintf("  %s\n", action))

	b.WriteString("  var    ")
	b.WriteString(e.varInput.View())
	b.WriteString("\n")
	if e.focus == fieldVar {
		if match := completeVar(e.varInput.Value(), e.envKeys, e.declared); match != "" && match != e.varInput.Value() {
			b.WriteString("         ")
			b.WriteString(app.Subtle.Render("tab → " + match))
			b.WriteString("\n")
		}
	}

	// The scope: which of this project's servers gets the var. Only a
	// project with two or more has a choice to make; a monorepo's web app
	// and its worker rarely want the same siblings.
	if e.hasScopeField() {
		b.WriteString("  server ")
		if e.focus == fieldServer {
			b.WriteString(app.Highlight.Render("‹ " + scopeLabel(e.draft.Server) + " ›"))
			b.WriteString("  " + app.Subtle.Render("←/→ choose · all servers, or one of them"))
		} else {
			b.WriteString(scopeLabel(e.draft.Server))
		}
		b.WriteString("\n")
	}

	b.WriteString("  value  ")
	b.WriteString(e.valueInput.View())
	b.WriteString("\n")

	// Live preview against every worktree this project is in — the actual
	// value before saving, and where it will not resolve, which is normal
	// and better seen now than at start time.
	if len(e.draftPreview) > 0 {
		for _, p := range e.draftPreview {
			b.WriteString("         ")
			if p.Resolved {
				b.WriteString("→ " + p.Value)
				b.WriteString("  " + app.Subtle.Render("in "+p.Ref+stoppedTag(p)))
			} else {
				b.WriteString(app.Highlight.Render("→ left alone"))
				b.WriteString("  " + app.Subtle.Render("in "+p.Ref+" · "+p.Detail))
			}
			b.WriteString("\n")
		}
	} else if e.err == nil && e.draft.Value != "" && project.ValidVarName(e.draft.Var) {
		b.WriteString("         ")
		b.WriteString(app.Subtle.Render("→ not in any worktree yet"))
		b.WriteString("\n")
	}

	if e.err != nil {
		b.WriteString("  ")
		b.WriteString(app.Error.Render(e.err.Error()))
		b.WriteString("\n")
	}

	b.WriteString("  " + app.Subtle.Render(grammarLine) + "\n")
	if e.showLegend {
		renderTokenLegend(&b, e.targets)
	}
	b.WriteString("  ")
	b.WriteString(app.HelpStyle.Render("tab next field  enter save  esc cancel"))
	b.WriteString("\n")
	return b.String()
}

// renderPreviewInline shows the first resolved value, or the first reason it
// was left alone — enough to see at a glance, with the full picture in edit.
func renderPreviewInline(previews []workspace.BindingPreview) string {
	if len(previews) == 0 {
		return app.Subtle.Render("→ no worktree to check against")
	}
	for _, p := range previews {
		if p.Resolved {
			return "→ " + p.Value + "  " + app.Subtle.Render("in "+p.Ref+stoppedTag(p))
		}
	}
	return app.Highlight.Render("→ left alone") + "  " + app.Subtle.Render(previews[0].Detail)
}

func stoppedTag(p workspace.BindingPreview) string {
	if p.Running {
		return ""
	}
	return " · stopped"
}

type legendRow struct{ token, expands, note string }

// The legend is the whole grammar. If dev.parseToken learns a form it belongs
// here too, or nobody will find it from the TUI.
var tokenLegend = []legendRow{
	{"{{store-api}}", "http://localhost:54494", "URL of its one server"},
	{"{{store-api.host}}", "localhost:54494", "ws://{{store-api.host}}/rtc"},
	{"{{store-api.port}}", "54494", ""},
	{"{{checkout-api/worker}}", "http://localhost:54497", "a named server"},
	{"{{checkout-api/worker.port}}", "54497", ".host / .port go after the server"},
	{"{{worktree}}", "wrk1", "this worktree's name"},
	{"{{workspace}}", "store-front", "this workspace's name"},
}

// renderTokenLegend lists the tokens and the projects they can point at, so
// a value can be typed without leaving the screen or knowing the grammar.
func renderTokenLegend(b *strings.Builder, targets []project.Project) {
	b.WriteString("  Tokens\n")
	for _, r := range tokenLegend {
		// Pad before styling: width counts the escape bytes otherwise.
		b.WriteString(fmt.Sprintf("    %-30s ", r.token))
		b.WriteString(app.Subtle.Render(strings.TrimRight(fmt.Sprintf("%-24s %s", r.expands, r.note), " ")))
		b.WriteString("\n")
	}
	b.WriteString("    ")
	b.WriteString(app.Subtle.Render("Name the server only when the project has more than one. No tokens = used as-is."))
	b.WriteString("\n\n")

	b.WriteString("  Projects\n")
	if len(targets) == 0 {
		b.WriteString("    ")
		b.WriteString(app.Subtle.Render("none with dev servers yet — crew dev add <project> …"))
		b.WriteString("\n")
		return
	}
	width := 0
	for _, p := range targets {
		width = max(width, len(p.Name))
	}
	for _, p := range targets {
		servers := make([]string, 0, len(p.DevServers))
		for _, ds := range p.DevServers {
			servers = append(servers, fmt.Sprintf("%s :%d", ds.Name, ds.Port))
		}
		b.WriteString(fmt.Sprintf("    %-*s  %s\n", width, p.Name, app.Subtle.Render(strings.Join(servers, "  "))))
	}
}
