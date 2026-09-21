package workspace

import (
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

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
	// Smoke starts the servers afterwards, watches them for a few seconds and
	// stops them: the check that finds a missing var before you do.
	Smoke bool
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

// The three steps of making a worktree, each over a named set of projects
// and each collecting failures instead of stopping. AddWorktree runs them
// over every project; Verify over what is missing; Setup with installs
// forced. Nothing here returns early: the point of a worktree is to be on
// it, seeing what is done and what is not.

// checkoutProjects makes a git worktree and copies .env for each name;
// returns the ones made and an issue per failure.
func checkoutProjects(ref Ref, ws *Workspace, names []string, progress func(string, exec.SetupResult)) (made []string, issues []Issue) {
	for _, name := range names {
		wp, ok := memberOf(ws, name)
		if !ok || IsDirect(wp) {
			continue
		}
		p := project.Get(name)
		if p == nil {
			issues = append(issues, Issue{Stage: StageCheckout, Project: name, Detail: "not in the project pool"})
			continue
		}
		start := time.Now()
		err := createProjectWorktree(ref, *p)
		if progress != nil {
			progress(name, exec.SetupResult{Step: exec.SetupStep{Name: "checkout"}, Duration: time.Since(start), Err: err})
		}
		if err != nil {
			issues = append(issues, Issue{Stage: StageCheckout, Project: name, Detail: err.Error()})
			continue
		}
		made = append(made, name)
	}
	return made, issues
}

// installProjects runs the install steps for each name that has a checkout,
// all at once — each project's install is its own, and they are the slow
// part of a worktree. An issue per failure, with the step's output tail as
// the evidence, in the order the names came.
func installProjects(ref Ref, ws *Workspace, names []string, opts CheckoutOptions) []Issue {
	var mu sync.Mutex
	serial := opts
	if opts.Progress != nil {
		// One line at a time from many installs.
		serial.Progress = func(project string, r exec.SetupResult) {
			mu.Lock()
			defer mu.Unlock()
			opts.Progress(project, r)
		}
	}

	results := make([]*Issue, len(names))
	var wg sync.WaitGroup
	for i, name := range names {
		wp, ok := memberOf(ws, name)
		if !ok || IsDirect(wp) || !dirExists(WorktreePath(ref, name)) {
			continue
		}
		p := project.Get(name)
		if p == nil {
			continue
		}
		wg.Add(1)
		go func(i int, p project.Project) {
			defer wg.Done()
			if err := setupProject(ref, p, serial); err != nil {
				results[i] = &Issue{Stage: StageInstall, Project: p.Name, Detail: installDetail(err)}
			}
		}(i, *p)
	}
	wg.Wait()

	var issues []Issue
	for _, r := range results {
		if r != nil {
			issues = append(issues, *r)
		}
	}
	return issues
}

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

// Setup re-runs every project's installs, then the smoke when asked, and
// records the verdict — the same check creation ends with.
func Setup(ref Ref, opts CheckoutOptions) (VerifyResult, error) {
	ws, err := Load(ref.Workspace)
	if err != nil {
		return VerifyResult{}, err
	}
	res, err := Resolve(ref)
	if err != nil {
		return VerifyResult{}, err
	}
	if opts.Smoke && dev.Running(res.Slug) {
		return VerifyResult{}, ErrServersRunning
	}
	missing := missingCheckouts(ref, ws)
	_, issues := checkoutProjects(ref, ws, missing, opts.Progress)
	opts.Install = true
	issues = append(issues, installProjects(ref, ws, memberNames(ws), opts)...)
	return finishCheck(ref, issues, opts)
}

// reportSmoke says what the smoke found, one line per server, the way
// install steps are reported.
func reportSmoke(results []SmokeResult, progress func(string, exec.SetupResult)) {
	if progress == nil {
		return
	}
	for _, r := range results {
		step := exec.SetupResult{Step: exec.SetupStep{Name: "smoke " + r.Server}, Duration: r.Took()}
		switch r.State() {
		case SmokeDied:
			step.Err = errors.New("died")
		case SmokeUnreached:
			step.Err = fmt.Errorf("not listening on :%d", r.Port)
		}
		progress(r.Project, step)
	}
}

func missingCheckouts(ref Ref, ws *Workspace) []string {
	var missing []string
	for _, wp := range ws.Projects {
		if !IsDirect(wp) && !dirExists(WorktreePath(ref, wp.Name)) {
			missing = append(missing, wp.Name)
		}
	}
	return missing
}

// finishCheck runs the smoke when asked, reports each server through
// Progress as a step, and records what everything found.
func finishCheck(ref Ref, issues []Issue, opts CheckoutOptions) (VerifyResult, error) {
	var results []SmokeResult
	if opts.Smoke {
		var smoked []Issue
		var err error
		results, smoked, err = smokeStage(ref, opts)
		if err != nil {
			return VerifyResult{}, err
		}
		issues = append(issues, smoked...)
	}
	h := healthOf(issues)
	if err := RecordHealth(ref, h); err != nil {
		// Health is read straight back from disk by the list and the page;
		// a verdict that did not land is not a verdict.
		return VerifyResult{Smoke: results, Health: h}, fmt.Errorf("record health for %s: %w", ref, err)
	}
	return VerifyResult{Smoke: results, Health: h}, nil
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

// AddWorktree adds a worktree to a workspace: checks every project out, installs
// every checkout, smokes the servers — each step over every project, each
// failure recorded on the worktree rather than stopping the rest. The error is
// only for the pre-flight; what the steps found is the Health.
func AddWorktree(wsName, name string, opts CheckoutOptions) (*Health, error) {
	if err := ValidateName("worktree", name); err != nil {
		return nil, err
	}

	ws, err := Load(wsName)
	if err != nil {
		return nil, err
	}
	if len(ws.Worktrees) == 0 {
		return nil, fmt.Errorf("workspace '%s' predates worktrees — run `crew migrate` first", wsName)
	}
	for _, wt := range ws.Worktrees {
		if wt.Name == name {
			return nil, fmt.Errorf("workspace '%s' already has a worktree '%s'", wsName, name)
		}
	}

	// A direct-mode project points at the one canonical checkout, so a second
	// worktree would have both sharing it — the same clobbering that
	// assertNoOtherDirect prevents between workspaces.
	for _, wp := range ws.Projects {
		if IsDirect(wp) {
			return nil, fmt.Errorf("workspace '%s' holds '%s' in direct mode, so it can only have one worktree — remove it or re-add it as a worktree project first",
				wsName, wp.Name)
		}
	}

	ref := Ref{Workspace: wsName, Worktree: name}
	if err := os.MkdirAll(WorktreeDir(ref), 0o755); err != nil {
		return nil, err
	}

	// Recorded before anything is checked out: from here on every directory
	// made belongs to a worktree the list knows, whatever else happens.
	ws.Worktrees = append(ws.Worktrees, Worktree{Name: name})
	if err := Save(ws); err != nil {
		return nil, err
	}

	_, issues := checkoutProjects(ref, ws, memberNames(ws), opts.Progress)
	if opts.Install {
		issues = append(issues, installProjects(ref, ws, memberNames(ws), opts)...)
	}
	result, err := finishCheck(ref, issues, opts)
	return result.Health, err
}

// smokeStage is the smoke on its own: start, wait for verdicts, stop,
// report — the results for a caller that shows them and the issues for
// whoever records them. A worktree with nothing to smoke yields nothing.
// The error is the resolve; a stack that could not start at all is an
// issue with no server on it.
func smokeStage(ref Ref, opts CheckoutOptions) ([]SmokeResult, []Issue, error) {
	res, err := Resolve(ref)
	if err != nil {
		return nil, nil, err
	}
	if len(res.DevProjects()) == 0 {
		return nil, nil, nil
	}
	results, err := SmokeStart(res)
	var issues []Issue
	if err != nil {
		issues = append(issues, Issue{Stage: StageSmoke, Project: ref.String(), Detail: "could not start: " + err.Error()})
	}
	reportSmoke(results, opts.Progress)
	return results, append(issues, smokeIssues(results)...), nil
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
func DuplicateWorktree(ref Ref, newName string, opts CheckoutOptions) (*Health, error) {
	ws, err := Load(ref.Workspace)
	if err != nil {
		return nil, err
	}
	src, err := selectWorktree(ws, ref.Worktree)
	if err != nil {
		return nil, err
	}

	h, err := AddWorktree(ref.Workspace, newName, opts)
	if err != nil {
		return nil, err
	}
	if len(src.Overrides) == 0 {
		return h, nil
	}

	ws, err = Load(ref.Workspace)
	if err != nil {
		return h, err
	}
	for i, wt := range ws.Worktrees {
		if wt.Name == newName {
			ws.Worktrees[i].Overrides = src.Overrides
			// Ports are deliberately not copied: two worktrees on the same
			// ports is the collision this whole model exists to prevent.
		}
	}
	return h, Save(ws)
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
