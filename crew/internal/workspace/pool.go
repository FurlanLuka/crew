package workspace

import (
	"fmt"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/trash"
)

// The pool-facing readings of the workspace files: what stands between a
// project and its removal from the pool, where its checkouts are.

// CloneDisposition is what a pool removal does with a clone crew made.
type CloneDisposition int

const (
	TrashClone CloneDisposition = iota
	KeepClone
)

// CloneOutcome is what happened to the project's directory.
type CloneOutcome int

const (
	CloneTrashed   CloneOutcome = iota // crew's clone, moved to the trash
	CloneKept                          // crew's clone, left where it was (--keep-clone)
	CloneUntouched                     // the user's own checkout; never crew's to move
)

// PoolRemoval is what RemoveFromPool did.
type PoolRemoval struct {
	Path  string
	Clone CloneOutcome
}

// RemoveFromPool removes a project from the global pool — not from a
// workspace (that is RemoveProject). Refused while a workspace lists it
// or a check of it is kept; then the entry goes, and a clone crew made
// goes to the trash unless told to keep it. A path the user adopted is
// never moved. A trash failure after the entry went returns the removal
// with the clone kept and the error — Path set says the entry is gone.
func RemoveFromPool(name string, clone CloneDisposition) (PoolRemoval, error) {
	p := project.Get(name)
	if p == nil {
		return PoolRemoval{}, fmt.Errorf("project '%s' not found", name)
	}
	members, _ := WorkspacesWith(name)
	if err := PoolRemovalAllowed(*p, members, CheckExists(name)); err != nil {
		return PoolRemoval{}, err
	}
	if err := project.Remove(name); err != nil {
		return PoolRemoval{}, err
	}
	r := PoolRemoval{Path: p.Path, Clone: CloneUntouched}
	if !project.CrewOwned(*p) {
		return r, nil
	}
	if clone == KeepClone {
		r.Clone = CloneKept
		return r, nil
	}
	if _, err := trash.Put(p.Path); err != nil {
		// The pool entry is already gone; the clone stays where it was,
		// and the caller says both.
		r.Clone = CloneKept
		return r, fmt.Errorf("%v — clone left at %s", err, p.Path)
	}
	trash.Sweep()
	r.Clone = CloneTrashed
	return r, nil
}

// PoolRemovalAllowed: a project still listed by a workspace cannot leave
// the pool — the workspace names it and would no longer resolve — and
// neither can one with a check kept. Pure.
func PoolRemovalAllowed(p project.Project, members []string, hasCheck bool) error {
	if len(members) > 0 {
		hints := make([]string, 0, len(members))
		for _, m := range members {
			hints = append(hints, "crew rm workspace "+m+" "+p.Name)
		}
		return fmt.Errorf("project '%s' is still in workspace %s — %s first", p.Name, strings.Join(members, ", "), strings.Join(hints, "; "))
	}
	if hasCheck {
		return fmt.Errorf("a check of '%s' is kept — crew rm worktree check/%s first", p.Name, p.Name)
	}
	return nil
}

// PoolRemovalLine says what happened to the directory. Pure.
func PoolRemovalLine(r PoolRemoval) string {
	switch r.Clone {
	case CloneTrashed:
		return fmt.Sprintf("clone at %s moved to the trash", config.Tildify(r.Path))
	case CloneKept:
		return fmt.Sprintf("clone kept at %s", config.Tildify(r.Path))
	}
	return fmt.Sprintf("your checkout at %s is left alone", config.Tildify(r.Path))
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
