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
	names, err := List()
	if err != nil {
		return nil
	}

	var previews []BindingPreview
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
					params.Projects[i].Bindings = []dev.Binding{{Var: b.Var, Value: b.Value, Server: b.Server}}
				}
			}

			for _, r := range dev.ResolveBindings(params) {
				if r.Project != projName || r.Key() != b.Key() {
					continue
				}
				previews = append(previews, BindingPreview{
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

// WorkspacesWith names every workspace the project is a member of — what
// stands between a project and its removal from the pool.
func WorkspacesWith(projName string) ([]string, error) {
	names, err := List()
	if err != nil {
		return nil, err
	}
	var out []string
	for _, name := range names {
		if ws, err := Load(name); err == nil && hasProject(ws, projName) {
			out = append(out, name)
		}
	}
	return out, nil
}

func hasProject(ws *Workspace, projName string) bool {
	for _, wp := range ws.Projects {
		if wp.Name == projName {
			return true
		}
	}
	return false
}

// ProjectCheckouts is every directory holding a checkout of projName — the
// canonical repo plus each worktree it is in.
func ProjectCheckouts(projName string) []string {
	var dirs []string
	if p := project.Get(projName); p != nil {
		dirs = append(dirs, p.Path)
	}

	names, err := List()
	if err != nil {
		return dirs
	}
	for _, wsName := range names {
		ws, err := Load(wsName)
		if err != nil || !hasProject(ws, projName) {
			continue
		}
		for _, ref := range Refs(ws) {
			dirs = append(dirs, WorktreePath(ref, projName))
		}
	}
	return dirs
}
