package transfer

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/debug"
	crewexec "github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// The import of one project is one reading of its situation here, one
// decision made before anything touches disk, and one shell that carries
// it out. The plan rows, the wizard's cards and the CLI's flags all go
// through these, so none of them can disagree about a bundle entry.

// situation is what a bundle project is to this machine.
type situation int

const (
	sitHere        situation = iota // in the pool with this remote, or nothing to compare
	sitOtherRemote                  // in the pool; the local checkout points elsewhere
	sitClone                        // not here; the bundle says where to clone from
	sitBlocked                      // not here; the clone dir is already taken
	sitNoRemote                     // not here, nothing to clone: a path is the only way
)

// classify is the one reading of a status and a bundle remote. Pure.
func classify(st ProjectStatus, remote string) situation {
	switch {
	case st.Exists && (st.SameRemote(remote) || remote == ""):
		return sitHere
	case st.Exists:
		return sitOtherRemote
	case remote == "":
		return sitNoRemote
	case st.CloneDirTaken:
		return sitBlocked
	}
	return sitClone
}

// action is what importing one bundle project comes to.
type action int

const (
	actionKeep   action = iota // here already, no --replace: nothing to do
	actionRecord               // here, --replace: bundle config over the local record, checkout kept
	actionClone                // clone the remote into Path, then record
	actionAdopt                // record Path — a checkout the user already has — as the canonical
)

// decision is the action and the path it lands on.
type decision struct {
	Action action
	Path   string
	// Replace: the record that matched the bundle's name is swapped out first.
	Replace bool
}

// decide is pure over the situation and the caller's options. A replace on
// a name that is here with the same remote — or with nothing to compare, a
// config-only export — is a config sync: the local checkout stays. A
// replace with --path is "the repo moved", as crew add project --path is on
// an existing project; only a replace that clones is refused under live
// worktrees (applyDecision). A refusal here leaves nothing behind.
func decide(name, remote string, st ProjectStatus, o ProjectOptions) (decision, error) {
	sit := classify(st, remote)
	switch {
	case st.Exists && !o.Replace:
		return decision{Action: actionKeep}, nil
	case o.Path != "":
		return decision{Action: actionAdopt, Path: o.Path, Replace: st.Exists}, nil
	case sit == sitHere:
		return decision{Action: actionRecord, Path: st.Local.Path, Replace: true}, nil
	case sit == sitNoRemote:
		return decision{}, fmt.Errorf("%s has no git remote — --path=<dir> is the only way", name)
	}
	return decision{Action: actionClone, Path: project.ClonePath(name), Replace: st.Exists}, nil
}

// applyDecision runs one decision: everything that can refuse comes before
// the clone — the name, a pool collision under the imported name, the
// clone dir, the worktrees a replace would break — so a refusal leaves
// nothing behind. original is the bundle's name — what a replace swaps
// out, whatever the record is called now.
func applyDecision(original string, p project.Project, remote string, d decision) (ProjectResult, error) {
	if err := project.ValidateName(p.Name); err != nil {
		return ProjectResult{}, err
	}
	// A rename onto a name already in the pool is a collision, not a
	// replace — the replace only ever swaps the record the bundle named.
	if local := project.Get(p.Name); local != nil && !(d.Replace && p.Name == original) {
		return ProjectResult{}, fmt.Errorf("project '%s' is already in the pool — choose another name", p.Name)
	}
	switch d.Action {
	case actionRecord:
		// The checkout stays; only the record changes.
	case actionAdopt:
		if err := project.ValidateCheckoutDir(d.Path); err != nil {
			return ProjectResult{}, fmt.Errorf("%s: --path: %w", p.Name, err)
		}
		if abs, err := filepath.Abs(d.Path); err == nil {
			d.Path = abs
		}
	case actionClone:
		// The worktrees first: they are the reason a replace cannot go at
		// all, where a taken dir is only a step in the way.
		if d.Replace {
			if err := replaceUnderWorktrees(original, workspacesWith(original)); err != nil {
				return ProjectResult{}, err
			}
		}
		if project.CloneDirTaken(p.Name) {
			return ProjectResult{}, cloneDirTakenError(original, p.Name, d.Path)
		}
		debug.Log("transfer", "import %s: clone %s into %s", p.Name, crewexec.RepoKey(remote), d.Path)
		if err := crewexec.Clone(remote, d.Path); err != nil {
			return ProjectResult{}, fmt.Errorf("%s: %w", p.Name, err)
		}
	default:
		return ProjectResult{}, fmt.Errorf("%s: nothing to apply", p.Name)
	}
	p.Path = d.Path
	if err := ImportProject(original, p, d.Replace); err != nil {
		return ProjectResult{}, err
	}
	debug.Log("transfer", "import %s: %s at %s (replace=%v)", p.Name, actionWord(d.Action), d.Path, d.Replace)
	return ProjectResult{Name: p.Name, Path: p.Path, Cloned: d.Action == actionClone, Replaced: d.Replace}, nil
}

// cloneDirTakenError names the way out — which differs when the dir that
// is there is the project's own clone being replaced: adopting it would
// re-record the old repo, so the purge is the only way.
func cloneDirTakenError(original, name, dir string) error {
	if local := project.Get(original); local != nil && local.Path == dir {
		return fmt.Errorf("%s: %s already exists and is %s's own clone — crew rm project %s --purge first", name, dir, original, original)
	}
	return fmt.Errorf("%s: %s already exists — --path=%s adopts it, or delete it first", name, dir, dir)
}

// workspacesWith is the workspaces a project is a member of — what a
// replace that clones has to check.
func workspacesWith(name string) []string {
	members, _ := workspace.WorkspacesWith(name)
	return members
}

// replaceUnderWorktrees is the refusal for a replace that would move the
// canonical checkout: every worktree is a git worktree off it, so a clone
// swapped in underneath breaks them all. Pure.
func replaceUnderWorktrees(name string, members []string) error {
	if len(members) == 0 {
		return nil
	}
	return fmt.Errorf("%s is still in workspace %s — the checkout it points at cannot be swapped under its worktrees; crew rm workspace <ws> %s first", name, strings.Join(members, ", "), name)
}

func actionWord(a action) string {
	switch a {
	case actionRecord:
		return "recorded"
	case actionClone:
		return "cloned"
	}
	return "adopted"
}
