package transfer

import (
	"fmt"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// The wizard decides one card at a time with a person watching. An agent
// needs the same decisions as commands: see the plan, then apply one item
// with the choice spelled out as flags. Everything here composes the same
// primitives the wizard uses — Inspect, Suggest, CloneTarget, Clone,
// ImportProject, ImportWorkspace — so the two never disagree.

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
	StatusExists     = "exists"      // name already in the pool
	StatusPathExists = "path exists" // y imports as is
	StatusSuggested  = "suggested"   // a sibling found beside a known repo; Detail is the path
	StatusClone      = "clone"       // not here; Detail is where c would clone
	StatusMissing    = "missing"     // not here, nowhere to clone: --path is needed
	StatusReady      = "ready"       // workspace: every member present
	StatusNeeds      = "needs"       // workspace: Detail names the absent members
)

// PlanRows is the plan as rows, one per bundle item. Pure over plan.
func PlanRows(b Bundle, plan Plan) []PlanRow {
	rows := make([]PlanRow, 0, len(b.Projects)+len(b.Workspaces))
	for i, e := range b.Projects {
		st := plan.Projects[i]
		row := PlanRow{Kind: "project", Name: e.Name}
		switch {
		case st.Exists:
			row.Status, row.Detail = StatusExists, st.Local.Path
		case st.PathExists:
			row.Status, row.Detail = StatusPathExists, e.Path
		case st.Suggested != "":
			row.Status, row.Detail = StatusSuggested, st.Suggested
		case e.Remote != "":
			if t := CloneTarget(e.Path, plan.Anchors); t != "" {
				row.Status, row.Detail = StatusClone, t
			} else {
				row.Status, row.Detail = StatusMissing, e.Path
			}
		default:
			row.Status, row.Detail = StatusMissing, e.Path
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
	Path    string // use this path instead of the exported one
	Clone   bool   // clone the remote when the path is not here and no sibling was found
	CloneTo string // where to clone; empty means CloneTarget's guess
	Replace bool   // swap out the local record of the same name
	Name    string // import under this name
	Setup   string // override the setup command
}

// ProjectResult is what ApplyProject did.
type ProjectResult struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	Cloned   bool   `json:"cloned,omitempty"`
	Replaced bool   `json:"replaced,omitempty"`
}

// ApplyProject imports one bundle project the way a card would: the path is
// decided (given, cloned, suggested, or exported when it exists), then the
// record is added or replaced. It never guesses a path it cannot see.
func ApplyProject(b Bundle, plan Plan, name string, o ProjectOptions) (ProjectResult, error) {
	idx := indexOfProject(b, name)
	if idx < 0 {
		return ProjectResult{}, fmt.Errorf("project '%s' is not in the bundle", name)
	}
	e, st := b.Projects[idx], plan.Projects[idx]
	p := e.Project
	if o.Name != "" {
		p.Name = o.Name
	}
	if o.Setup != "" {
		p.Setup = o.Setup
	}
	if o.Path != "" {
		p.Path = o.Path
	}
	// Refuse before any clone: a refusal must leave nothing behind.
	if st.Exists && !o.Replace {
		return ProjectResult{}, fmt.Errorf("project '%s' already exists — --replace to swap it", e.Name)
	}

	// A sibling Suggest found beats a second clone of the same repo — the
	// card offers y for it; a bare --clone only fires when nothing is here.
	// An explicit --clone=<dir> is a decision and is honoured.
	cloned := false
	switch {
	case dirExists(p.Path):
	case o.Path == "" && o.CloneTo == "" && st.Suggested != "":
		p.Path = st.Suggested
	case o.Clone:
		if e.Remote == "" {
			return ProjectResult{}, fmt.Errorf("%s has no remote to clone from", e.Name)
		}
		target := o.CloneTo
		if target == "" {
			target = CloneTarget(p.Path, plan.Anchors)
		}
		if target == "" {
			return ProjectResult{}, fmt.Errorf("%s: nowhere to clone %s — give --clone=<dir>", e.Name, p.Path)
		}
		debug.Log("git", "import %s: clone into %s", e.Name, target)
		if err := Clone(e.Remote, target); err != nil {
			return ProjectResult{}, fmt.Errorf("%s: %w", e.Name, err)
		}
		p.Path, cloned = target, true
	default:
		return ProjectResult{}, fmt.Errorf("%s: %s is not here — --path=<dir> or --clone", e.Name, p.Path)
	}

	if err := ImportProject(e.Name, p, st.Exists); err != nil {
		return ProjectResult{}, err
	}
	return ProjectResult{Name: p.Name, Path: p.Path, Cloned: cloned, Replaced: st.Exists}, nil
}

// ApplyWorkspace creates one bundle workspace. Members must already be in
// the pool: the plan's pool snapshot is refreshed here, so projects imported
// a moment ago count.
func ApplyWorkspace(b Bundle, name string) error {
	idx := indexOfWorkspace(b, name)
	if idx < 0 {
		return fmt.Errorf("workspace '%s' is not in the bundle", name)
	}
	m := b.Workspaces[idx]
	known := map[string]bool{}
	pool, _ := project.List()
	for _, p := range pool {
		known[p.Name] = true
	}
	if need := MissingMembers(m, known); len(need) > 0 {
		return fmt.Errorf("workspace '%s' needs %s — import them first", name, strings.Join(need, ", "))
	}
	return ImportWorkspace(m, nil)
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
