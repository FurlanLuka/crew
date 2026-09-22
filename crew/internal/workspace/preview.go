package workspace

import (
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// BindingPreview is one binding resolved against one real worktree.
type BindingPreview struct {
	Ref      string
	Value    string
	Resolved bool
	// Running is false when the value came from the worktree's reserved
	// ports rather than live servers — right, but not yet true.
	Running bool
	Detail  string
}

// PreviewBinding resolves one binding against every worktree the project is in.
//
// This is what makes the binding editor trustworthy: the real value, before
// saving, and the worktrees where it will not resolve — which is normal, and
// far better seen at declaration time than at start time.
func PreviewBinding(projName string, b project.Binding) []BindingPreview {
	return PreviewBindings(projName, []project.Binding{b})[b.Key()]
}

// PreviewBindings is PreviewBinding for every binding of a project at
// once: each worktree is resolved a single time with all of them
// substituted, which is what a page showing every row needs.
func PreviewBindings(projName string, bs []project.Binding) map[dev.BindingKey][]BindingPreview {
	previews := map[dev.BindingKey][]BindingPreview{}
	names, err := List()
	if err != nil || len(bs) == 0 {
		return previews
	}
	drafts := make([]dev.Binding, 0, len(bs))
	want := map[dev.BindingKey]bool{}
	for _, b := range bs {
		drafts = append(drafts, dev.Binding{Var: b.Var, Value: b.Value, Server: b.Server})
		want[b.Key()] = true
	}

	for _, wsName := range names {
		ws, err := Load(wsName)
		if err != nil || !hasProject(ws, projName) {
			continue
		}

		for _, ref := range Refs(ws) {
			res, err := Resolve(ref)
			if err != nil {
				continue
			}

			// Substitute the draft for whatever the pool currently declares, so
			// an edit previews as edited rather than as saved.
			// A stopped worktree resolves against the ports it will get back on
			// the next start, so the editor shows a value while nothing runs.
			routes, _ := dev.LoadRoutes(res.Slug)
			ports := dev.IndexRoutePorts(routes)
			running := len(ports) > 0
			if !running {
				ports = dev.IndexReservedPorts(res.Ports)
			}
			params := res.ResolveParams(ports)
			for i := range params.Projects {
				if params.Projects[i].Name == projName {
					params.Projects[i].Bindings = drafts
				}
			}

			for _, r := range dev.ResolveBindings(params) {
				if r.Project != projName || !want[r.Key()] {
					continue
				}
				previews[r.Key()] = append(previews[r.Key()], BindingPreview{
					Ref:      ref.String(),
					Value:    r.Value,
					Resolved: r.Resolved(),
					Running:  running,
					Detail:   r.Detail,
				})
			}
		}
	}
	return previews
}
