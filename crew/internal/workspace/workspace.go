package workspace

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/trash"
)

var validWSName = regexp.MustCompile(`^[a-z0-9-]+$`)

// Mode constants for WorkspaceProject.Mode.
const (
	ModeWorktree = "worktree"
	ModeDirect   = "direct"
)

// WorkspaceProject references a global project with a workspace-specific role.
//
// Mode controls path resolution:
//   - "" or "worktree" — workspace gets its own git worktree (default).
//   - "direct" — workspace points at the project's canonical checkout. No worktree
//     is created, and removing the project does NOT touch the underlying repo.
type WorkspaceProject struct {
	Name string `json:"name"`
	Role string `json:"role"`
	Mode string `json:"mode,omitempty"`
}

// IsDirect reports whether a workspace project uses direct mode (no worktree).
func IsDirect(wp WorkspaceProject) bool {
	return wp.Mode == ModeDirect
}

// Worktree is one working copy of a workspace's projects. Overrides pin a
// variable for this worktree only, beating whatever binding would otherwise
// resolve it; keys are "VAR" or "project.VAR", and the qualified form wins.
type Worktree struct {
	Name      string            `json:"name"`
	Overrides map[string]string `json:"overrides,omitempty"`
	// Ports remembers the port each dev server was bound to, keyed
	// "project/server", so a worktree keeps its ports across restarts.
	Ports map[string]int `json:"ports,omitempty"`
	// Health is the last failure a check found — absent when the last check
	// passed. Only an explicit verify or setup clears it.
	Health *Health `json:"health,omitempty"`
}

type Workspace struct {
	Name      string             `json:"name"`
	Projects  []WorkspaceProject `json:"projects"`
	Worktrees []Worktree         `json:"worktrees,omitempty"`
}

// WorktreeOf is selectWorktree for callers that already hold the workspace.
func WorktreeOf(ws *Workspace, ref Ref) (Worktree, error) { return selectWorktree(ws, ref.Worktree) }

// selectWorktree picks the named worktree, or the only one when unnamed.
//
// A workspace with no worktrees at all predates the nested layout. It resolves
// to a single unnamed worktree so its paths and slug stay flat, which is what
// keeps crew working against un-migrated state.
func selectWorktree(ws *Workspace, name string) (Worktree, error) {
	if len(ws.Worktrees) == 0 {
		return Worktree{}, nil
	}
	if name == "" {
		if len(ws.Worktrees) == 1 {
			return ws.Worktrees[0], nil
		}
		return Worktree{}, fmt.Errorf("workspace '%s' has %d worktrees (%s) — say which: %s/<worktree>",
			ws.Name, len(ws.Worktrees), strings.Join(WorktreeNames(ws), ", "), ws.Name)
	}
	for _, wt := range ws.Worktrees {
		if wt.Name == name {
			return wt, nil
		}
	}
	return Worktree{}, fmt.Errorf("workspace '%s' has no worktree '%s' (have: %s)",
		ws.Name, name, strings.Join(WorktreeNames(ws), ", "))
}

// WorktreeNames lists a workspace's worktree names in declaration order.
func WorktreeNames(ws *Workspace) []string {
	names := make([]string, 0, len(ws.Worktrees))
	for _, wt := range ws.Worktrees {
		names = append(names, wt.Name)
	}
	return names
}

// DefaultWorktree is the worktree a new workspace starts with, and what
// migration names the single worktree of a workspace that had no naming
// convention to read.
const DefaultWorktree = "main"

// Create creates a new empty workspace with one worktree.
func Create(name string) error {
	if err := ValidateName("workspace", name); err != nil {
		return err
	}
	if _, err := os.Stat(config.WorkspaceFile(name)); err == nil {
		return fmt.Errorf("workspace '%s' already exists", name)
	}

	ref := Ref{Workspace: name, Worktree: DefaultWorktree}
	if err := os.MkdirAll(WorktreeDir(ref), 0o755); err != nil {
		return err
	}
	ws := &Workspace{
		Name:      name,
		Projects:  []WorkspaceProject{},
		Worktrees: []Worktree{{Name: DefaultWorktree}},
	}
	return Save(ws)
}

// detectDefaultBranch returns the best base branch for a project repo.
// Tries develop, main, then falls back to HEAD.
func detectDefaultBranch(projectPath string) string {
	for _, branch := range []string{"develop", "main"} {
		out, err := exec.RunGitCommand(projectPath, "rev-parse", "--verify", branch)
		if err == nil && strings.TrimSpace(out) != "" {
			return branch
		}
	}
	return "HEAD"
}

// ProjectSpec is one project to add: name, role, and worktree or direct.
type ProjectSpec struct {
	Name string
	Role string
	Mode string
}

// AddProject adds one project to a workspace; AddProjects with one spec.
func AddProject(wsName, projName, role, mode string, opts CheckoutOptions) error {
	results, err := AddProjects(wsName, []ProjectSpec{{Name: projName, Role: role, Mode: mode}}, opts)
	if err != nil {
		return err
	}
	for _, r := range results {
		if len(r.Issues) > 0 {
			return errors.New(r.Issues[0].Summary() + ": " + firstLine(r.Issues[0].Detail))
		}
	}
	return nil
}

// RefIssues is what went wrong in one worktree, in worktree order — the
// caller's hint has to name the worktree, not the workspace.
type RefIssues struct {
	Ref    Ref
	Issues []Issue
}

// AddProjects adds several projects to a workspace in one pass. Every spec
// is checked before anything happens — a bad name fails the whole call
// with nothing done. Then, per worktree: the checkouts, then the installs
// in parallel (the slow part; each project's install is its own), and the
// issues recorded on that worktree's health so crew fix and verify apply.
// Every validated project becomes a member, whatever its checkout or
// install did — the same rule as creating a worktree: nothing stops, what
// failed is recorded, and verify finishes a checkout that is missing.
func AddProjects(wsName string, specs []ProjectSpec, opts CheckoutOptions) ([]RefIssues, error) {
	ws, err := Load(wsName)
	if err != nil {
		return nil, err
	}
	if err := validateSpecs(ws, specs); err != nil {
		return nil, err
	}

	// Members first, in memory: the checkout and install primitives work
	// over a workspace's members.
	var names []string
	for _, spec := range specs {
		ws.Projects = append(ws.Projects, WorkspaceProject{Name: spec.Name, Role: spec.Role, Mode: persistedMode(spec.Mode)})
		if spec.Mode != ModeDirect {
			names = append(names, spec.Name)
		}
	}

	var results []RefIssues
	for _, ref := range Refs(ws) {
		made, issues := checkoutProjects(ref, ws, names, opts.Progress)
		issues = append(issues, installProjects(ref, ws, made, opts)...)
		results = append(results, RefIssues{Ref: ref, Issues: issues})
	}

	if err := Save(ws); err != nil {
		return nil, err
	}
	// The smoke needs the members saved (it resolves the worktree), and the
	// health goes after the save too: recordMerged loads and saves the
	// workspace itself, and a save of this older copy would undo it.
	for i := range results {
		r := &results[i]
		if r.Ref.Worktree == "" {
			continue // pre-2.0 flat workspace: nothing to smoke or record on
		}
		// A smoke restarts the worktree's servers; one that is running keeps
		// running — crew dev restart is one keystroke away, a kill is not.
		// Said out loud, or the run reads as if there were no smoke stage.
		if opts.Smoke {
			if dev.Running(r.Ref.Slug()) {
				if opts.Progress != nil {
					opts.Progress(r.Ref.String(), exec.SetupResult{Step: exec.SetupStep{Name: "smoke skipped"}, Err: errors.New("servers running — crew dev restart to see the new ones")})
				}
			} else {
				_, smoked, err := smokeStage(r.Ref, opts)
				if err != nil {
					return nil, err
				}
				r.Issues = append(r.Issues, smoked...)
			}
		}
		if len(r.Issues) > 0 {
			if err := recordMerged(r.Ref, names, r.Issues); err != nil {
				return nil, err
			}
		}
	}
	return results, nil
}

// validateSpecs is every pre-flight check, before a single side effect:
// pool membership, duplicates (in the workspace and within the call),
// direct-mode rules.
func validateSpecs(ws *Workspace, specs []ProjectSpec) error {
	if len(specs) == 0 {
		return errors.New("no projects given")
	}
	pool, err := project.List()
	if err != nil {
		return err
	}
	byName := make(map[string]project.Project, len(pool))
	for _, p := range pool {
		byName[p.Name] = p
	}
	seen := map[string]bool{}
	for _, existing := range ws.Projects {
		seen[existing.Name] = true
	}
	for _, spec := range specs {
		mode := spec.Mode
		if mode == "" {
			mode = ModeWorktree
		}
		if mode != ModeWorktree && mode != ModeDirect {
			return fmt.Errorf("invalid mode '%s' (expected 'worktree' or 'direct')", mode)
		}
		p, ok := byName[spec.Name]
		if !ok {
			return fmt.Errorf("project '%s' not found in pool", spec.Name)
		}
		if seen[spec.Name] {
			return fmt.Errorf("project '%s' already in workspace", spec.Name)
		}
		seen[spec.Name] = true
		if mode == ModeDirect {
			if err := assertNoOtherDirect(spec.Name, ws.Name); err != nil {
				return err
			}
			if err := assertDirectFitsWorktrees(ws, spec.Name); err != nil {
				return err
			}
			if err := assertGitRepo(p.Path); err != nil {
				return fmt.Errorf("project '%s' cannot be used in direct mode: %w", spec.Name, err)
			}
		}
	}
	return nil
}

// persistedMode keeps JSON tidy: empty means the default, worktree.
func persistedMode(mode string) string {
	if mode == ModeWorktree {
		return ""
	}
	return mode
}

// recordMerged writes fresh issues for the named projects onto a worktree,
// keeping whatever was recorded about its other projects.
func recordMerged(ref Ref, projects []string, fresh []Issue) error {
	ws, err := Load(ref.Workspace)
	if err != nil {
		return err
	}
	wt, err := selectWorktree(ws, ref.Worktree)
	if err != nil {
		return err
	}
	mine := map[string]bool{}
	for _, p := range projects {
		mine[p] = true
	}
	var kept []Issue
	if wt.Health != nil {
		for _, i := range wt.Health.Issues {
			if !mine[i.Project] {
				kept = append(kept, i)
			}
		}
	}
	return RecordHealth(ref, &Health{At: time.Now(), Issues: append(kept, fresh...)})
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// RemoveProject removes a project from a workspace. For worktree-mode projects
// the git worktree is destroyed; for direct-mode projects only the workspace
// entry is removed — the canonical project repo is left untouched.
func RemoveProject(wsName, projName string) error {
	ws, err := Load(wsName)
	if err != nil {
		return err
	}

	for _, wp := range ws.Projects {
		if wp.Name == projName {
			for _, ref := range Refs(ws) {
				cleanupWorktree(ref, wp)
			}
			break
		}
	}

	var filtered []WorkspaceProject
	for _, wp := range ws.Projects {
		if wp.Name != projName {
			filtered = append(filtered, wp)
		}
	}
	ws.Projects = filtered
	// What was recorded about it goes with it: a fix prompt must not
	// describe a project that is no longer here.
	for i := range ws.Worktrees {
		ws.Worktrees[i].Health = ws.Worktrees[i].Health.without(projName)
	}
	return Save(ws)
}

// Remove fully removes a workspace: stops dev servers, removes git worktrees
// for worktree-mode entries (direct-mode entries are left alone), deletes the
// workspace directory and JSON.
func Remove(name string) error {
	os.Remove(legacyNoTeamsPromptFilePath(name))

	ws, err := Load(name)
	if err == nil {
		// Every worktree has its own dev session, route file, log directory,
		// prompt and .code-workspace — tearing down only the workspace name
		// would leave each of those orphaned per worktree.
		for _, ref := range Refs(ws) {
			removeWorktreeArtifacts(ref)
			for _, wp := range ws.Projects {
				cleanupWorktree(ref, wp)
			}
		}
	} else {
		removeWorktreeArtifacts(Ref{Workspace: name})
	}
	dev.StopProxyIfIdle()

	// Direct-mode projects' canonical paths live elsewhere, so trashing the
	// workspace dir cannot reach them — it clears the worktree shells and
	// whatever loose files were left in them.
	if _, err := trash.Put(WorkspaceDir(name)); err != nil {
		debug.Log("trash", "%s: %v", WorkspaceDir(name), err)
	}
	trash.Sweep()
	os.Remove(config.WorkspaceFile(name))
	return nil
}

// cleanupWorktree is the single place destructive worktree teardown happens.
// No-ops for direct-mode entries. The checkout is moved to the trash rather
// than deleted — a full build inside can be 100+ GB — and git is told to
// forget it; trash.Put refuses anything outside the workspaces tree.
func cleanupWorktree(ref Ref, wp WorkspaceProject) {
	if IsDirect(wp) {
		return
	}
	wtDir := WorktreePath(ref, wp.Name)

	// Never the canonical project repo itself, however the pool is set up.
	p := project.Get(wp.Name)
	if p != nil {
		pAbs, _ := filepath.Abs(p.Path)
		abs, _ := filepath.Abs(wtDir)
		if pAbs == abs {
			return
		}
	}
	if _, err := trash.Put(wtDir); err != nil {
		debug.Log("trash", "%s: %v", wtDir, err)
		return
	}
	if p != nil {
		exec.PruneWorktrees(p.Path)
	}
}
