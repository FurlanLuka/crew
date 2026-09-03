package workspace

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// wrkSuffix reads the -wrkN convention that predates real worktrees: workspaces
// were duplicated per working copy and named for it.
var wrkSuffix = regexp.MustCompile(`^(.+)-(wrk\d+)$`)

// MigrationMove is one old workspace becoming one worktree of a new one.
type MigrationMove struct {
	OldWorkspace string
	Ref          Ref
	Projects     []WorkspaceProject
}

// MigrationPlan is the whole migration, decided before anything is touched.
type MigrationPlan struct {
	Moves     []MigrationMove
	Merges    map[string][]string // new workspace → old workspaces folded into it
	Conflicts []string
}

// SplitWorkspaceName maps an old workspace name to its workspace and worktree.
// Pure.
//
//	phone-speak-wrk1 → phone-speak / wrk1
//	mumbo            → mumbo       / main
func SplitWorkspaceName(name string) (workspace, worktree string) {
	if m := wrkSuffix.FindStringSubmatch(name); m != nil {
		return m[1], m[2]
	}
	return name, DefaultWorktree
}

// PlanMigration decides the whole migration without touching anything.
func PlanMigration() (*MigrationPlan, error) {
	names, err := List()
	if err != nil {
		return nil, err
	}
	sort.Strings(names)

	var workspaces []*Workspace
	for _, name := range names {
		if ws, err := Load(name); err == nil {
			workspaces = append(workspaces, ws)
		}
	}
	return planFrom(workspaces), nil
}

// planFrom is the pure core: maps names by convention, groups by target
// workspace, unions projects, and finds every merge the direct-mode pin
// forbids.
func planFrom(workspaces []*Workspace) *MigrationPlan {
	plan := &MigrationPlan{Merges: map[string][]string{}}
	projectsByWorkspace := map[string][]WorkspaceProject{}
	directOwner := map[string]string{}

	for _, ws := range workspaces {
		if len(ws.Worktrees) > 0 {
			continue // already migrated
		}

		wsName, wtName := SplitWorkspaceName(ws.Name)
		plan.Moves = append(plan.Moves, MigrationMove{
			OldWorkspace: ws.Name,
			Ref:          Ref{Workspace: wsName, Worktree: wtName},
			Projects:     ws.Projects,
		})
		plan.Merges[wsName] = append(plan.Merges[wsName], ws.Name)

		for _, wp := range ws.Projects {
			for _, e := range projectsByWorkspace[wsName] {
				// A project held direct in one old workspace and as a worktree
				// in another cannot merge: the result would be a direct project
				// alongside several worktrees, which the pin forbids.
				if e.Name == wp.Name && IsDirect(e) != IsDirect(wp) {
					plan.Conflicts = append(plan.Conflicts, fmt.Sprintf(
						"'%s' is direct in one of %s and a worktree in another — resolve by hand before migrating",
						wp.Name, strings.Join(plan.Merges[wsName], ", ")))
				}
			}
			projectsByWorkspace[wsName] = unionProjects(projectsByWorkspace[wsName], []WorkspaceProject{wp})

			if IsDirect(wp) {
				if owner, ok := directOwner[wsName]; ok && owner != wp.Name {
					plan.Conflicts = append(plan.Conflicts, fmt.Sprintf(
						"workspace '%s' would hold two direct projects across its worktrees (%s, %s) — a direct project pins a workspace to one worktree",
						wsName, owner, wp.Name))
				}
				directOwner[wsName] = wp.Name
			}
		}
	}

	for wsName, olds := range plan.Merges {
		if _, hasDirect := directOwner[wsName]; hasDirect && len(olds) > 1 {
			plan.Conflicts = append(plan.Conflicts, fmt.Sprintf(
				"workspace '%s' would have %d worktrees but holds a direct project — a direct project has one canonical checkout the worktrees would share",
				wsName, len(olds)))
		}
	}

	sort.Strings(plan.Conflicts)
	plan.Conflicts = dedupe(plan.Conflicts)
	return plan
}

// relWorkspaces shortens a path under WorkspacesDir for display.
func relWorkspaces(path string) string {
	if rel, err := filepath.Rel(config.WorkspacesDir, path); err == nil {
		return rel
	}
	return path
}

func dedupe(in []string) []string {
	var out []string
	for i, s := range in {
		if i == 0 || s != in[i-1] {
			out = append(out, s)
		}
	}
	return out
}

// FormatPlan renders the migration for review before it runs.
func FormatPlan(plan *MigrationPlan) string {
	if len(plan.Moves) == 0 {
		return "Nothing to migrate — every workspace already has worktrees.\n"
	}

	var b strings.Builder
	b.WriteString("Workspaces\n\n")
	for _, m := range plan.Moves {
		fmt.Fprintf(&b, "  %-22s → %s\n", m.OldWorkspace, m.Ref)
	}

	fmt.Fprintf(&b, "\nPaths — under %s\n\n", config.WorkspacesDir)
	for _, m := range plan.Moves {
		for _, wp := range m.Projects {
			if IsDirect(wp) {
				fmt.Fprintf(&b, "  %-46s (direct — not moved)\n", filepath.Join(m.OldWorkspace, wp.Name))
				continue
			}
			fmt.Fprintf(&b, "  %-46s → %s\n",
				relWorkspaces(WorktreePath(Ref{Workspace: m.OldWorkspace}, wp.Name)),
				relWorkspaces(WorktreePath(m.Ref, wp.Name)))
		}
	}

	b.WriteString("\nBranches\n\n")
	for _, m := range plan.Moves {
		for _, wp := range m.Projects {
			if IsDirect(wp) {
				continue
			}
			fmt.Fprintf(&b, "  %-46s → %s\n",
				BranchName(Ref{Workspace: m.OldWorkspace}, wp.Name),
				BranchName(m.Ref, wp.Name))
		}
	}

	if len(plan.Conflicts) > 0 {
		b.WriteString("\nConflicts — these must be resolved first\n\n")
		for _, c := range plan.Conflicts {
			fmt.Fprintf(&b, "  ! %s\n", c)
		}
	}
	return b.String()
}

// BackupDir is where ApplyMigration copies state before touching anything.
func BackupDir(now time.Time) string {
	return filepath.Join(config.ConfigDir, "backup-"+now.Format("20060102-150405"))
}

// ApplyMigration performs the plan. Destructive: it moves git worktrees and
// rewrites workspace state.
//
// Order matters in two places that are easy to get backwards. Route files are
// captured before dev servers are stopped, because StopAll deletes them. And
// each move creates only the destination's parent, never the leaf: `git
// worktree move` onto an existing directory nests inside it and exits 0, which
// on a one-shot migration is worse than failing.
func ApplyMigration(plan *MigrationPlan, backup string) error {
	if len(plan.Conflicts) > 0 {
		return fmt.Errorf("plan has %d unresolved conflicts", len(plan.Conflicts))
	}

	if err := backupState(backup); err != nil {
		return fmt.Errorf("backup: %w", err)
	}

	for _, m := range plan.Moves {
		dev.StopAll(dev.Slug(m.OldWorkspace))
	}
	dev.StopProxyIfIdle()

	merged := map[string]*Workspace{}
	for _, m := range plan.Moves {
		if err := moveWorktree(m); err != nil {
			return err
		}

		ws, ok := merged[m.Ref.Workspace]
		if !ok {
			ws = &Workspace{Name: m.Ref.Workspace}
			merged[m.Ref.Workspace] = ws
		}
		ws.Worktrees = append(ws.Worktrees, Worktree{Name: m.Ref.Worktree})
		ws.Projects = unionProjects(ws.Projects, m.Projects)
	}

	// Old JSONs are deleted only after every move has succeeded, so a failure
	// part-way leaves the previous state loadable.
	for _, m := range plan.Moves {
		if m.OldWorkspace != m.Ref.Workspace {
			os.Remove(config.WorkspaceFile(m.OldWorkspace))
		}
		removeWorktreeArtifacts(Ref{Workspace: m.OldWorkspace})
		os.Remove(legacyNoTeamsPromptFilePath(m.OldWorkspace))
	}

	for _, ws := range merged {
		if err := Save(ws); err != nil {
			return err
		}
		for _, ref := range Refs(ws) {
			if res, err := Resolve(ref); err == nil && NeedsPrompt(res) {
				GeneratePrompt(res)
			}
		}
	}
	return nil
}

// unionProjects merges project lists by name; the first role seen wins.
func unionProjects(into, from []WorkspaceProject) []WorkspaceProject {
	for _, wp := range from {
		seen := false
		for _, e := range into {
			if e.Name == wp.Name {
				seen = true
				break
			}
		}
		if !seen {
			into = append(into, wp)
		}
	}
	return into
}

// moveWorktree relocates every checkout of one old workspace and renames its
// branches.
func moveWorktree(m MigrationMove) error {
	if m.OldWorkspace == m.Ref.Workspace && m.Ref.Worktree == "" {
		return nil
	}

	if err := os.MkdirAll(WorktreeDir(m.Ref), 0o755); err != nil {
		return err
	}

	for _, wp := range m.Projects {
		if IsDirect(wp) {
			continue
		}

		p := project.Get(wp.Name)
		if p == nil {
			continue
		}

		oldPath := WorktreePath(Ref{Workspace: m.OldWorkspace}, wp.Name)
		newPath := WorktreePath(m.Ref, wp.Name)
		if oldPath == newPath {
			continue
		}
		if _, err := os.Stat(oldPath); err != nil {
			continue // nothing checked out there
		}
		if _, err := os.Stat(newPath); err == nil {
			return fmt.Errorf("refusing to move %s: %s already exists", wp.Name, newPath)
		}

		if err := exec.MoveGitWorktree(p.Path, oldPath, newPath); err != nil {
			return fmt.Errorf("moving %s: %w", wp.Name, err)
		}
		exec.RenameGitBranch(newPath,
			BranchName(Ref{Workspace: m.OldWorkspace}, wp.Name),
			BranchName(m.Ref, wp.Name))
	}

	// The old workspace directory is left only if it is now empty.
	os.Remove(WorktreeDir(Ref{Workspace: m.OldWorkspace}))
	return nil
}

// backupState copies workspace JSONs and route files aside. Migration moves
// real repositories, so there has to be something to read afterwards.
func backupState(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	patterns := []string{
		filepath.Join(config.WorkspacesDir, "*.json"),
		filepath.Join(config.ConfigDir, "dev-routes-*.json"),
	}
	for _, pattern := range patterns {
		matches, _ := filepath.Glob(pattern)
		for _, src := range matches {
			data, err := os.ReadFile(src)
			if err != nil {
				continue
			}
			if err := os.WriteFile(filepath.Join(dir, filepath.Base(src)), data, 0o644); err != nil {
				return err
			}
		}
	}

	pool, err := os.ReadFile(filepath.Join(config.ConfigDir, "projects.json"))
	if err == nil {
		os.WriteFile(filepath.Join(dir, "projects.json"), pool, 0o644)
	}
	return nil
}

// MigratedPaths lists old → new checkout paths, for printing after a migration:
// anything holding an old path (agent memory, CLAUDE.md, shell aliases) breaks
// and has to be fixed by hand.
func MigratedPaths(plan *MigrationPlan) [][2]string {
	var pairs [][2]string
	for _, m := range plan.Moves {
		for _, wp := range m.Projects {
			if IsDirect(wp) {
				continue
			}
			old := WorktreePath(Ref{Workspace: m.OldWorkspace}, wp.Name)
			now := WorktreePath(m.Ref, wp.Name)
			if old != now {
				pairs = append(pairs, [2]string{old, now})
			}
		}
	}
	return pairs
}
