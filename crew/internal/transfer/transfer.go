// Package transfer moves projects and workspace membership between machines
// as one file. Everything local — worktrees, ports, overrides — stays behind.
package transfer

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	crewexec "github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// Version is the bundle format; Read refuses anything newer. 2 dropped the
// path: a v1 crew handed a path-less bundle would guess a parent directory
// as the checkout, so it must refuse instead. v1 bundles still read — the
// remote was already there, the path is ignored.
const Version = 2

// Bundle is the file.
type Bundle struct {
	Version    int          `json:"version"`
	Projects   []Exported   `json:"projects"`
	Workspaces []Membership `json:"workspaces"`
}

// Exported is a pool entry by its identity: the remote it can be cloned
// from, with its config. The path stays behind — it is this machine's.
// A v1 bundle's path is read into Project.Path and shown as a hint only.
type Exported struct {
	project.Project
	Remote string `json:"remote,omitempty"`
}

// Membership is what a workspace is made of: projects and their modes.
// Worktrees are deliberately absent.
type Membership struct {
	Name     string                       `json:"name"`
	Projects []workspace.WorkspaceProject `json:"projects"`
}

// ── Export ──

// Collect builds a bundle from the named projects and workspaces.
func Collect(projNames, wsNames []string) (Bundle, error) {
	pool, err := project.List()
	if err != nil {
		return Bundle{}, err
	}
	want := toSet(projNames)
	b := Bundle{Version: Version, Projects: []Exported{}, Workspaces: []Membership{}}
	for _, p := range pool {
		if want[p.Name] {
			remote := project.RemoteOf(p)
			p.Path = ""
			b.Projects = append(b.Projects, Exported{Project: p, Remote: remote})
		}
	}
	for _, name := range wsNames {
		ws, err := workspace.Load(name)
		if err != nil {
			return Bundle{}, fmt.Errorf("workspace %s: %w", name, err)
		}
		b.Workspaces = append(b.Workspaces, Membership{Name: ws.Name, Projects: ws.Projects})
	}
	return b, nil
}

// WithoutRemote names the bundle projects nothing can clone — worth a line
// at export time, since the bundle is still a config backup. Pure.
func WithoutRemote(b Bundle) []string {
	var out []string
	for _, e := range b.Projects {
		if e.Remote == "" {
			out = append(out, e.Name)
		}
	}
	return out
}

// Covered is every workspace whose projects are all chosen — the rule that
// decides what the export picker offers. Pure.
func Covered(all []*workspace.Workspace, chosen map[string]bool) []Membership {
	var out []Membership
	for _, ws := range all {
		if len(Uncovered(ws, chosen)) == 0 {
			out = append(out, Membership{Name: ws.Name, Projects: ws.Projects})
		}
	}
	return out
}

// Uncovered names the workspace's projects that are not chosen. Pure.
func Uncovered(ws *workspace.Workspace, chosen map[string]bool) []string {
	return unmet(ws.Projects, chosen)
}

// unmet is the one shape both sides share: members whose name is not in the
// set. Pure.
func unmet(members []workspace.WorkspaceProject, ok map[string]bool) []string {
	var missing []string
	for _, wp := range members {
		if !ok[wp.Name] {
			missing = append(missing, wp.Name)
		}
	}
	return missing
}

func Write(path string, b Bundle) error {
	data, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}

func Read(path string) (Bundle, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Bundle{}, err
	}
	var b Bundle
	if err := json.Unmarshal(data, &b); err != nil {
		return Bundle{}, fmt.Errorf("%s is not a crew export: %w", path, err)
	}
	if b.Version == 0 {
		return Bundle{}, fmt.Errorf("%s is not a crew export (no version)", path)
	}
	if b.Version > Version {
		return Bundle{}, fmt.Errorf("%s is version %d; this crew reads up to %d — run crew update", path, b.Version, Version)
	}
	return b, nil
}

// ── Import: inspection ──

// ProjectStatus is what the card knows before any key is pressed: whether
// the name is here, what its checkout points at, and whether the clone
// crew would make has somewhere to land.
type ProjectStatus struct {
	Exists      bool   // name already in the pool
	LocalRemote string // RemoteOf the local entry; "" when it has none
	// CloneDirTaken: ClonePath(name) already exists, so the default clone
	// is refused — --path adopts it, or it is deleted first.
	CloneDirTaken bool
	// Workspaces the local project is a member of: a replace that clones
	// is refused while any (its worktrees hang off the checkout).
	Workspaces []string
	// Local is the pool entry; set exactly when Exists.
	Local *project.Project
}

// SameRemote: the local checkout is this repo, by key. Two empties are not
// the same repo — nothing was compared.
func (st ProjectStatus) SameRemote(remote string) bool {
	return st.Exists && remote != "" && crewexec.RepoKey(st.LocalRemote) == crewexec.RepoKey(remote)
}

// WorkspaceStatus: an existing name is skip-only.
type WorkspaceStatus struct {
	Exists bool
}

type Plan struct {
	Projects   []ProjectStatus
	Workspaces []WorkspaceStatus
	// Known is the pool as it was when the bundle was inspected — one
	// read, then the wizard reasons over the snapshot.
	Known map[string]bool // project names in the pool
}

// Inspect checks a bundle against this machine: the pool, read once, each
// local entry's remote read off its checkout, and the clone dir. Per-card
// state that depends on earlier decisions (MissingMembers) is asked for as
// the wizard reaches each card.
func Inspect(b Bundle) Plan {
	pool, _ := project.List()
	plan := Plan{Known: make(map[string]bool, len(pool))}
	byName := make(map[string]project.Project, len(pool))
	for _, p := range pool {
		plan.Known[p.Name] = true
		byName[p.Name] = p
	}
	members := membership()
	for _, e := range b.Projects {
		st := ProjectStatus{CloneDirTaken: project.CloneDirTaken(e.Name)}
		if local, ok := byName[e.Name]; ok {
			st.Exists, st.LocalRemote = true, project.RemoteOf(local)
			st.Local = &local
			st.Workspaces = members[e.Name]
		}
		plan.Projects = append(plan.Projects, st)
	}
	for _, m := range b.Workspaces {
		plan.Workspaces = append(plan.Workspaces, WorkspaceStatus{Exists: workspace.Exists(m.Name)})
	}
	return plan
}

// membership is every workspace each project is a member of — the
// workspace files read once for the whole inspection, not once per bundle
// project.
func membership() map[string][]string {
	out := map[string][]string{}
	names, _ := workspace.List()
	for _, name := range names {
		ws, err := workspace.Load(name)
		if err != nil {
			continue
		}
		for _, wp := range ws.Projects {
			out[wp.Name] = append(out[wp.Name], name)
		}
	}
	return out
}

// Refusals is what stops a non-interactive import before anything is
// cloned: bundle projects that cannot go as they are — no remote, the clone
// dir already taken, or (under --replace) another remote for a project
// whose worktrees hang off the local checkout. --all never guesses. Pure.
func Refusals(b Bundle, plan Plan, o ProjectOptions) []PlanRow {
	var out []PlanRow
	rows := PlanRows(b, plan)
	for i, e := range b.Projects {
		row, st := rows[i], plan.Projects[i]
		switch {
		case row.Status == StatusMissing || row.Status == StatusBlocked:
			out = append(out, row)
		case o.Replace && row.Status == StatusOtherRemote && len(st.Workspaces) > 0:
			row.Detail = replaceUnderWorktrees(e.Name, st.Workspaces).Error()
			out = append(out, row)
		}
	}
	return out
}

// AllRows is the non-interactive import of every bundle project, in
// order: the ones here are kept (swapped under --replace), the rest go
// through ApplyProject; a failure is that project's row, not the end of
// the run. The caller has already taken Refusals to heart.
func AllRows(b Bundle, plan Plan, o ProjectOptions, outcome func(ProjectResult) string) []PlanRow {
	rows := make([]PlanRow, 0, len(b.Projects))
	for i, e := range b.Projects {
		if plan.Projects[i].Exists && !o.Replace {
			rows = append(rows, PlanRow{Kind: "project", Name: e.Name, Status: "kept local"})
			continue
		}
		res, err := ApplyProject(b, plan, e.Name, o)
		if err != nil {
			rows = append(rows, PlanRow{Kind: "project", Name: e.Name, Status: "failed", Detail: err.Error()})
			continue
		}
		rows = append(rows, PlanRow{Kind: "project", Name: e.Name, Status: outcome(res), Detail: res.Path})
	}
	return rows
}

// RefusalLines is how --all names what it will not touch. Pure.
func RefusalLines(rows []PlanRow) []string {
	lines := make([]string, 0, len(rows))
	for _, r := range rows {
		lines = append(lines, fmt.Sprintf("  %s\t%s\t%s", r.Name, r.Status, r.Detail))
	}
	return lines
}

// MissingMembers is what keeps a workspace card from offering y: members not
// present — neither accepted in this import nor in the pool snapshot. Pure.
func MissingMembers(m Membership, present map[string]bool) []string {
	return unmet(m.Projects, present)
}

// ReferencedBy names the bundle members whose bindings point at projName, so
// a rename can warn about what it leaves dangling. Pure.
func ReferencedBy(b Bundle, projName string) []string {
	var refs []string
	for _, e := range b.Projects {
		for _, bd := range e.Bindings {
			if strings.Contains(bd.Value, "{{"+projName+"}}") || strings.Contains(bd.Value, "{{"+projName+"/") || strings.Contains(bd.Value, "{{"+projName+".") {
				refs = append(refs, e.Name+"'s "+bd.Var)
			}
		}
	}
	sort.Strings(refs)
	return refs
}

// ── Import: actions ──

// ImportProject adds p to the pool. With replace, the record that matched
// the bundle's original name is swapped out — whatever the name field says
// now — so a card that was renamed and replaced does not leave the old one.
func ImportProject(original string, p project.Project, replace bool) error {
	if err := project.ValidateName(p.Name); err != nil {
		return err
	}
	if replace {
		if err := project.Remove(original); err != nil {
			return err
		}
	} else if project.Get(p.Name) != nil {
		return fmt.Errorf("project '%s' already exists", p.Name)
	}
	return project.Add(p)
}

// Workspace is the membership as the workspace it would be — what the
// base-branch helpers read before it exists on disk.
func (m Membership) Workspace() *workspace.Workspace {
	return &workspace.Workspace{Name: m.Name, Projects: m.Projects}
}

// ImportWorkspace creates the workspace and its main worktree the way crew
// add workspace does — workspace.CreateWith: every member checked before
// anything happens, then one runner per project, each failure recorded on
// the worktree as it lands. Returns the main worktree's ref once the
// runners are started (false when the workspace was empty: nothing to
// run); the error is pre-flight only.
func ImportWorkspace(m Membership, opts workspace.CheckoutOptions) (workspace.Ref, bool, error) {
	specs := make([]workspace.ProjectSpec, len(m.Projects))
	for i, wp := range m.Projects {
		specs[i] = workspace.ProjectSpec{Name: wp.Name, Mode: wp.Mode}
	}
	return workspace.CreateWith(m.Name, specs, opts)
}

// WorkspaceRow is the import's row for a workspace and whether it counts
// as failed for the exit code: an error is `failed`; a create whose
// runners are still going is `created` with the status command; one
// waited for with issues is `created` with the fix line and still failed.
// Pure over the health the caller read (nil while not waited for).
func WorkspaceRow(name string, started bool, h *workspace.Health, waited bool, err error) (PlanRow, bool) {
	if err != nil {
		return PlanRow{Kind: "workspace", Name: name, Status: "failed", Detail: err.Error()}, true
	}
	row := PlanRow{Kind: "workspace", Name: name, Status: "created"}
	ref := workspace.Ref{Workspace: name, Worktree: workspace.DefaultWorktree}
	switch {
	case !started:
		return row, false
	case !waited:
		row.Detail = fmt.Sprintf("installing — crew setup status %s", ref)
		return row, false
	case h != nil:
		row.Detail = fmt.Sprintf("%d issue(s) recorded — crew fix %s --print / crew verify %s", len(h.Issues), ref, ref)
		return row, true
	}
	return row, false
}

// ── helpers ──

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func toSet(names []string) map[string]bool {
	set := make(map[string]bool, len(names))
	for _, n := range names {
		set[n] = true
	}
	return set
}
