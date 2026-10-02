package workspace

import (
	"fmt"
	"os"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/dirsize"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// Nothing is removed without saying what it costs: a removal's dry run is
// each checkout it would take, with the work in it that would go too.

// CheckoutCost is what removing one checkout throws away.
type CheckoutCost struct {
	Ref     string `json:"ref"`
	Project string `json:"project"`
	Path    string `json:"path"`
	// Direct: the canonical checkout — a removal never touches it.
	Direct bool `json:"direct"`
	// Missing: no checkout on disk, nothing to lose.
	Missing bool `json:"missing"`
	// Uncommitted is the files git status lists in the checkout.
	Uncommitted int `json:"uncommitted"`
	// Commits is what the crew branch has that the base does not; the
	// reflog keeps them, nothing else does.
	Commits   int   `json:"commits"`
	SizeBytes int64 `json:"size_bytes"`
}

// RemovalCost is a removal's dry run: the checkouts it takes, and whether
// it is the workspace's last worktree (which goes only with the workspace).
type RemovalCost struct {
	Checkouts []CheckoutCost `json:"checkouts"`
	Last      bool           `json:"last"`
}

// checkoutCost reads one checkout: git twice and a walk of its files.
// poolPath is the project's canonical repo, where its crew branch lives
// ("" when the pool no longer has it).
func checkoutCost(ref Ref, p ResolvedProject, poolPath string) CheckoutCost {
	c := CheckoutCost{Ref: ref.String(), Project: p.Name, Path: p.Path, Direct: p.Direct}
	if p.Direct {
		return c
	}
	if _, err := os.Stat(p.Path); err != nil {
		c.Missing = true
		return c
	}
	c.Uncommitted = uncommittedFiles(p.Path)
	if poolPath != "" {
		c.Commits = commitsNotOnBase(poolPath, ref, p.Name)
	}
	c.SizeBytes = dirsize.Of(p.Path)
	return c
}

// commitsNotOnBase is what the worktree's crew branch has that the repo's
// base does not — what a removal leaves only in the reflog.
func commitsNotOnBase(poolPath string, ref Ref, projName string) int {
	return exec.CommitsAhead(poolPath, DefaultBranch(poolPath), BranchName(ref, projName))
}

// poolPaths is every pool project's canonical path, from one read.
func poolPaths() (map[string]string, error) {
	pool, err := project.List()
	if err != nil {
		return nil, err
	}
	paths := make(map[string]string, len(pool))
	for _, p := range pool {
		paths[p.Name] = p.Path
	}
	return paths, nil
}

func uncommittedFiles(dir string) int {
	out, err := exec.RunGitCommand(dir, "status", "--porcelain")
	if err != nil {
		return 0
	}
	return countLines(out)
}

// countLines counts the non-empty lines of git's porcelain output. Pure.
func countLines(out string) int {
	n := 0
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) != "" {
			n++
		}
	}
	return n
}

// WorktreeRemovalCost is crew rm worktree <ref> --dry-run: every checkout
// of the worktree. A check ref resolves like any other.
func WorktreeRemovalCost(ref Ref) (RemovalCost, error) {
	res, err := Resolve(ref)
	if err != nil {
		return RemovalCost{}, err
	}
	paths, err := poolPaths()
	if err != nil {
		return RemovalCost{}, err
	}
	cost := RemovalCost{Checkouts: []CheckoutCost{}}
	for _, p := range res.Projects {
		cost.Checkouts = append(cost.Checkouts, checkoutCost(res.Ref, p, paths[p.Name]))
	}
	if !IsCheck(ref) {
		if ws, err := Load(ref.Workspace); err == nil {
			cost.Last = len(ws.Worktrees) <= 1
		}
	}
	return cost, nil
}

// ProjectRemovalCost is crew rm workspace <ws> <project> --dry-run: the
// project's checkout in every worktree of the workspace.
func ProjectRemovalCost(wsName, projName string) (RemovalCost, error) {
	ws, err := Load(wsName)
	if err != nil {
		return RemovalCost{}, err
	}
	if _, ok := memberOf(ws, projName); !ok {
		return RemovalCost{}, fmt.Errorf("workspace '%s' has no project '%s'", wsName, projName)
	}
	paths, err := poolPaths()
	if err != nil {
		return RemovalCost{}, err
	}
	cost := RemovalCost{Checkouts: []CheckoutCost{}}
	for _, ref := range Refs(ws) {
		res, err := Resolve(ref)
		if err != nil {
			// A worktree that does not resolve still had a checkout here;
			// the row says there is nothing to read rather than hiding it.
			cost.Checkouts = append(cost.Checkouts, CheckoutCost{Ref: ref.String(), Project: projName, Path: WorktreePath(ref, projName), Missing: true})
			continue
		}
		for _, p := range res.Projects {
			if p.Name == projName {
				cost.Checkouts = append(cost.Checkouts, checkoutCost(res.Ref, p, paths[p.Name]))
			}
		}
	}
	return cost, nil
}
