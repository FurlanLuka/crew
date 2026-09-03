package project

import (
	"fmt"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/dev"
)

// ── View ──

func (v BindingsView) View() string {
	var b strings.Builder
	switch v.state {
	case bindingStateList:
		v.renderList(&b)
	case bindingStateScan:
		v.renderScan(&b)
	case bindingStateEdit:
		v.renderEdit(&b)
	case bindingStateConfirmRemove:
		b.WriteString(fmt.Sprintf("  Remove binding '%s'? (y/n)\n", v.bindings[v.cursor].Var))
	}
	return b.String()
}

func (v BindingsView) renderList(b *strings.Builder) {
	if len(v.bindings) == 0 {
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render("Nothing declared yet."))
		b.WriteString("\n\n  ")
		if len(v.proposals) > 0 {
			b.WriteString(app.HelpStyle.Render("s scan .env  a add  esc back"))
		} else {
			b.WriteString(app.HelpStyle.Render("a add  esc back"))
		}
		b.WriteString("\n")
		return
	}

	width := 0
	for _, bd := range v.bindings {
		width = max(width, len(bd.Var))
	}

	for i, bd := range v.bindings {
		pad := strings.Repeat(" ", width-len(bd.Var))

		b.WriteString(app.RowPrefix(i == v.cursor))
		b.WriteString(app.RowName(bd.Var, i == v.cursor) + pad)
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render(fmt.Sprintf("%-36s", bd.Value)))
		if dev.IsLegacyToken(bd.Value) {
			b.WriteString(app.Subtle.Render("· old form  "))
		}
		b.WriteString(renderPreviewInline(v.previews[bd.Var]))
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
	b.WriteString(app.HelpStyle.Render("a add  e edit  d delete  s scan .env  esc back"))
	b.WriteString("\n")
}

// renderPreviewInline shows the first resolved value, or the first reason it
// was left alone — enough to see at a glance, with the full picture in edit.
func renderPreviewInline(previews []BindingPreview) string {
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

func stoppedTag(p BindingPreview) string {
	if p.Running {
		return ""
	}
	return " · stopped"
}

func (v BindingsView) renderScan(b *strings.Builder) {
	b.WriteString("  Scanned .env — found ")
	b.WriteString(fmt.Sprintf("%d vars pointing at ports crew allocates:\n\n", len(v.proposals)))

	declared := v.declaredVars()
	for i, p := range v.proposals {
		mark := "○"
		switch {
		case declared[p.Var]:
			mark = "·"
		case p.Ambiguous:
			mark = "?"
		case v.accepted[i]:
			mark = "✓"
		}

		target := p.Template
		switch {
		case declared[p.Var]:
			target = app.Subtle.Render("already bound")
		case p.Ambiguous:
			target = app.Highlight.Render(fmt.Sprintf("two projects on :%d — pick by hand", p.Port))
		}

		b.WriteString(app.RowPrefix(i == v.scanCur))
		b.WriteString(fmt.Sprintf("%s %-22s %-26s %s\n", mark, p.Var, app.Subtle.Render(p.Value), target))
	}

	b.WriteString("\n  ")
	b.WriteString(app.HelpStyle.Render("space toggle  a accept all  enter accept checked  n skip"))
	b.WriteString("\n")
}

// ── Edit ──

func (v BindingsView) renderEdit(b *strings.Builder) {
	action := "Adding binding"
	if v.editIdx >= 0 {
		action = "Editing binding"
	}
	b.WriteString(fmt.Sprintf("  %s\n\n", action))

	b.WriteString("  var    ")
	b.WriteString(v.varInput.View())
	b.WriteString("\n")
	if v.focus == fieldVar {
		if match := v.completeVar(v.varInput.Value()); match != "" && match != v.varInput.Value() {
			b.WriteString("         ")
			b.WriteString(app.Subtle.Render("tab → " + match))
			b.WriteString("\n")
		}
	}

	b.WriteString("  value  ")
	b.WriteString(v.valueInput.View())
	b.WriteString("\n")

	// Live preview against every worktree this project is in — the actual
	// value before saving, and where it will not resolve, which is normal
	// and better seen now than at start time.
	if len(v.draftPreview) > 0 {
		b.WriteString("\n")
		for _, p := range v.draftPreview {
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
	} else if v.err == nil && Previewer != nil && v.draft.Value != "" && validVarName.MatchString(v.draft.Var) {
		b.WriteString("\n         ")
		b.WriteString(app.Subtle.Render("→ not in any worktree yet"))
		b.WriteString("\n")
	}

	if v.err != nil {
		b.WriteString("\n  ")
		b.WriteString(app.Error.Render(v.err.Error()))
		b.WriteString("\n")
	}

	b.WriteString("\n")
	renderTokenLegend(b, v.projectsWithServers())

	b.WriteString("\n  ")
	b.WriteString(app.HelpStyle.Render("tab next field  enter save  esc cancel"))
	b.WriteString("\n")
}

type legendRow struct{ token, expands, note string }

// The legend is the whole grammar. If dev.parseToken learns a form it belongs
// here too, or nobody will find it from the TUI.
var tokenLegend = []legendRow{
	{"{{speak-api}}", "http://localhost:54494", "URL of its one server"},
	{"{{speak-api.host}}", "localhost:54494", "ws://{{speak-api.host}}/rtc"},
	{"{{speak-api.port}}", "54494", ""},
	{"{{ai-tutor-api/worker}}", "http://localhost:54497", "a named server"},
	{"{{ai-tutor-api/worker.port}}", "54497", ".host / .port go after the server"},
	{"{{worktree}}", "wrk1", "this worktree's name"},
	{"{{workspace}}", "phone-speak", "this workspace's name"},
}

// renderTokenLegend lists the tokens and the projects they can point at, so
// a value can be typed without leaving the screen or knowing the grammar.
func renderTokenLegend(b *strings.Builder, targets []Project) {
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
