package main

import (
	"fmt"
	"os"

	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// A binding is checked before it is saved: what it resolves to in every
// worktree of the project, or why it cannot be saved at all. Nothing here
// writes; the web's Environment editor asks on every keystroke.

// bindingDryRun is crew add binding --dry-run: the draft as given, the
// reason it would be refused (empty when it would save), and its value in
// each worktree. Previews is a list, never null.
type bindingDryRun struct {
	Var      string                     `json:"var"`
	Server   string                     `json:"server"`
	Value    string                     `json:"value"`
	Error    string                     `json:"error,omitempty"`
	Previews []workspace.BindingPreview `json:"previews"`
}

// dryRunDoc is the document for a draft. A refused draft previews nothing:
// there is no value to show for a template that does not parse. Pure.
func dryRunDoc(b project.Binding, refusal error, previews []workspace.BindingPreview) bindingDryRun {
	doc := bindingDryRun{Var: b.Var, Server: b.Server, Value: b.Value, Previews: []workspace.BindingPreview{}}
	if refusal != nil {
		doc.Error = refusal.Error()
		return doc
	}
	if previews != nil {
		doc.Previews = previews
	}
	return doc
}

// runBindingDryRun checks the draft the way the add would (the value's own
// shorthand error first) and previews it; exit 1 when it would be refused.
func runBindingDryRun(owner bindingOwner, b project.Binding, valueErr error) {
	refusal := valueErr
	if refusal == nil {
		refusal = project.ValidateBinding(owner.Target.Project, b)
	}
	var previews []workspace.BindingPreview
	if refusal == nil {
		previews = workspace.PreviewBinding(owner.Target.Project, b)
	}
	doc := dryRunDoc(b, refusal, previews)
	if jsonOutput {
		printJSON(doc)
	} else if doc.Error == "" {
		for _, p := range doc.Previews {
			fmt.Println(previewLine(p))
		}
		if len(doc.Previews) == 0 {
			fmt.Fprintf(human, "%s is in no worktree yet — nothing to resolve against\n", owner.Target.Project)
		}
	}
	if doc.Error != "" {
		fmt.Fprintf(os.Stderr, "Error: %s\n", doc.Error)
		os.Exit(1)
	}
}

// previewLine is one worktree's value: ref, value or "left alone — why",
// running or stopped (a stopped worktree resolves against the ports it gets
// back on its next start). Pure.
func previewLine(p workspace.BindingPreview) string {
	value := p.Value
	if !p.Resolved {
		value = "left alone — " + p.Detail
	}
	state := "running"
	if !p.Running {
		state = "stopped"
	}
	return p.Ref + "\t" + value + "\t" + state
}

// bindingPreviewRow is one crew ls bindings --preview row: the binding and
// its value in every worktree of the project.
type bindingPreviewRow struct {
	bindingRow
	Previews []workspace.BindingPreview `json:"previews"`
}

// previewRows joins each row to its previews by identity. Pure.
func previewRows(rows []bindingRow, previews map[dev.BindingKey][]workspace.BindingPreview) []bindingPreviewRow {
	out := []bindingPreviewRow{}
	for _, r := range rows {
		ps := previews[dev.BindingKey{Var: r.Var, Server: r.Server}]
		if ps == nil {
			ps = []workspace.BindingPreview{}
		}
		out = append(out, bindingPreviewRow{bindingRow: r, Previews: ps})
	}
	return out
}

func printPreviewRows(rows []bindingPreviewRow) {
	if jsonOutput {
		printJSON(rows)
		return
	}
	for _, r := range rows {
		fmt.Println(r.line() + "\t" + previewCell(r.Previews))
	}
}

// previewCell is a row's preview in one cell: the first resolved value and
// where, else the first reason it is left alone. Pure.
func previewCell(previews []workspace.BindingPreview) string {
	if len(previews) == 0 {
		return "→ no worktree to check against"
	}
	for _, p := range previews {
		if p.Resolved {
			tag := ""
			if !p.Running {
				tag = " · stopped"
			}
			return "→ " + p.Value + "  in " + p.Ref + tag
		}
	}
	return "→ left alone  " + previews[0].Detail
}
