package project

import (
	"fmt"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/app"
)

// ── View ──

func (v BindingsView) View() string {
	var b strings.Builder
	switch v.state {
	case bindingStateList:
		v.renderList(&b)
	case bindingStateScan:
		v.renderScan(&b)
	case bindingStateVar:
		v.renderVar(&b)
	case bindingStateSource:
		v.renderSource(&b)
	case bindingStateProject:
		v.renderProject(&b)
	case bindingStateServer:
		v.renderServer(&b)
	case bindingStateCustom:
		v.renderCustom(&b)
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
			return "→ " + p.Value + "  " + app.Subtle.Render("in "+p.Ref)
		}
	}
	return app.Highlight.Render("→ left alone") + "  " + app.Subtle.Render(previews[0].Detail)
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

func (v BindingsView) renderVar(b *strings.Builder) {
	b.WriteString("  Adding binding\n\n")
	b.WriteString("  var    ")
	b.WriteString(v.varInput.View())
	b.WriteString("\n")

	if match := v.completeVar(v.varInput.Value()); match != "" && match != v.varInput.Value() {
		b.WriteString("         ")
		b.WriteString(app.Subtle.Render("tab → " + match))
		b.WriteString("\n")
	}

	if v.err != nil {
		b.WriteString("\n  ")
		b.WriteString(app.Error.Render(v.err.Error()))
		b.WriteString("\n")
	}

	b.WriteString("\n  ")
	b.WriteString(app.HelpStyle.Render("enter next  tab complete from .env  esc cancel"))
	b.WriteString("\n")
}

func (v BindingsView) renderSource(b *strings.Builder) {
	if v.insertToken {
		b.WriteString("  Insert token\n\n")
	} else {
		b.WriteString(fmt.Sprintf("  %s\n\n", v.draft.Var))
		b.WriteString("  value  ")
	}

	for i, label := range sourceLabels {
		if i > 0 || v.insertToken {
			b.WriteString("         ")
		}
		if i == v.sourceCur {
			b.WriteString(app.Selected.Render("▸ " + label))
		} else {
			b.WriteString("  " + label)
		}
		b.WriteString("\n")
	}

	b.WriteString("\n  ")
	b.WriteString(app.HelpStyle.Render("enter pick  esc back"))
	b.WriteString("\n")
}

func (v BindingsView) renderProject(b *strings.Builder) {
	b.WriteString(fmt.Sprintf("  %s — which project?\n\n", v.draft.Var))

	candidates := v.projectsWithServers()
	if len(candidates) == 0 {
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render("No project has dev servers configured yet."))
		b.WriteString("\n")
	}
	for i, p := range candidates {
		servers := make([]string, 0, len(p.DevServers))
		for _, ds := range p.DevServers {
			servers = append(servers, fmt.Sprintf("%s :%d", ds.Name, ds.Port))
		}
		b.WriteString(app.RowPrefix(i == v.projectCur))
		b.WriteString(fmt.Sprintf("%-16s %s\n", app.RowName(p.Name, i == v.projectCur), app.Subtle.Render(strings.Join(servers, "  "))))
	}

	b.WriteString("\n  ")
	b.WriteString(app.HelpStyle.Render("enter pick  esc back"))
	b.WriteString("\n")
}

func (v BindingsView) renderServer(b *strings.Builder) {
	b.WriteString(fmt.Sprintf("  %s — which server of %s?\n\n", v.draft.Var, v.pickedProj.Name))

	for i, ds := range v.pickedProj.DevServers {
		b.WriteString(app.RowPrefix(i == v.serverCur))
		b.WriteString(fmt.Sprintf("%-16s %s\n", app.RowName(ds.Name, i == v.serverCur), app.Subtle.Render(fmt.Sprintf(":%d  %s", ds.Port, ds.Command))))
	}

	b.WriteString("\n  ")
	b.WriteString(app.HelpStyle.Render("enter pick  esc back"))
	b.WriteString("\n")
}

func (v BindingsView) renderCustom(b *strings.Builder) {
	action := "Adding binding"
	if v.editIdx >= 0 {
		action = "Editing binding"
	}
	b.WriteString(fmt.Sprintf("  %s\n\n", action))
	b.WriteString(fmt.Sprintf("  var    %s\n", v.draft.Var))
	b.WriteString("  value  ")
	b.WriteString(v.customInput.View())
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
				b.WriteString("  " + app.Subtle.Render("in "+p.Ref))
			} else {
				b.WriteString(app.Highlight.Render("→ left alone"))
				b.WriteString("  " + app.Subtle.Render("in "+p.Ref+" · "+p.Detail))
			}
			b.WriteString("\n")
		}
	} else if Previewer != nil && v.draft.Value != "" {
		b.WriteString("\n         ")
		b.WriteString(app.Subtle.Render("→ not in any worktree yet"))
		b.WriteString("\n")
	}

	if v.err != nil {
		b.WriteString("\n  ")
		b.WriteString(app.Error.Render(v.err.Error()))
		b.WriteString("\n")
	}

	b.WriteString("\n  ")
	b.WriteString(app.HelpStyle.Render("enter save  ctrl+t insert token  esc cancel"))
	b.WriteString("\n")
}
