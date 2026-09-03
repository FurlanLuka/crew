package workspace

import (
	"fmt"
	"os"

	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// BranchName is the branch a project's checkout gets in one worktree.
//
// The worktree is part of the name because git refuses to check the same branch
// out twice: without it, adding a second worktree to a workspace would try to
// recreate a branch that already exists, and both `git worktree add -b` and the
// reuse fallback fail on that.
func BranchName(ref Ref, projName string) string {
	if ref.Worktree == "" {
		return "crew/" + ref.Workspace + "/" + projName
	}
	return "crew/" + ref.Workspace + "/" + ref.Worktree + "/" + projName
}

// workspaceRefs lists every worktree of a workspace as a Ref. A workspace with
// no worktrees yields the single flat pre-nesting ref.
func workspaceRefs(ws *Workspace) []Ref {
	if len(ws.Worktrees) == 0 {
		return []Ref{{Workspace: ws.Name}}
	}
	refs := make([]Ref, 0, len(ws.Worktrees))
	for _, wt := range ws.Worktrees {
		refs = append(refs, Ref{Workspace: ws.Name, Worktree: wt.Name})
	}
	return refs
}

// Refs is the exported form of workspaceRefs, for callers listing a
// workspace's worktrees.
func Refs(ws *Workspace) []Ref { return workspaceRefs(ws) }

// createProjectWorktree checks a project out into one worktree.
func createProjectWorktree(ref Ref, p project.Project) error {
	wtDir := WorktreePath(ref, p.Name)
	baseBranch := detectDefaultBranch(p.Path)

	if err := exec.CreateGitWorktree(p.Path, wtDir, BranchName(ref, p.Name), baseBranch); err != nil {
		return fmt.Errorf("failed to create worktree for %s in %s: %w", p.Name, ref, err)
	}
	exec.CopyEnvFiles(p.Path, wtDir)
	exec.RunNpmInstall(wtDir)
	return nil
}

// removeWorktreeArtifacts deletes everything crew keys by one worktree's slug:
// its dev session and routes, logs, prompt and editor workspace file.
func removeWorktreeArtifacts(ref Ref) {
	dev.StopAll(ref.Slug())
	os.RemoveAll(dev.LogDir(ref.Slug()))
	os.Remove(PromptFilePath(ref))
	os.Remove(CodeWorkspaceFilePath(ref))
}

// AddWorktree adds a worktree to a workspace and checks every project out into
// it.
func AddWorktree(wsName, name string) error {
	if err := ValidateName("worktree", name); err != nil {
		return err
	}

	ws, err := Load(wsName)
	if err != nil {
		return err
	}
	if len(ws.Worktrees) == 0 {
		return fmt.Errorf("workspace '%s' predates worktrees — run `crew migrate` first", wsName)
	}
	for _, wt := range ws.Worktrees {
		if wt.Name == name {
			return fmt.Errorf("workspace '%s' already has a worktree '%s'", wsName, name)
		}
	}

	// A direct-mode project points at the one canonical checkout, so a second
	// worktree would have both sharing it — the same clobbering that
	// assertNoOtherDirect prevents between workspaces.
	for _, wp := range ws.Projects {
		if IsDirect(wp) {
			return fmt.Errorf("workspace '%s' holds '%s' in direct mode, so it can only have one worktree — remove it or re-add it as a worktree project first",
				wsName, wp.Name)
		}
	}

	ref := Ref{Workspace: wsName, Worktree: name}
	if err := os.MkdirAll(WorktreeDir(ref), 0o755); err != nil {
		return err
	}

	for _, wp := range ws.Projects {
		p := project.Get(wp.Name)
		if p == nil {
			return fmt.Errorf("project '%s' not found in pool", wp.Name)
		}
		if err := createProjectWorktree(ref, *p); err != nil {
			return err
		}
	}

	ws.Worktrees = append(ws.Worktrees, Worktree{Name: name})
	return Save(ws)
}

// RemoveWorktree destroys a worktree's checkouts and forgets it.
func RemoveWorktree(wsName, name string) error {
	ws, err := Load(wsName)
	if err != nil {
		return err
	}

	found := false
	remaining := make([]Worktree, 0, len(ws.Worktrees))
	for _, wt := range ws.Worktrees {
		if wt.Name == name {
			found = true
			continue
		}
		remaining = append(remaining, wt)
	}
	if !found {
		return fmt.Errorf("workspace '%s' has no worktree '%s'", wsName, name)
	}
	if len(remaining) == 0 {
		return fmt.Errorf("'%s' is the last worktree of '%s' — remove the workspace instead", name, wsName)
	}

	ref := Ref{Workspace: wsName, Worktree: name}
	removeWorktreeArtifacts(ref)
	for _, wp := range ws.Projects {
		cleanupWorktree(ref, wp)
	}
	os.RemoveAll(WorktreeDir(ref))

	ws.Worktrees = remaining
	return Save(ws)
}

// DuplicateWorktree creates a new worktree in the same workspace, carrying the
// source worktree's overrides across.
func DuplicateWorktree(ref Ref, newName string) error {
	ws, err := Load(ref.Workspace)
	if err != nil {
		return err
	}
	src, err := selectWorktree(ws, ref.Worktree)
	if err != nil {
		return err
	}

	if err := AddWorktree(ref.Workspace, newName); err != nil {
		return err
	}
	if len(src.Overrides) == 0 {
		return nil
	}

	ws, err = Load(ref.Workspace)
	if err != nil {
		return err
	}
	for i, wt := range ws.Worktrees {
		if wt.Name == newName {
			ws.Worktrees[i].Overrides = src.Overrides
		}
	}
	return Save(ws)
}

// SetOverride pins a variable for one worktree, or clears it when value is
// empty and clear is true.
func SetOverride(ref Ref, key, value string) error {
	ws, err := Load(ref.Workspace)
	if err != nil {
		return err
	}
	wt, err := selectWorktree(ws, ref.Worktree)
	if err != nil {
		return err
	}

	for i := range ws.Worktrees {
		if ws.Worktrees[i].Name != wt.Name {
			continue
		}
		if ws.Worktrees[i].Overrides == nil {
			ws.Worktrees[i].Overrides = map[string]string{}
		}
		ws.Worktrees[i].Overrides[key] = value
		return Save(ws)
	}
	return fmt.Errorf("workspace '%s' has no worktree '%s'", ref.Workspace, wt.Name)
}

// ClearOverride removes a worktree override.
func ClearOverride(ref Ref, key string) error {
	ws, err := Load(ref.Workspace)
	if err != nil {
		return err
	}
	wt, err := selectWorktree(ws, ref.Worktree)
	if err != nil {
		return err
	}

	for i := range ws.Worktrees {
		if ws.Worktrees[i].Name == wt.Name {
			delete(ws.Worktrees[i].Overrides, key)
			return Save(ws)
		}
	}
	return nil
}
