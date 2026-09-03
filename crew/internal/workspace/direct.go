package workspace

import (
	"fmt"
	"os"

	"github.com/FurlanLuka/crew/crew/internal/exec"
)

// assertNoOtherDirect returns an error if any workspace other than excludeWs
// already has a direct-mode entry pointing at projName. Two workspaces sharing
// the same canonical checkout would clobber each other's branch state.
func assertNoOtherDirect(projName, excludeWs string) error {
	names, err := List()
	if err != nil {
		return nil
	}
	for _, name := range names {
		if name == excludeWs {
			continue
		}
		ws, err := Load(name)
		if err != nil {
			continue
		}
		for _, wp := range ws.Projects {
			if wp.Name == projName && IsDirect(wp) {
				return fmt.Errorf("project '%s' is already attached to workspace '%s' in direct mode — only one workspace at a time can use a project directly", projName, name)
			}
		}
	}
	return nil
}

// AssertDirectProjectsAvailable runs the direct-mode collision check across
// every direct-mode project in res. Call this before starting dev servers,
// launching editors, or doing any other work that assumes the canonical repo
// is bound to ws and not somewhere else.
func AssertDirectProjectsAvailable(res *Resolved) error {
	for _, p := range res.Projects {
		if !p.Direct {
			continue
		}
		if err := assertNoOtherDirect(p.Name, res.Ref.Workspace); err != nil {
			return err
		}
	}
	return nil
}

// assertGitRepo verifies that path is a git repository with a HEAD ref. Used
// when adding a project in direct mode — the agent prompt and dev workflows
// assume a real repo there.
func assertGitRepo(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("path %s: %w", path, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("path %s is not a directory", path)
	}
	if _, err := exec.RunGitCommand(path, "rev-parse", "--git-dir"); err != nil {
		return fmt.Errorf("path %s is not a git repository", path)
	}
	if _, err := exec.RunGitCommand(path, "rev-parse", "HEAD"); err != nil {
		return fmt.Errorf("repository at %s has no commits (HEAD is unborn)", path)
	}
	return nil
}

// assertDirectFitsWorktrees refuses a direct-mode project in a workspace that
// already has more than one worktree.
//
// The pin is enforced in both directions: AddWorktree refuses when a direct
// project is present, and this refuses when worktrees already exist. Guarding
// only one lets you reach the forbidden state by doing it in the other order.
func assertDirectFitsWorktrees(ws *Workspace, projName string) error {
	if len(ws.Worktrees) > 1 {
		return fmt.Errorf("workspace '%s' has %d worktrees, so '%s' cannot be added in direct mode — a direct project has one canonical checkout that the worktrees would share",
			ws.Name, len(ws.Worktrees), projName)
	}
	return nil
}
