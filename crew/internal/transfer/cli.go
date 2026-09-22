package transfer

import (
	"fmt"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/project"
)

// The wizard decides one card at a time with a person watching. An agent
// needs the same decisions as commands: see the plan, then apply one item
// with the choice spelled out as flags. Everything here composes the same
// primitives the wizard uses — Inspect, decide, applyDecision,
// ImportWorkspace — so the two never disagree.

// PlanRow is one line of `crew import --plan`: what the bundle holds and what
// would happen here.
type PlanRow struct {
	Kind   string `json:"kind"` // project | workspace
	Name   string `json:"name"`
	Status string `json:"status"`
	Detail string `json:"detail,omitempty"`
}

// Project statuses. A status is what the card would show before any key.
const (
	StatusExists      = "exists"       // here, same remote (or nothing to compare); Detail is the local path
	StatusOtherRemote = "other remote" // here, but the local checkout points elsewhere; Detail names it
	StatusClone       = "clone"        // not here; Detail is where the clone lands
	StatusBlocked     = "blocked"      // not here and the clone dir is taken; --path adopts it, or delete it
	StatusMissing     = "missing"      // not here and no remote to clone: --path is the only way
	StatusReady       = "ready"        // workspace: every member present
	StatusNeeds       = "needs"        // workspace: Detail names the absent members
)

// PlanRows is the plan as rows, one per bundle item: the situation, worded
// with its way out. Pure over plan.
func PlanRows(b Bundle, plan Plan) []PlanRow {
	rows := make([]PlanRow, 0, len(b.Projects)+len(b.Workspaces))
	for i, e := range b.Projects {
		st := plan.Projects[i]
		row := PlanRow{Kind: "project", Name: e.Name}
		switch classify(st, e.Remote) {
		case sitHere:
			row.Status, row.Detail = StatusExists, st.Local.Path
		case sitOtherRemote:
			row.Status, row.Detail = StatusOtherRemote, "local "+orNoRemote(st.LocalRemote)
		case sitNoRemote:
			row.Status, row.Detail = StatusMissing, missingDetail(e)
		case sitBlocked:
			row.Status, row.Detail = StatusBlocked, blockedDetail(project.ClonePath(e.Name))
		default:
			row.Status, row.Detail = StatusClone, project.ClonePath(e.Name)
		}
		rows = append(rows, row)
	}
	for i, m := range b.Workspaces {
		row := PlanRow{Kind: "workspace", Name: m.Name}
		switch need := MissingMembers(m, plan.Known); {
		case plan.Workspaces[i].Exists:
			row.Status = StatusExists
		case len(need) > 0:
			row.Status, row.Detail = StatusNeeds, strings.Join(need, ", ")
		default:
			row.Status = StatusReady
		}
		rows = append(rows, row)
	}
	return rows
}

// ProjectOptions is the card's decision as flags.
type ProjectOptions struct {
	Path    string // adopt this checkout instead of cloning
	Replace bool   // swap out the local record of the same name
	Name    string // import under this name
	Setup   string // override the setup command
	EnvCmd  string // override the env command
}

// orNoRemote is a remote for a Detail column, or the words for none.
func orNoRemote(remote string) string {
	if remote == "" {
		return "no remote"
	}
	return remote
}

// blockedDetail is the plan row's wording for a taken clone dir.
func blockedDetail(path string) string {
	if !adoptable(path) {
		return path + " exists and is not a directory — delete it first"
	}
	return fmt.Sprintf("%s exists — --path=%s adopts it, or delete it", path, path)
}

// adoptable: what sits at the clone path could be recorded as the checkout
// (a dir), as opposed to a file that can only be deleted. The card and the
// plan row both word the way out from this.
func adoptable(path string) bool { return project.ValidateCheckoutDir(path) == nil }

// missingDetail: a v1 bundle carried the path the repo had on the other
// machine — the best hint there is for where to --path from.
func missingDetail(e Exported) string {
	d := "no git remote — --path=<dir>"
	if e.Path != "" {
		d += " (was at " + e.Path + ")"
	}
	return d
}

// ProjectResult is what ApplyProject did.
type ProjectResult struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	Cloned   bool   `json:"cloned,omitempty"`
	Replaced bool   `json:"replaced,omitempty"`
}

// ApplyProject imports one bundle project the way a card would: the
// decision first, then the clone or the adoption, then the record. It
// never guesses a path and refuses before anything is cloned.
func ApplyProject(b Bundle, plan Plan, name string, o ProjectOptions) (ProjectResult, error) {
	idx := indexOfProject(b, name)
	if idx < 0 {
		return ProjectResult{}, fmt.Errorf("project '%s' is not in the bundle", name)
	}
	e, st := b.Projects[idx], plan.Projects[idx]
	p := withOptions(e.Project, o)
	d, err := decide(p.Name, e.Remote, st, o)
	if err != nil {
		return ProjectResult{}, err
	}
	if d.Action == actionKeep {
		return ProjectResult{}, fmt.Errorf("project '%s' already exists — --replace to swap it", e.Name)
	}
	return applyDecision(e.Name, p, e.Remote, d)
}

// withOptions is the bundle entry as it will be recorded: the overrides
// applied; the path is applyDecision's to set. Pure.
func withOptions(p project.Project, o ProjectOptions) project.Project {
	if o.Name != "" {
		p.Name = o.Name
	}
	if o.Setup != "" {
		p.Setup = o.Setup
	}
	if o.EnvCmd != "" {
		p.EnvCmd = o.EnvCmd
	}
	return p
}

// MembershipOf is the bundle workspace by name, checked against the pool
// as it is now — the plan's snapshot is refreshed here, so a project
// imported a moment ago counts. The caller shows the base table and then
// ImportWorkspaces it.
func MembershipOf(b Bundle, name string) (Membership, error) {
	idx := indexOfWorkspace(b, name)
	if idx < 0 {
		return Membership{}, fmt.Errorf("workspace '%s' is not in the bundle", name)
	}
	m := b.Workspaces[idx]
	known := map[string]bool{}
	pool, _ := project.List()
	for _, p := range pool {
		known[p.Name] = true
	}
	if need := MissingMembers(m, known); len(need) > 0 {
		return Membership{}, fmt.Errorf("workspace '%s' needs %s — import them first", name, strings.Join(need, ", "))
	}
	return m, nil
}

func indexOfProject(b Bundle, name string) int {
	for i, e := range b.Projects {
		if e.Name == name {
			return i
		}
	}
	return -1
}

func indexOfWorkspace(b Bundle, name string) int {
	for i, m := range b.Workspaces {
		if m.Name == name {
			return i
		}
	}
	return -1
}
