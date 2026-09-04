package workspace

import (
	"fmt"
	"os"
	"strings"

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

// Refs lists every worktree of a workspace as a Ref. A workspace with no
// worktrees yields the single flat pre-nesting ref.
func Refs(ws *Workspace) []Ref {
	if len(ws.Worktrees) == 0 {
		return []Ref{{Workspace: ws.Name}}
	}
	refs := make([]Ref, 0, len(ws.Worktrees))
	for _, wt := range ws.Worktrees {
		refs = append(refs, Ref{Workspace: ws.Name, Worktree: wt.Name})
	}
	return refs
}

// CheckoutOptions controls what happens after a project is checked out.
type CheckoutOptions struct {
	// Install runs the project's setup steps (mise, the lockfile's package
	// manager, or the explicit setup command). Off skips them entirely.
	Install bool
	// Progress is told about each step as it finishes; nil is fine.
	Progress func(project string, r exec.SetupResult)
}

// createProjectWorktree checks a project out into one worktree: a git
// worktree on its own branch with .env files copied in (gitignored, so git
// would not bring them). Installing is a separate step — see setupProject —
// so a failed install never leaves a half-made worktree.
func createProjectWorktree(ref Ref, p project.Project) error {
	wtDir := WorktreePath(ref, p.Name)
	baseBranch := detectDefaultBranch(p.Path)

	if err := exec.CreateGitWorktree(p.Path, wtDir, BranchName(ref, p.Name), baseBranch); err != nil {
		return fmt.Errorf("failed to create worktree for %s in %s: %w", p.Name, ref, err)
	}
	exec.CopyEnvFiles(envSource(ref, p), wtDir)
	return nil
}

// envSource is where a new checkout's .env files come from: the canonical
// repo when it has any, otherwise a sibling worktree of the same workspace.
// The canonical repo often has none — the real .env was only ever written
// inside a checkout — and a worktree without one cannot start.
func envSource(ref Ref, p project.Project) string {
	if exec.HasEnvFiles(p.Path) {
		return p.Path
	}
	ws, err := Load(ref.Workspace)
	if err != nil {
		return p.Path
	}
	for _, sibling := range Refs(ws) {
		if sibling.Worktree == ref.Worktree {
			continue
		}
		if dir := WorktreePath(sibling, p.Name); exec.HasEnvFiles(dir) {
			return dir
		}
	}
	return p.Path
}

// setupProject runs one checkout's install steps.
func setupProject(ref Ref, p project.Project, opts CheckoutOptions) error {
	if !opts.Install {
		return nil
	}
	wtDir := WorktreePath(ref, p.Name)
	report := func(r exec.SetupResult) {
		if opts.Progress != nil {
			opts.Progress(p.Name, r)
		}
	}
	if err := exec.RunSetup(wtDir, exec.SetupSteps(wtDir, p.Setup), report); err != nil {
		return fmt.Errorf("%s: %w", p.Name, err)
	}
	return nil
}

// SetupError is one or more projects whose install failed. The worktree
// itself exists and is recorded; Setup re-runs the installs.
type SetupError struct {
	Ref    Ref
	Errors []error
}

func (e *SetupError) Error() string {
	msgs := make([]string, 0, len(e.Errors))
	for _, err := range e.Errors {
		msgs = append(msgs, err.Error())
	}
	return fmt.Sprintf("%d project(s) failed to set up in %s:\n  %s", len(e.Errors), e.Ref, strings.Join(msgs, "\n  "))
}

// Setup re-runs every project's install steps in a worktree. Idempotent, so
// it is the fix for an install that failed the first time.
func Setup(ref Ref, opts CheckoutOptions) error {
	ws, err := Load(ref.Workspace)
	if err != nil {
		return err
	}
	return setupAll(ref, ws, opts)
}

func setupAll(ref Ref, ws *Workspace, opts CheckoutOptions) error {
	var failed []error
	for _, wp := range ws.Projects {
		if IsDirect(wp) {
			continue
		}
		p := project.Get(wp.Name)
		if p == nil {
			continue
		}
		if err := setupProject(ref, *p, opts); err != nil {
			failed = append(failed, err)
		}
	}
	if len(failed) > 0 {
		return &SetupError{Ref: ref, Errors: failed}
	}
	return nil
}

// SetupStepsFor previews what a checkout of p would run, for output that
// shows the plan before doing it.
func SetupStepsFor(p project.Project) []exec.SetupStep {
	return exec.SetupSteps(p.Path, p.Setup)
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
func AddWorktree(wsName, name string, opts CheckoutOptions) error {
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

	// Checkouts are all-or-nothing: a failure here rolls back what was
	// made, so a retry starts clean instead of colliding with a half-made
	// worktree. Installs come after the worktree is recorded, and a failed
	// install keeps the ones that succeeded.
	var made []WorkspaceProject
	for _, wp := range ws.Projects {
		p := project.Get(wp.Name)
		if p == nil {
			rollbackWorktree(ref, made)
			return fmt.Errorf("project '%s' not found in pool", wp.Name)
		}
		if err := createProjectWorktree(ref, *p); err != nil {
			rollbackWorktree(ref, made)
			return err
		}
		made = append(made, wp)
	}

	ws.Worktrees = append(ws.Worktrees, Worktree{Name: name})
	if err := Save(ws); err != nil {
		return err
	}
	return setupAll(ref, ws, opts)
}

func rollbackWorktree(ref Ref, made []WorkspaceProject) {
	for _, wp := range made {
		cleanupWorktree(ref, wp)
	}
	os.RemoveAll(WorktreeDir(ref))
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

	// The disk work above can take a minute on a large checkout, and another
	// removal may have saved the workspace meanwhile. Drop this entry from
	// the file as it is now, not from the snapshot taken before.
	return dropWorktreeRecord(wsName, name)
}

func dropWorktreeRecord(wsName, name string) error {
	ws, err := Load(wsName)
	if err != nil {
		return err
	}
	remaining := ws.Worktrees[:0:0]
	for _, wt := range ws.Worktrees {
		if wt.Name != name {
			remaining = append(remaining, wt)
		}
	}
	ws.Worktrees = remaining
	return Save(ws)
}

// DuplicateWorktree creates a new worktree in the same workspace, carrying the
// source worktree's overrides across.
func DuplicateWorktree(ref Ref, newName string, opts CheckoutOptions) error {
	ws, err := Load(ref.Workspace)
	if err != nil {
		return err
	}
	src, err := selectWorktree(ws, ref.Worktree)
	if err != nil {
		return err
	}

	if err := AddWorktree(ref.Workspace, newName, opts); err != nil {
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
			// Ports are deliberately not copied: two worktrees on the same
			// ports is the collision this whole model exists to prevent.
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

// SavePorts records the ports a worktree's servers were bound to, so the next
// start reuses them. A pre-worktree workspace has nowhere to keep them and is
// left alone.
func SavePorts(ref Ref, ports map[string]int) error {
	if ref.Worktree == "" || len(ports) == 0 {
		return nil
	}
	ws, err := Load(ref.Workspace)
	if err != nil {
		return err
	}
	for i := range ws.Worktrees {
		if ws.Worktrees[i].Name == ref.Worktree {
			ws.Worktrees[i].Ports = ports
			return Save(ws)
		}
	}
	return fmt.Errorf("workspace '%s' has no worktree '%s'", ref.Workspace, ref.Worktree)
}
