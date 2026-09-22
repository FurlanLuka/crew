package workspace

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/trash"
)

// A check proves a project reproduces from nothing: a fresh checkout of
// its canonical repo run through the setup runner — mise, install, env
// command, a smoke of its own servers — before it joins any workspace.
//
// It is a target, not a workspace: the ref check/<project>, a checkout at
// ~/.crew/workspaces/check/<project>/<project>, the slug check--<project>,
// and a record at ~/.crew/checks/<project>.json holding the worktree half
// (ports, health, overrides). loadFor/updateFor hand that record to every
// ref-keyed path shaped as a workspace of one, so the runner, the status,
// the health, verify and the page work on it unchanged. A pass removes the
// checkout; a failure keeps it, locked, with its evidence.

// CheckWorkspace is the reserved workspace half of a check ref.
const CheckWorkspace = "check"

// Check is the record of one project's check.
type Check struct {
	Project  string    `json:"project"`
	At       time.Time `json:"at"`
	Worktree Worktree  `json:"worktree"`
}

// CheckRef is the ref a project's check answers to.
func CheckRef(project string) Ref { return Ref{Workspace: CheckWorkspace, Worktree: project} }

// IsCheck: the ref names a check target rather than a workspace's worktree.
func IsCheck(ref Ref) bool { return ref.Workspace == CheckWorkspace }

// ChecksDir holds the records, one <project>.json (+ .lock) each.
func ChecksDir() string { return filepath.Join(config.ConfigDir, "checks") }

func checkFile(project string) string { return filepath.Join(ChecksDir(), project+".json") }

// asWorkspace is the record as the one-project, one-worktree workspace
// every ref-keyed path expects.
func (c *Check) asWorkspace() *Workspace {
	wt := c.Worktree
	wt.Name = c.Project
	return &Workspace{
		Name:      CheckWorkspace,
		Projects:  []WorkspaceProject{{Name: c.Project}},
		Worktrees: []Worktree{wt},
	}
}

func loadCheck(project string) (*Check, error) {
	data, err := os.ReadFile(checkFile(project))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("no check of '%s' — crew check project %s", project, project)
		}
		return nil, err
	}
	var c Check
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("%s: %w", filepath.Base(checkFile(project)), err)
	}
	return &c, nil
}

func saveCheck(c *Check) error {
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(ChecksDir(), 0o755); err != nil {
		return err
	}
	return writeAtomic(checkFile(c.Project), data)
}

// lockCheck takes the file lock for one check record.
func lockCheck(project string) (func(), error) {
	return lockFile(checkFile(project) + ".lock")
}

// updateCheck is the locked read-modify-write on one check record.
func updateCheck(project string, fn func(*Check) error) error {
	unlock, err := lockCheck(project)
	if err != nil {
		return err
	}
	defer unlock()
	c, err := loadCheck(project)
	if err != nil {
		return err
	}
	if err := fn(c); err != nil {
		return err
	}
	return saveCheck(c)
}

// CheckExists: a record is on disk (the check is kept or running).
func CheckExists(project string) bool {
	_, err := os.Stat(checkFile(project))
	return err == nil
}

// Addressable: the ref names something a command can resolve — a
// workspace, or a check that is on disk.
func Addressable(ref Ref) bool {
	if IsCheck(ref) {
		return ref.Worktree != "" && CheckExists(ref.Worktree)
	}
	return Exists(ref.Workspace)
}

// ListChecks is every check on disk, by project name.
func ListChecks() ([]Check, error) {
	entries, err := os.ReadDir(ChecksDir())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []Check
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		c, err := loadCheck(strings.TrimSuffix(e.Name(), ".json"))
		if err != nil {
			debug.Log("setup", "check record %s: %v", e.Name(), err)
			continue
		}
		out = append(out, *c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Project < out[j].Project })
	return out, nil
}

// StartCheck makes the target and starts the one runner: whatever a
// previous check left (its checkout, its scratch branch, its result files
// — or a checkout a crash left without a record) is taken away first so
// the checkout never reuses an old tip; a running one is refused. Returns
// once the runner is spawned.
func StartCheck(projName string, opts CheckoutOptions) error {
	p := project.Get(projName)
	if p == nil {
		return fmt.Errorf("project '%s' not found in pool", projName)
	}
	if err := ValidateName("worktree", projName); err != nil {
		// A project name may hold "--"; a check ref may not.
		return fmt.Errorf("'%s' cannot be checked: %w", projName, err)
	}
	ref := CheckRef(projName)
	if SetupRunning(ref) {
		return fmt.Errorf("%w on %s — crew setup status %s", ErrSetupRunning, ref, ref)
	}
	removeSetupArtifacts(ref)
	trashCheckTarget(ref)
	if err := os.MkdirAll(WorktreeDir(ref), 0o755); err != nil {
		return err
	}
	if err := saveCheck(&Check{Project: projName, At: time.Now()}); err != nil {
		return err
	}
	return StartSetup(ref, []ProjectJob{{Project: projName, Install: opts.Install, Smoke: opts.Smoke}})
}

// FinishCheck is what a passed check ends with: the checkout to the trash,
// the scratch branch deleted, the record gone — the result files under the
// setup dir stay, so a poll that comes after still sees the ✓ table.
// Idempotent under the check lock; a runner still exiting is waited for.
func FinishCheck(projName string) error {
	unlock, err := lockCheck(projName)
	if err != nil {
		return err
	}
	defer unlock()
	if !CheckExists(projName) {
		return nil
	}
	ref := CheckRef(projName)
	waitRunnersGone(ref, RunnerExitWait)
	trashCheckTarget(ref)
	trash.Sweep()
	debug.Log("setup", "%s passed — target removed", ref)
	return os.Remove(checkFile(projName))
}

// RemoveCheck takes a kept check away by hand: its runners stopped, the
// checkout trashed, the branch deleted, the record and setup files gone.
func RemoveCheck(projName string) error {
	if !CheckExists(projName) {
		return fmt.Errorf("no check of '%s'", projName)
	}
	ref := CheckRef(projName)
	removeSetupArtifacts(ref)
	trashCheckTarget(ref)
	trash.Sweep()
	return os.Remove(checkFile(projName))
}

// trashCheckTarget: dev artifacts gone, the checkout to the trash with its
// scratch branch (cleanupWorktree), the target dir to the trash. Every step is a
// no-op on nothing, so callers need not ask what is there. The setup dir
// is the caller's call — a pass keeps it, a removal does not.
func trashCheckTarget(ref Ref) {
	removeDevArtifacts(ref)
	cleanupWorktree(ref, WorkspaceProject{Name: ref.Worktree})
	if _, err := trash.Put(WorktreeDir(ref)); err != nil {
		debug.Log("trash", "%s: %v", WorktreeDir(ref), err)
	}
}

// RunnerExitWait bounds how long a finished runner is given to exit before
// its files are taken away. A var: under go test the runner's pid is the
// test process, which never exits, so the wait always runs to its limit.
var RunnerExitWait = 2 * time.Second

// waitRunnersGone gives a runner that has written its verdict the moment
// it needs to exit, bounded, before its files are taken away.
func waitRunnersGone(ref Ref, limit time.Duration) {
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) && anyRunnerAlive(ref) {
		time.Sleep(50 * time.Millisecond)
	}
}

// checkVerdict is what SetupStatus applies on a check ref once every
// runner has stopped: a clean verdict removes the target.
func checkVerdict(ref Ref, st Status) {
	if !IsCheck(ref) || !st.Passed() {
		return
	}
	if err := FinishCheck(ref.Worktree); err != nil {
		debug.Log("setup", "%s: could not finish: %v", ref, err)
	}
}

// CheckInfoState is where a project's check stands.
type CheckInfoState int

const (
	CheckNone    CheckInfoState = iota // no check on record
	CheckRunning                       // a runner is alive
	CheckPassed                        // the ✓ table is kept, the target gone
	CheckFailed                        // the target is kept with its evidence
)

// CheckInfo is a project's check as a screen shows it at rest.
type CheckInfo struct {
	State  CheckInfoState
	Status *Status // the runner table, when there is one
	Health *Health // the failed record's issues
	At     time.Time
	// Smoked: the run started the servers too (crew check without
	// --no-smoke) — a ✓ that says "reproduces", not only "installs".
	Smoked bool
}

// InspectCheck is the one reading of a check's state, in the one order that
// is safe: SetupStatus first — it applies a pending verdict, and a pass
// finishes the target, so whoever reads it after a runner ends is what
// finishes a check — then the record. Read the other way round, a check
// passing between the two reads would show as kept and failed.
func InspectCheck(project string) CheckInfo {
	ref := CheckRef(project)
	st, err := SetupStatus(ref)
	var status *Status
	if err == nil && len(st.Projects) > 0 {
		status = &st
	}
	if status != nil && st.Running() {
		return CheckInfo{State: CheckRunning, Status: status, At: st.Projects[0].At}
	}
	if status != nil && st.Passed() {
		// The table's verdict stands whether or not FinishCheck managed to
		// take the record away.
		return CheckInfo{State: CheckPassed, Status: status, At: st.Projects[0].At, Smoked: smoked(st)}
	}
	if c, err := loadCheck(project); err == nil {
		h := c.Worktree.Health
		if h == nil && status != nil {
			h = st.Health()
		}
		at := c.At
		if h != nil {
			at = h.At
		}
		if h != nil || (status != nil && st.Failed()) {
			return CheckInfo{State: CheckFailed, Status: status, Health: h, At: at}
		}
		// A record with no verdict yet: the runner is starting.
		return CheckInfo{State: CheckRunning, Status: status, At: c.At}
	}
	return CheckInfo{}
}

// smoked: the table has a smoke step — the servers were started.
func smoked(st Status) bool {
	for _, p := range st.Projects {
		for _, step := range p.Steps {
			if stageOfStep(step.Name) == StageSmoke {
				return true
			}
		}
	}
	return false
}

// CheckPassedLine is the one sentence a passed check ends on, wherever it
// is reported — the CLI and the page must agree on it.
func CheckPassedLine(project string) string {
	return fmt.Sprintf("check %s passed — target removed", project)
}

// CheckSummary is a kept check as `crew ls worktrees` lists it.
func CheckSummary(c Check) Summary {
	ref := CheckRef(c.Project)
	return Summary{
		Ref:          ref,
		Name:         ref.String(),
		Workspace:    CheckWorkspace,
		Worktree:     c.Project,
		Path:         WorktreeDir(ref),
		ProjectCount: 1,
		DevRunning:   dev.Running(ref.Slug()),
		Installing:   SetupRunning(ref),
		Health:       c.Worktree.Health.Summary(),
	}
}
