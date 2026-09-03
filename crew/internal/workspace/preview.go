package workspace

import (
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// PreviewBinding resolves one binding against every worktree the project is in.
//
// This is what makes the binding editor trustworthy: the real value, before
// saving, and the worktrees where it will not resolve — which is normal, and
// far better seen at declaration time than at start time.
func PreviewBinding(projName string, b project.Binding) []project.BindingPreview {
	names, err := List()
	if err != nil {
		return nil
	}

	var previews []project.BindingPreview
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
			routes, _ := dev.LoadRoutes(res.Slug)
			params := res.ResolveParams(dev.IndexRoutePorts(routes))
			for i := range params.Projects {
				if params.Projects[i].Name == projName {
					params.Projects[i].Bindings = []dev.Binding{{Var: b.Var, Value: b.Value}}
				}
			}

			for _, r := range dev.ResolveBindings(params) {
				if r.Project != projName || r.Var != b.Var {
					continue
				}
				previews = append(previews, project.BindingPreview{
					Ref:      ref.String(),
					Value:    r.Value,
					Resolved: r.Resolved(),
					Detail:   r.Detail,
				})
			}
		}
	}
	return previews
}

func hasProject(ws *Workspace, projName string) bool {
	for _, wp := range ws.Projects {
		if wp.Name == projName {
			return true
		}
	}
	return false
}
