// Package transfer moves projects and workspace membership between machines
// as one file. Everything local — worktrees, ports, overrides — stays behind.
package transfer

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	crewexec "github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// Version is the bundle format; Read refuses anything newer.
const Version = 1

// Bundle is the file.
type Bundle struct {
	Version    int          `json:"version"`
	Projects   []Exported   `json:"projects"`
	Workspaces []Membership `json:"workspaces"`
}

// Exported is a pool entry plus where it can be cloned from, so a path that
// does not exist on the other machine is not a dead end.
type Exported struct {
	project.Project
	Remote string `json:"remote,omitempty"`
}

// Membership is what a workspace is made of: projects with roles and modes.
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
			b.Projects = append(b.Projects, Exported{Project: p, Remote: originOf(p.Path)})
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

// originOf is the origin URL, or "" — a repo without one exports fine, it
// just cannot be cloned on the other side.
func originOf(repo string) string {
	out, err := crewexec.RunGitCommand(repo, "remote", "get-url", "origin")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
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

// ProjectStatus is what the card knows before any key is pressed.
type ProjectStatus struct {
	Exists     bool   // name already in the pool
	PathExists bool   // the exported path is here
	Suggested  string // an existing dir found beside a known repo, or ""
	Local      *project.Project
}

// WorkspaceStatus: an existing name is skip-only.
type WorkspaceStatus struct {
	Exists bool
}

type Plan struct {
	Projects   []ProjectStatus
	Workspaces []WorkspaceStatus
	// Known and Anchors are the pool as it was when the bundle was inspected —
	// one read, then the wizard reasons over the snapshot.
	Known   map[string]bool // project names in the pool
	Anchors []string        // pool project paths, for Suggest and CloneTarget
}

// Inspect checks a bundle against this machine: the pool, read once, and the
// filesystem. Per-card state that depends on earlier decisions
// (MissingMembers, CloneTarget) is asked for as the wizard reaches each card.
func Inspect(b Bundle) Plan {
	pool, _ := project.List()
	plan := Plan{Known: make(map[string]bool, len(pool))}
	for _, p := range pool {
		plan.Known[p.Name] = true
		plan.Anchors = append(plan.Anchors, p.Path)
	}
	for _, e := range b.Projects {
		st := ProjectStatus{PathExists: dirExists(e.Path)}
		if local := project.Get(e.Name); local != nil {
			st.Exists, st.Local = true, local
		}
		if !st.PathExists {
			st.Suggested = Suggest(e.Path, plan.Anchors)
		}
		plan.Projects = append(plan.Projects, st)
	}
	for _, m := range b.Workspaces {
		plan.Workspaces = append(plan.Workspaces, WorkspaceStatus{Exists: workspace.Exists(m.Name)})
	}
	return plan
}

// Suggest looks for the exported path's basename beside each anchor — a repo
// this machine already knows about, checked latest first. A second Mac tends
// to keep siblings together even when the parent differs. Pure over the fs.
func Suggest(exported string, anchors []string) string {
	base := filepath.Base(exported)
	for i := len(anchors) - 1; i >= 0; i-- {
		candidate := filepath.Join(filepath.Dir(anchors[i]), base)
		if candidate != exported && dirExists(candidate) {
			return candidate
		}
	}
	return ""
}

// CloneTarget is where c would clone: beside the latest anchor, else into the
// exported path when its parent exists here, else "" — the card asks for a
// path first. Pure over the fs.
func CloneTarget(exported string, anchors []string) string {
	base := filepath.Base(exported)
	if len(anchors) > 0 {
		return filepath.Join(filepath.Dir(anchors[len(anchors)-1]), base)
	}
	if dirExists(filepath.Dir(exported)) {
		return exported
	}
	return ""
}

// MissingPaths is what stops a non-interactive import: bundle projects that
// are neither here by name nor by path. A --all never guesses or clones.
func MissingPaths(b Bundle, plan Plan) []Exported {
	var missing []Exported
	for i, e := range b.Projects {
		if !plan.Projects[i].Exists && !plan.Projects[i].PathExists {
			missing = append(missing, e)
		}
	}
	return missing
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

// Clone is exec.Clone; the wizard reaches it from here so nothing else in
// the package touches git directly.
func Clone(remote, target string) error { return crewexec.Clone(remote, target) }

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

// ImportWorkspace creates the workspace and checks every member out into its
// main worktree — what crew add workspace does, no installs. A member that
// fails leaves the ones before it; the error names it.
func ImportWorkspace(m Membership, progress func(projName string, i, n int)) error {
	if workspace.Exists(m.Name) {
		return fmt.Errorf("workspace '%s' already exists", m.Name)
	}
	if err := workspace.Create(m.Name); err != nil {
		return err
	}
	for i, wp := range m.Projects {
		if progress != nil {
			progress(wp.Name, i+1, len(m.Projects))
		}
		if err := workspace.AddProject(m.Name, wp.Name, wp.Role, wp.Mode, workspace.CheckoutOptions{}); err != nil {
			return fmt.Errorf("%s: %w", wp.Name, err)
		}
	}
	return nil
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
