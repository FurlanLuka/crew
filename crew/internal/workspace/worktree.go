package workspace

import (
	"errors"
	"fmt"
	"os"

	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/trash"
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
	// Smoke starts the servers afterwards, watches each until it listens,
	// dies or the ceiling passes, and stops them: the check that finds a
	// missing var before you do.
	Smoke bool
}

// createProjectWorktree checks a project out into one worktree: a git
// worktree on its own branch with .env files copied in (gitignored, so git
// would not bring them). Installing is a separate step — see setupProject —
// so a failed install never leaves a half-made worktree.
func createProjectWorktree(ref Ref, p project.Project) error {
	wtDir := WorktreePath(ref, p.Name)
	baseBranch := detectDefaultBranch(p.Path)

	if err := exec.CreateGitWorktree(p.Path, wtDir, BranchName(ref, p.Name), baseBranch); err != nil {
		// Leave nothing behind: a directory here would make the next attempt
		// read git's "already exists" as a branch to reuse.
		cleanupWorktree(ref, WorkspaceProject{Name: p.Name})
		return err
	}
	exec.CopyEnvFiles(envSource(ref, p), wtDir)
	// The checkout is fine either way; the install step trusts again and
	// says so if it cannot.
	exec.TrustMise(wtDir)
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

// setupProject runs one checkout's install steps in this process — the
// pre-2.0 flat path; a worktree's installs run in their runner.
func setupProject(ref Ref, p project.Project) error {
	wtDir := WorktreePath(ref, p.Name)
	if err := exec.RunSetup(wtDir, exec.SetupSteps(wtDir, p.Setup), nil, nil); err != nil {
		return &ProjectSetupError{Project: p.Name, Err: err}
	}
	return nil
}

// ProjectSetupError names the project whose install failed, so the failure
// can be recorded against it.
type ProjectSetupError struct {
	Project string
	Err     error
}

func (e *ProjectSetupError) Error() string { return e.Project + ": " + e.Err.Error() }
func (e *ProjectSetupError) Unwrap() error { return e.Err }

// installDetail is the step's output tail when there is one — the terminal
// gets the last few lines, the record keeps enough to read.
func installDetail(err error) string {
	var se *exec.StepError
	if errors.As(err, &se) && se.Output != "" {
		return se.Step + ":\n" + se.Output
	}
	var pe *ProjectSetupError
	if errors.As(err, &pe) {
		return pe.Err.Error()
	}
	return err.Error()
}

func memberOf(ws *Workspace, name string) (WorkspaceProject, bool) {
	for _, wp := range ws.Projects {
		if wp.Name == name {
			return wp, true
		}
	}
	return WorkspaceProject{}, false
}

func memberNames(ws *Workspace) []string {
	names := make([]string, 0, len(ws.Projects))
	for _, wp := range ws.Projects {
		names = append(names, wp.Name)
	}
	return names
}

// Setup re-runs every project's installs (or the named ones'), each in
// its own runner, with the smoke when asked — the same check creation
// runs, installs forced. Returns once the runners are started.
func Setup(ref Ref, opts CheckoutOptions, only []string) error {
	ws, err := Load(ref.Workspace)
	if err != nil {
		return err
	}
	if opts.Smoke && dev.Running(ref.Slug()) {
		return ErrServersRunning
	}
	names, err := chosenMembers(ws, only)
	if err != nil {
		return err
	}
	return StartSetup(ref, jobsFor(names, CheckoutOptions{Install: true, Smoke: opts.Smoke}))
}

// chosenMembers is the members a filter names — every one of them, or all
// of them with no filter. A name that is not a member is an error, not a
// silent no-op.
func chosenMembers(ws *Workspace, only []string) ([]string, error) {
	if len(only) == 0 {
		return memberNames(ws), nil
	}
	for _, n := range only {
		if _, ok := memberOf(ws, n); !ok {
			return nil, fmt.Errorf("project '%s' is not in workspace '%s'", n, ws.Name)
		}
	}
	return only, nil
}

func missingCheckouts(ref Ref, ws *Workspace) map[string]bool {
	missing := map[string]bool{}
	for _, wp := range ws.Projects {
		if !IsDirect(wp) && !dirExists(WorktreePath(ref, wp.Name)) {
			missing[wp.Name] = true
		}
	}
	return missing
}

// SetupStepsFor previews what a checkout of p would run, for output that
// shows the plan before doing it.
func SetupStepsFor(p project.Project) []exec.SetupStep {
	return exec.SetupSteps(p.Path, p.Setup)
}

// removeWorktreeArtifacts deletes everything crew keys by one worktree's slug:
// its setup runners and their files, its dev session and routes, logs,
// prompt and editor workspace file. The runners go first — one still
// installing into a checkout about to be trashed would record health on
// a worktree that no longer exists.
func removeWorktreeArtifacts(ref Ref) {
	removeSetupArtifacts(ref)
	dev.StopAll(ref.Slug())
	os.RemoveAll(dev.LogDir(ref.Slug()))
	os.Remove(PromptFilePath(ref))
	os.Remove(CodeWorkspaceFilePath(ref))
}

// AddWorktree adds a worktree to a workspace and starts one runner per
// project — checkout, install, smoke, each failure recorded on the
// worktree as it happens. Returns as soon as the runners are spawned; the
// error is only for the pre-flight. Ends on `crew setup status <ref>`.
func AddWorktree(wsName, name string, opts CheckoutOptions) error {
	ref, members, err := addWorktreeRecord(wsName, name, nil)
	if err != nil {
		return err
	}
	return StartSetup(ref, jobsFor(members, opts))
}

// jobsFor is one job per name with the same options.
func jobsFor(names []string, opts CheckoutOptions) []ProjectJob {
	jobs := make([]ProjectJob, 0, len(names))
	for _, n := range names {
		jobs = append(jobs, ProjectJob{Project: n, Install: opts.Install, Smoke: opts.Smoke})
	}
	return jobs
}

// addWorktreeRecord is the pre-flight and the record: the worktree is on
// the workspace, with its overrides, before any runner starts — from then
// on every directory made belongs to a worktree the list knows, and a
// runner's smoke already sees the overrides. Returns the members to run.
func addWorktreeRecord(wsName, name string, overrides map[string]string) (Ref, []string, error) {
	if err := ValidateName("worktree", name); err != nil {
		return Ref{}, nil, err
	}
	ref := Ref{Workspace: wsName, Worktree: name}
	var members []string
	err := Update(wsName, func(ws *Workspace) error {
		if len(ws.Worktrees) == 0 {
			return fmt.Errorf("workspace '%s' predates worktrees — run `crew migrate` first", wsName)
		}
		for _, wt := range ws.Worktrees {
			if wt.Name == name {
				return fmt.Errorf("workspace '%s' already has a worktree '%s'", wsName, name)
			}
		}
		// A direct-mode project points at the one canonical checkout, so a
		// second worktree would have both sharing it — the same clobbering
		// that assertNoOtherDirect prevents between workspaces.
		for _, wp := range ws.Projects {
			if IsDirect(wp) {
				return fmt.Errorf("workspace '%s' holds '%s' in direct mode, so it can only have one worktree — remove it or re-add it as a worktree project first",
					wsName, wp.Name)
			}
		}
		if err := os.MkdirAll(WorktreeDir(ref), 0o755); err != nil {
			return err
		}
		ws.Worktrees = append(ws.Worktrees, Worktree{Name: name, Overrides: overrides})
		members = memberNames(ws)
		return nil
	})
	return ref, members, err
}

// TrashNotice is the one line to show wherever disk is about to be used:
// removed checkouts are cleared in the background, so the space they took
// may not be back yet.
func TrashNotice() string {
	n := trash.Entries()
	switch n {
	case 0:
		return ""
	case 1:
		return "trash: 1 removed checkout still clearing in background"
	}
	return fmt.Sprintf("trash: %d removed checkouts still clearing in background", n)
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
	// Whatever else accumulated in the worktree dir goes the same way.
	if _, err := trash.Put(WorktreeDir(ref)); err != nil {
		debug.Log("trash", "%s: %v", WorktreeDir(ref), err)
	}
	trash.Sweep()

	// The disk work above can take a minute on a large checkout, and another
	// removal may have saved the workspace meanwhile. Drop this entry from
	// the file as it is now, not from the snapshot taken before.
	return dropWorktreeRecord(wsName, name)
}

func dropWorktreeRecord(wsName, name string) error {
	return Update(wsName, func(ws *Workspace) error {
		remaining := ws.Worktrees[:0:0]
		for _, wt := range ws.Worktrees {
			if wt.Name != name {
				remaining = append(remaining, wt)
			}
		}
		ws.Worktrees = remaining
		return nil
	})
}

// DuplicateWorktree creates a new worktree in the same workspace, carrying the
// source worktree's overrides across before its runners start. Ports are
// deliberately not copied: two worktrees on the same ports is the
// collision this whole model exists to prevent. Refuses while the source
// is still being made — its .env, which the copy takes, may not be there.
func DuplicateWorktree(ref Ref, newName string, opts CheckoutOptions) error {
	ws, err := Load(ref.Workspace)
	if err != nil {
		return err
	}
	src, err := selectWorktree(ws, ref.Worktree)
	if err != nil {
		return err
	}
	if SetupRunning(Ref{Workspace: ref.Workspace, Worktree: src.Name}) {
		return fmt.Errorf("%w on %s — crew setup status %s", ErrSetupRunning, ref, ref)
	}
	dst, members, err := addWorktreeRecord(ref.Workspace, newName, src.Overrides)
	if err != nil {
		return err
	}
	return StartSetup(dst, jobsFor(members, opts))
}

// SetOverride pins a variable for one worktree.
func SetOverride(ref Ref, key, value string) error {
	return updateWorktree(ref, func(wt *Worktree) {
		if wt.Overrides == nil {
			wt.Overrides = map[string]string{}
		}
		wt.Overrides[key] = value
	})
}

// ClearOverride removes a worktree override.
func ClearOverride(ref Ref, key string) error {
	return updateWorktree(ref, func(wt *Worktree) { delete(wt.Overrides, key) })
}

// SavePorts records the ports a worktree's servers were bound to, so the
// next start reuses them — merged, not replaced: the runners of one
// worktree each refresh their own project's ports. A pre-worktree
// workspace has nowhere to keep them and is left alone.
func SavePorts(ref Ref, ports map[string]int) error {
	if ref.Worktree == "" || len(ports) == 0 {
		return nil
	}
	return updateWorktree(ref, func(wt *Worktree) {
		if wt.Ports == nil {
			wt.Ports = map[string]int{}
		}
		for k, v := range ports {
			wt.Ports[k] = v
		}
	})
}

// updateWorktree is Update narrowed to one worktree of the workspace,
// resolved the way a Ref is (the only one when unnamed).
func updateWorktree(ref Ref, fn func(*Worktree)) error {
	return Update(ref.Workspace, func(ws *Workspace) error {
		wt, err := selectWorktree(ws, ref.Worktree)
		if err != nil {
			return err
		}
		for i := range ws.Worktrees {
			if ws.Worktrees[i].Name == wt.Name {
				fn(&ws.Worktrees[i])
				return nil
			}
		}
		return fmt.Errorf("workspace '%s' has no worktree '%s'", ref.Workspace, wt.Name)
	})
}
