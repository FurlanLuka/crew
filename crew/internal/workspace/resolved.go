package workspace

import (
	"fmt"

	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// ResolvedProject is one project of a worktree with everything already looked
// up: its path decided, its pool config attached.
type ResolvedProject struct {
	Name       string
	Role       string
	Direct     bool
	Path       string
	DevServers []project.DevServer
	Bindings   []project.Binding
}

// Resolved is a worktree with every lookup already done — the workspace read
// once, the project pool read once.
//
// It exists because the alternative is what the code used to do: call
// ResolvePath per project per line, each call re-reading and unmarshalling
// projects.json, several times inside loops over the same projects. Consumers
// take a *Resolved and become pure functions over it.
type Resolved struct {
	Ref       Ref
	Slug      dev.Slug
	Dir       string
	Projects  []ResolvedProject
	Overrides map[string]string
}

// Resolve loads a workspace and binds it to one of its worktrees.
//
// An empty ref.Worktree selects the workspace's only worktree, and errors when
// there is more than one — the caller has to say which.
func Resolve(ref Ref) (*Resolved, error) {
	ws, err := Load(ref.Workspace)
	if err != nil {
		return nil, fmt.Errorf("workspace '%s' not found", ref.Workspace)
	}

	wt, err := selectWorktree(ws, ref.Worktree)
	if err != nil {
		return nil, err
	}
	ref.Worktree = wt.Name

	pool, _ := project.List()
	byName := make(map[string]project.Project, len(pool))
	for _, p := range pool {
		byName[p.Name] = p
	}

	projects := make([]ResolvedProject, 0, len(ws.Projects))
	for _, wp := range ws.Projects {
		rp := ResolvedProject{
			Name:   wp.Name,
			Role:   wp.Role,
			Direct: IsDirect(wp),
			Path:   WorktreePath(ref, wp.Name),
		}
		if p, ok := byName[wp.Name]; ok {
			rp.DevServers = p.DevServers
			rp.Bindings = p.Bindings
			if rp.Direct {
				rp.Path = p.Path
			}
		}
		projects = append(projects, rp)
	}

	return &Resolved{
		Ref:       ref,
		Slug:      ref.Slug(),
		Dir:       WorktreeDir(ref),
		Projects:  projects,
		Overrides: wt.Overrides,
	}, nil
}

// MultiProject reports whether the worktree holds more than one project, which
// is what decides between a flat Claude instance at the worktree root and one
// started directly inside the single project.
func (r *Resolved) MultiProject() bool { return len(r.Projects) > 1 }

// HasDirect reports whether any project points at its canonical repository.
func (r *Resolved) HasDirect() bool {
	for _, p := range r.Projects {
		if p.Direct {
			return true
		}
	}
	return false
}

// DevProjects converts to the shape dev.Start needs. dev cannot import
// workspace, so it declares its own input type and this builds it.
func (r *Resolved) DevProjects() []dev.DevProject {
	var projects []dev.DevProject
	for _, p := range r.Projects {
		// A project with bindings but no dev servers still takes part in
		// resolution — crew run and crew env are for exactly that project.
		if len(p.DevServers) == 0 && len(p.Bindings) == 0 {
			continue
		}
		var servers []dev.DevServerConfig
		for _, ds := range p.DevServers {
			servers = append(servers, dev.DevServerConfig{
				Name:    ds.Name,
				Port:    ds.Port,
				Command: ds.Command,
				Dir:     ds.Dir,
			})
		}
		var bindings []dev.Binding
		for _, b := range p.Bindings {
			bindings = append(bindings, dev.Binding{Var: b.Var, Value: b.Value})
		}
		projects = append(projects, dev.DevProject{
			Name:       p.Name,
			Path:       p.Path,
			DevServers: servers,
			Bindings:   bindings,
		})
	}
	return projects
}
