package workspace

import (
	"fmt"
	"os"

	"github.com/FurlanLuka/crew/crew/internal/exec"
)

// directOwners maps each project some workspace holds in direct mode to
// that workspace — one sweep of the workspace files.
func directOwners() map[string]string {
	owners := map[string]string{}
	names, err := List()
	if err != nil {
		return owners
	}
	for _, name := range names {
		ws, err := Load(name)
		if err != nil {
			continue
		}
		for _, wp := range ws.Projects {
			if IsDirect(wp) {
				owners[wp.Name] = name
			}
		}
	}
	return owners
}

// assertNoOtherDirect returns an error if any workspace other than excludeWs
// already has a direct-mode entry pointing at projName. Two workspaces sharing
// the same canonical checkout would clobber each other's branch state.
func assertNoOtherDirect(projName, excludeWs string) error {
	return directRefusalOwner(projName, excludeWs, directOwners())
}

func directRefusalOwner(projName, excludeWs string, owners map[string]string) error {
	if owner, ok := owners[projName]; ok && owner != excludeWs {
		return fmt.Errorf("project '%s' is already attached to workspace '%s' in direct mode — only one workspace at a time can use a project directly", projName, owner)
	}
	return nil
}

// directRefusal is why a project could not join wsName in direct mode —
// "" when it can: one reading of the three rules (another workspace holds
// it directly, the workspace has more than one worktree, the path is not a
// git repo with commits), read by validateSpecs. Pure.
func directRefusal(projName, wsName string, owners map[string]string, worktrees int, repoErr error) string {
	if err := directRefusalOwner(projName, wsName, owners); err != nil {
		return err.Error()
	}
	if err := directFitsWorktrees(wsName, worktrees, projName); err != nil {
		return err.Error()
	}
	if repoErr != nil {
		return fmt.Sprintf("project '%s' cannot be used in direct mode: %v", projName, repoErr)
	}
	return ""
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

// directFitsWorktrees refuses a direct-mode project in a workspace that
// already has more than one worktree.
//
// The pin is enforced in both directions: AddWorktree refuses when a direct
// project is present, and this refuses when worktrees already exist. Guarding
// only one lets you reach the forbidden state by doing it in the other order.
func directFitsWorktrees(wsName string, worktrees int, projName string) error {
	if worktrees > 1 {
		return fmt.Errorf("workspace '%s' has %d worktrees, so '%s' cannot be added in direct mode — a direct project has one canonical checkout that the worktrees would share",
			wsName, worktrees, projName)
	}
	return nil
}
