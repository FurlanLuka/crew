package workspace

import (
	"path/filepath"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/project"
)

// PathOwner is one folder crew keeps for a worktree: its root (Project
// empty) or one project's checkout.
type PathOwner struct {
	Ref     Ref
	Project string
	Dir     string
}

// RefForPath finds the worktree a folder belongs to: the owner whose Dir is
// the path or holds it, the deepest one winning, so a checkout beats its
// worktree root. Both sides arrive cleaned and symlink-free. Pure.
func RefForPath(path string, owners []PathOwner) (PathOwner, bool) {
	var best PathOwner
	found := false
	for _, o := range owners {
		if o.Dir == "" || (path != o.Dir && !strings.HasPrefix(path, o.Dir+string(filepath.Separator))) {
			continue
		}
		if !found || len(o.Dir) > len(best.Dir) {
			best, found = o, true
		}
	}
	return best, found
}

// WhichPath answers `crew which`: the folder's worktree, read from the
// workspace files, the pool and the checks once each — no tmux, no pids,
// since the crew mod asks this at the start of every session.
func WhichPath(path string) (PathOwner, bool, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return PathOwner{}, false, err
	}
	owners, err := pathOwners()
	if err != nil {
		return PathOwner{}, false, err
	}
	// macOS hands out /var and /private/var for the same folder; compare
	// both sides with their symlinks resolved.
	o, ok := RefForPath(realPath(abs), owners)
	return o, ok, nil
}

func pathOwners() ([]PathOwner, error) {
	names, err := List()
	if err != nil {
		return nil, err
	}
	pool, _ := project.List()
	poolPaths := make(map[string]string, len(pool))
	for _, p := range pool {
		poolPaths[p.Name] = p.Path
	}

	var owners []PathOwner
	add := func(ref Ref, proj, dir string) {
		if dir != "" {
			owners = append(owners, PathOwner{Ref: ref, Project: proj, Dir: realPath(dir)})
		}
	}
	for _, name := range names {
		ws, err := Load(name)
		if err != nil {
			continue
		}
		for _, ref := range Refs(ws) {
			add(ref, "", WorktreeDir(ref))
			for _, wp := range ws.Projects {
				if IsDirect(wp) {
					// directRefusal keeps a direct project in one worktree,
					// so its pool path has one answer.
					add(ref, wp.Name, poolPaths[wp.Name])
					continue
				}
				add(ref, wp.Name, WorktreePath(ref, wp.Name))
			}
		}
	}

	checks, _ := ListChecks()
	for _, c := range checks {
		ref := CheckRef(c.Project)
		add(ref, "", WorktreeDir(ref))
		add(ref, c.Project, WorktreePath(ref, c.Project))
	}
	return owners, nil
}

// realPath resolves symlinks where the path exists, and walks up to the
// nearest existing parent otherwise, so a checkout not made yet still
// compares under its resolved root.
func realPath(path string) string {
	clean := filepath.Clean(path)
	if resolved, err := filepath.EvalSymlinks(clean); err == nil {
		return resolved
	}
	parent := filepath.Dir(clean)
	if parent == clean {
		return clean
	}
	return filepath.Join(realPath(parent), filepath.Base(clean))
}
