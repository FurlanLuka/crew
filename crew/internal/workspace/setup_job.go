package workspace

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// A worktree is made one project at a time, each by its own runner: a
// window of the tmux session crew-setup-<slug> running `crew _setup <ref>
// <project>`, doing checkout → .env → install → smoke of that project's
// servers → record. The command that started them returns at once; what
// each runner has done so far is in ~/.crew/setup/<slug>/<project>.json,
// which `crew setup status`, the page and the list read. A failure lands on
// the worktree's Health the moment it happens, while the others still run.

// ProjectJob is one runner's brief.
type ProjectJob struct {
	Project string
	Install bool
	Smoke   bool
}

// ErrSetupRunning: a runner is alive on the worktree. A dev start on top of
// an install, or a second install into the same checkout, is corruption,
// not a warning — the one thing crew refuses outright besides a verify
// under running servers.
var ErrSetupRunning = errors.New("setup is running")

// errFlatRef: a pre-2.0 workspace has no worktree record to reserve ports
// or record health on; it keeps the synchronous path.
var errFlatRef = errors.New("workspace predates worktrees — run `crew migrate` first")

const (
	StepRunning = "running"
	StepOK      = "ok"
	StepFailed  = "failed"
	StepSkipped = "skipped"
)

// RunStep is one step of a runner as its result file records it. StartedAt
// is what lets a reader show a running step's elapsed time — a long npm ci
// with no clock on it reads as frozen.
type RunStep struct {
	Name      string    `json:"name"`
	Status    string    `json:"status"`
	StartedAt time.Time `json:"started_at,omitempty"`
	TookMs    int64     `json:"took_ms,omitempty"`
	Detail    string    `json:"detail,omitempty"`
}

// RunResult is a runner's result file: written after every step, so a
// reader sees exactly how far it got. PID is the liveness signal — a pane
// can outlive its process and a file can outlive its pane.
type RunResult struct {
	Project    string     `json:"project"`
	PID        int        `json:"pid,omitempty"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
	Done       bool       `json:"done"`
	// Aborted: the runner was interrupted (a signal, a killed window, a
	// vanished process) — recorded as a failure, never as verified.
	Aborted bool      `json:"aborted,omitempty"`
	Steps   []RunStep `json:"steps"`
	Issues  []Issue   `json:"issues"`
}

// ProjectState is what a reader derives from a result file and liveness.
type ProjectState string

const (
	StateStarting    ProjectState = "starting"    // spawned, no runner has written yet
	StateRunning     ProjectState = "running"     // the runner is alive, not done
	StateOK          ProjectState = "ok"          // done, nothing recorded
	StateFailed      ProjectState = "failed"      // done, issues recorded
	StateInterrupted ProjectState = "interrupted" // the runner is gone without a verdict
)

// ProjectStatus is one project's row of `crew setup status`.
type ProjectStatus struct {
	Project string       `json:"project"`
	State   ProjectState `json:"state"`
	Steps   []RunStep    `json:"steps"`
	Issues  []Issue      `json:"issues"`
	TookMs  int64        `json:"took_ms,omitempty"`
}

// Status is the whole worktree's setup as it stands.
type Status struct {
	Ref      Ref             `json:"-"`
	Projects []ProjectStatus `json:"projects"`
}

// live: a runner is alive or about to be.
func (s ProjectState) live() bool { return s == StateStarting || s == StateRunning }

// Running: any runner is still alive or about to be.
func (s Status) Running() bool {
	for _, p := range s.Projects {
		if p.State.live() {
			return true
		}
	}
	return false
}

// Failed: something is recorded, or a runner vanished.
func (s Status) Failed() bool {
	for _, p := range s.Projects {
		if p.State == StateFailed || p.State == StateInterrupted {
			return true
		}
	}
	return false
}

// ExitCode is what `crew setup status` exits with: 2 while anything still
// runs (the verdict is pending, whatever the table already shows), 1 once
// everything stopped with a failure, 0 otherwise. Pure.
func (s Status) ExitCode() int {
	switch {
	case s.Running():
		return 2
	case s.Failed():
		return 1
	}
	return 0
}

// Health is the issues of every project as a Health, for a summary line.
func (s Status) Health() *Health {
	var issues []Issue
	for _, p := range s.Projects {
		issues = append(issues, p.Issues...)
	}
	return healthOf(issues)
}

// ── Files ──

func setupDir(slug dev.Slug) string {
	return filepath.Join(config.ConfigDir, "setup", string(slug))
}

func resultFile(slug dev.Slug, proj string) string {
	return filepath.Join(setupDir(slug), proj+".json")
}

// RunnerLogFile is where a runner writes what it did and what its install
// printed — what `crew setup logs` tails, live or afterwards.
func RunnerLogFile(ref Ref, proj string) string {
	return filepath.Join(setupDir(ref.Slug()), proj+".log")
}

// smokeLogFile is a smoked server's output. Not the dev log path: `crew
// dev logs` and the page's check read that one, and a smoke's last lines
// there would pass for the last dev run.
func smokeLogFile(slug dev.Slug, proj, server string) string {
	return filepath.Join(setupDir(slug), proj+"-"+server+".log")
}

func readResult(path string) (RunResult, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return RunResult{}, err
	}
	var r RunResult
	if err := json.Unmarshal(data, &r); err != nil {
		return RunResult{}, fmt.Errorf("%s: %w", filepath.Base(path), err)
	}
	return r, nil
}

func writeResult(path string, r RunResult) error {
	if r.Steps == nil {
		r.Steps = []RunStep{}
	}
	if r.Issues == nil {
		r.Issues = []Issue{}
	}
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return writeAtomic(path, data)
}

// ── Runner ──

// Runner is one project's pipeline. Run does the work; Abort is for the
// signal handler of `crew _setup` — it marks where the runner was and
// records the interruption, so a killed window never reads as verified.
type Runner struct {
	ref  Ref
	slug dev.Slug
	job  ProjectJob

	mu      sync.Mutex
	result  RunResult
	started map[string]time.Time // when each running step began
	log     *os.File
	windows []string // smoke windows up right now, for Abort to stop
}

// NewRunner opens the runner's log and writes its first result — pid and
// start time — before anything else happens.
func NewRunner(ref Ref, job ProjectJob) (*Runner, error) {
	if ref.Worktree == "" {
		return nil, errFlatRef
	}
	r := &Runner{ref: ref, slug: ref.Slug(), job: job, started: map[string]time.Time{}}
	r.result = RunResult{Project: job.Project, PID: os.Getpid(), StartedAt: time.Now()}
	if err := os.MkdirAll(setupDir(r.slug), 0o755); err != nil {
		return nil, err
	}
	log, err := os.OpenFile(RunnerLogFile(ref, job.Project), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return nil, err
	}
	r.log = log
	if err := r.write(); err != nil {
		log.Close()
		return nil, err
	}
	return r, nil
}

// RunProjectSetup is NewRunner + Run in this process, without the signal
// trap `crew _setup` adds around it — the shape the in-process test
// runners use.
func RunProjectSetup(ref Ref, job ProjectJob) error {
	r, err := NewRunner(ref, job)
	if err != nil {
		return err
	}
	return r.Run()
}

// Run is the pipeline: checkout → install → smoke → record. A stage that
// fails ends the run there — an install on a checkout that is not there,
// or a smoke of an install that failed, would only add noise to the
// evidence. Returns nil whatever the verdict; the verdict is on the file
// and on the worktree.
func (r *Runner) Run() error {
	defer r.log.Close()

	ws, err := Load(r.ref.Workspace)
	if err != nil {
		return r.fail(StageCheckout, err.Error())
	}
	wp, ok := memberOf(ws, r.job.Project)
	if !ok {
		return r.fail(StageCheckout, "not a member of "+r.ref.Workspace)
	}
	p := project.Get(wp.Name)
	if p == nil {
		return r.fail(StageCheckout, "not in the project pool")
	}
	debug.Log("setup", "%s: runner for %s (install=%v smoke=%v)", r.ref, r.job.Project, r.job.Install, r.job.Smoke)

	if issue := r.checkout(wp, *p); issue != nil {
		return r.finish([]Issue{*issue})
	}
	if issue := r.install(wp, *p); issue != nil {
		return r.finish([]Issue{*issue})
	}
	return r.finish(r.smoke())
}

func (r *Runner) checkout(wp WorkspaceProject, p project.Project) *Issue {
	switch {
	case IsDirect(wp):
		r.skip("checkout", "direct — the canonical checkout")
		return nil
	case dirExists(WorktreePath(r.ref, wp.Name)):
		r.skip("checkout", "present")
		return nil
	}
	r.begin("checkout")
	err := createProjectWorktree(r.ref, p)
	r.end("checkout", err)
	if err != nil {
		return &Issue{Stage: StageCheckout, Project: wp.Name, Detail: err.Error()}
	}
	return nil
}

func (r *Runner) install(wp WorkspaceProject, p project.Project) *Issue {
	if !r.job.Install || IsDirect(wp) {
		return nil
	}
	wtDir := WorktreePath(r.ref, wp.Name)
	steps := exec.SetupSteps(wtDir, p.Setup, p.EnvCmd)
	if len(steps) == 0 {
		r.skip("install", "nothing to install")
		return nil
	}
	// Each step is marked running before it starts, so a reader sees
	// "npm ci" spinning, not a gap.
	next := 0
	r.begin(steps[0].Name)
	err := exec.RunSetup(wtDir, steps, r.log, func(res exec.SetupResult) {
		r.end(res.Step.Name, res.Err)
		next++
		if res.Err == nil && next < len(steps) {
			r.begin(steps[next].Name)
		}
	})
	if err != nil {
		return &Issue{Stage: StageInstall, Project: wp.Name, Detail: installDetail(&ProjectSetupError{Project: wp.Name, Err: err})}
	}
	return nil
}

// smoke starts this project's servers as windows of the setup session on
// the worktree's reserved ports, waits for each verdict, stops them.
func (r *Runner) smoke() []Issue {
	if !r.job.Smoke {
		return nil
	}
	res, err := Resolve(r.ref)
	if err != nil {
		// No server names to report under: one step for the whole smoke.
		r.begin("smoke")
		return r.smokeNotStarted([]string{"smoke"}, err)
	}
	var mine []dev.DevProject
	for _, p := range res.DevProjects() {
		if p.Name == r.job.Project {
			mine = append(mine, p)
		}
	}
	if len(mine) == 0 || len(mine[0].DevServers) == 0 {
		return nil
	}
	steps := make([]string, 0, len(mine[0].DevServers))
	for _, ds := range mine[0].DevServers {
		steps = append(steps, "smoke "+ds.Name)
		r.begin("smoke " + ds.Name)
	}

	// A reserved port can be taken between the reservation and now — the
	// same rule dev start applies, or a stolen port reads as not listening.
	ports, err := reservePorts(r.ref, mine, res.Ports)
	if err != nil {
		return r.smokeNotStarted(steps, err)
	}

	session := dev.SetupSessionName(r.slug)
	routes, windows, err := dev.StartProjectServers(dev.ProjectServersParams{
		Session:   session,
		Slug:      r.slug,
		Workspace: r.ref.Workspace,
		Worktree:  r.ref.Worktree,
		Projects:  res.DevProjects(),
		Project:   r.job.Project,
		Overrides: res.Overrides,
		Ports:     ports,
		LogFile:   func(server string) string { return smokeLogFile(r.slug, r.job.Project, server) },
	})
	r.setWindows(windows)
	defer r.setWindows(nil)
	defer dev.StopWindows(session, windows)
	if err != nil {
		return r.smokeNotStarted(steps, err)
	}

	window := func(rt dev.Route) string { return rt.Project + "/" + rt.ServerName }
	logFor := func(rt dev.Route) string { return smokeLogFile(r.slug, rt.Project, rt.ServerName) }
	results := waitRoutes(session, routes, window, logFor, SmokeCeiling)
	for _, sr := range results {
		var verdict error
		switch sr.State() {
		case SmokeDied:
			verdict = errors.New("died")
		case SmokeUnreached:
			verdict = fmt.Errorf("not listening on :%d", sr.Port)
		}
		r.end("smoke "+sr.Server, verdict)
		if sr.Failed() {
			fmt.Fprintf(r.log, "%s\n", sr.Tail)
		}
	}
	return smokeIssues(results)
}

// smokeNotStarted is the verdict when the servers could not be started at
// all: every running smoke step fails with the reason, one issue with no
// server on it.
func (r *Runner) smokeNotStarted(steps []string, err error) []Issue {
	for _, s := range steps {
		r.end(s, err)
	}
	return []Issue{{Stage: StageSmoke, Project: r.job.Project, Detail: "could not start: " + err.Error()}}
}

// reservePorts gives each server of the given projects a port — the
// reserved one when it is still free, a fresh one otherwise — saves them
// on the worktree, and returns the worktree's whole map with these
// applied. StartSetup calls it over every project before the runners;
// a runner calls it over its own right before the smoke.
func reservePorts(ref Ref, projects []dev.DevProject, reserved map[string]int) (map[string]int, error) {
	allocated, err := dev.AllocatePorts(projects, reserved)
	if err != nil {
		return nil, err
	}
	ports := make(map[string]int, len(reserved))
	for k, v := range reserved {
		ports[k] = v
	}
	mine := map[string]int{}
	for _, ps := range dev.PlanServers(projects, allocated, true) {
		key := dev.PortKey(ps.Project, ps.Server.Name)
		ports[key], mine[key] = ps.Route.InternalPort, ps.Route.InternalPort
	}
	if err := SavePorts(ref, mine); err != nil {
		return nil, err
	}
	return ports, nil
}

func (r *Runner) begin(step string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	r.result.Steps = append(r.result.Steps, RunStep{Name: step, Status: StepRunning, StartedAt: now})
	r.started[step] = now
	r.write()
	r.logLine("▸ " + step)
}

func (r *Runner) end(step string, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := len(r.result.Steps) - 1; i >= 0; i-- {
		s := &r.result.Steps[i]
		if s.Name != step || s.Status != StepRunning {
			continue
		}
		s.TookMs = time.Since(r.started[step]).Milliseconds()
		s.Status = StepOK
		if err != nil {
			// A StepError names its step already; the table has that column.
			s.Status, s.Detail = StepFailed, firstLine(strings.TrimPrefix(err.Error(), step+": "))
		}
		r.logLine(fmt.Sprintf("%s %s %s", mark(err), step, (time.Duration(s.TookMs) * time.Millisecond).Round(time.Second)))
		break
	}
	r.write()
}

func (r *Runner) skip(step, why string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.result.Steps = append(r.result.Steps, RunStep{Name: step, Status: StepSkipped, Detail: why})
	r.write()
	r.logLine("– " + step + " (" + why + ")")
}

func mark(err error) string {
	if err != nil {
		return "✗"
	}
	return "✓"
}

func (r *Runner) logLine(line string) {
	fmt.Fprintf(r.log, "[%s] %s\n", time.Now().Format("15:04:05"), line)
}

func (r *Runner) setWindows(w []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.windows = w
}

// write must be called with the lock held.
func (r *Runner) write() error {
	if err := writeResult(resultFile(r.slug, r.job.Project), r.result); err != nil {
		debug.Log("setup", "%s/%s: result not written: %v", r.ref, r.job.Project, err)
		return err
	}
	return nil
}

// fail is a run that could not begin: one failed step, one issue.
func (r *Runner) fail(stage, detail string) error {
	r.begin(stage)
	r.end(stage, errors.New(detail))
	return r.finish([]Issue{{Stage: stage, Project: r.job.Project, Detail: detail}})
}

// finish records the verdict on the worktree — this project's issues
// replacing whatever was recorded about it, nothing about the others —
// and closes the file.
func (r *Runner) finish(issues []Issue) error {
	if err := recordMerged(r.ref, []string{r.job.Project}, issues); err != nil {
		debug.Log("setup", "%s/%s: health not recorded: %v", r.ref, r.job.Project, err)
		r.logLine("! health not recorded: " + err.Error())
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	r.result.Issues, r.result.Done, r.result.FinishedAt = issues, true, &now
	if len(issues) == 0 {
		r.logLine("done")
	} else {
		r.logLine(fmt.Sprintf("done — %s", healthOf(issues).Summary()))
	}
	return r.write()
}

// Abort is the runner's last word on a signal: the running step fails as
// interrupted, the interruption is recorded on the worktree, a smoke that
// was up is stopped. Safe to call while Run is blocked in a step.
func (r *Runner) Abort(reason string) {
	r.mu.Lock()
	if r.result.Done {
		// The verdict landed before the signal did — a killed install step
		// already failed with "signal: killed" — and stands.
		r.mu.Unlock()
		return
	}
	issue := interrupt(r.result.Steps, r.job.Project, reason)
	now := time.Now()
	r.result.Issues, r.result.Done, r.result.Aborted, r.result.FinishedAt = []Issue{issue}, true, true, &now
	r.write()
	r.logLine("! " + issue.Detail)
	windows := r.windows
	r.mu.Unlock()

	if err := recordMerged(r.ref, []string{r.job.Project}, []Issue{issue}); err != nil {
		debug.Log("setup", "%s/%s: interruption not recorded: %v", r.ref, r.job.Project, err)
	}
	if len(windows) > 0 {
		dev.StopWindows(dev.SetupSessionName(r.slug), windows)
	}
}

// interrupt marks the running step (if any) failed as interrupted, in
// place, and returns the issue a runner that did not finish leaves behind
// — at the stage of that step.
func interrupt(steps []RunStep, proj, reason string) Issue {
	step := ""
	for i := len(steps) - 1; i >= 0; i-- {
		if steps[i].Status == StepRunning {
			step = steps[i].Name
			steps[i].Status, steps[i].Detail = StepFailed, "interrupted"
			break
		}
	}
	detail := "runner interrupted"
	if step != "" {
		detail += " during " + step
	}
	if reason != "" {
		detail += " (" + reason + ")"
	}
	return Issue{Stage: stageOfStep(step), Project: proj, Detail: detail}
}

// stageOfStep maps a runner step to the stage its failure belongs to.
func stageOfStep(step string) string {
	switch {
	case step == "checkout", step == "":
		return StageCheckout
	case strings.HasPrefix(step, "smoke"):
		return StageSmoke
	}
	return StageInstall
}

// ── Starting ──

// SpawnRunner launches one runner; the default is a window of the setup
// session. A variable so tests run the pipeline in-process instead —
// under go test the crew binary is the test binary.
var SpawnRunner = spawnTmuxRunner

// runnerArgv is how a runner is invoked: the crew binary and its hidden
// command. Tests swap in the test binary's helper process.
var runnerArgv = func() []string {
	bin, err := exec.CrewBinary()
	if err != nil {
		bin = "crew"
	}
	return []string{bin, "_setup"}
}

func spawnTmuxRunner(ref Ref, job ProjectJob) error {
	if !exec.HasTmux() {
		return fmt.Errorf("tmux not found — install with: brew install tmux")
	}
	home, _ := os.UserHomeDir()
	cmd := runnerCommand(runnerArgv(), home, ref, job)
	debug.Log("setup", "%s: spawn %s → %s", ref, job.Project, cmd)
	return exec.TmuxRunInSession(dev.SetupSessionName(ref.Slug()), job.Project, WorktreeDir(ref), cmd)
}

// runnerCommand is the shell line a runner window runs. HOME is passed
// explicitly: the tmux server's environment is whoever created it, not the
// caller's, and crew's config dir hangs off HOME. Pure.
func runnerCommand(argv []string, home string, ref Ref, job ProjectJob) string {
	parts := []string{"HOME=" + exec.ShellQuote(home)}
	for _, a := range argv {
		parts = append(parts, exec.ShellQuote(a))
	}
	parts = append(parts, exec.ShellQuote(ref.String()), exec.ShellQuote(job.Project))
	if !job.Install {
		parts = append(parts, "--no-install")
	}
	if !job.Smoke {
		parts = append(parts, "--no-smoke")
	}
	return strings.Join(parts, " ")
}

// StartSetup starts one runner per job on a worktree and returns as soon
// as they are spawned. Before any: the members are checked, no job may
// have a live runner already, the worktree's ports are reserved (a
// runner's smoke resolves bindings to siblings that are not up yet), and
// what was recorded about these projects is cleared — they are being
// re-checked, and stale evidence in the fix prompt misleads. A pre-2.0
// workspace runs the jobs here, synchronously, without a smoke.
func StartSetup(ref Ref, jobs []ProjectJob) error {
	if len(jobs) == 0 {
		return nil
	}
	ws, err := Load(ref.Workspace)
	if err != nil {
		return err
	}
	for _, job := range jobs {
		if _, ok := memberOf(ws, job.Project); !ok {
			return fmt.Errorf("project '%s' is not in workspace '%s'", job.Project, ref.Workspace)
		}
	}
	if ref.Worktree == "" {
		return runFlat(ref, jobs)
	}
	if _, err := selectWorktree(ws, ref.Worktree); err != nil {
		return err
	}

	st, _ := readStatus(ref)
	for _, job := range jobs {
		if st.alive(job.Project) {
			return fmt.Errorf("%w on %s: %s — crew setup status %s", ErrSetupRunning, ref, job.Project, ref)
		}
	}

	res, err := Resolve(ref)
	if err != nil {
		return err
	}
	if _, err := reservePorts(ref, res.DevProjects(), res.Ports); err != nil {
		return err
	}

	names := make([]string, 0, len(jobs))
	for _, job := range jobs {
		names = append(names, job.Project)
	}
	if err := clearIssues(ref, names); err != nil {
		return err
	}
	if err := os.MkdirAll(setupDir(ref.Slug()), 0o755); err != nil {
		return err
	}
	for _, job := range jobs {
		// A stub with no pid: a reader sees "starting" until the runner
		// writes its first result, and "interrupted" if it never does.
		if err := writeResult(resultFile(ref.Slug(), job.Project), RunResult{Project: job.Project, StartedAt: time.Now()}); err != nil {
			return err
		}
		os.Remove(RunnerLogFile(ref, job.Project))
	}
	for i, job := range jobs {
		if err := SpawnRunner(ref, job); err != nil {
			// The runners spawned so far are real and keep going; the stubs
			// of the rest would read as starting, then interrupted, for
			// runners that never existed.
			for _, rest := range jobs[i:] {
				os.Remove(resultFile(ref.Slug(), rest.Project))
			}
			return fmt.Errorf("start runner for %s: %w", job.Project, err)
		}
	}
	return nil
}

// runFlat is the pre-2.0 path: checkouts and installs in this process, no
// smoke, nothing recorded — a flat workspace has no worktree to record on.
func runFlat(ref Ref, jobs []ProjectJob) error {
	for _, job := range jobs {
		p := project.Get(job.Project)
		if p == nil {
			return fmt.Errorf("project '%s' not found in pool", job.Project)
		}
		if !dirExists(WorktreePath(ref, p.Name)) {
			if err := createProjectWorktree(ref, *p); err != nil {
				return err
			}
		}
		if job.Install {
			if err := setupProject(ref, *p); err != nil {
				return err
			}
		}
	}
	return nil
}

func clearIssues(ref Ref, projects []string) error {
	return Update(ref.Workspace, func(ws *Workspace) error {
		for i := range ws.Worktrees {
			if ws.Worktrees[i].Name != ref.Worktree {
				continue
			}
			for _, p := range projects {
				ws.Worktrees[i].Health = ws.Worktrees[i].Health.without(p)
			}
		}
		return nil
	})
}

// ── Status ──

// spawnGrace is how long a stub may sit with no runner behind it before
// it reads as interrupted: tmux has to start the window, crew has to load.
const spawnGrace = 15 * time.Second

// deriveProjectState is the one decision every reader makes about a
// project, from its result file and whether its runner is alive. Pure.
func deriveProjectState(f RunResult, alive bool, age time.Duration) ProjectState {
	switch {
	case f.Done && f.Aborted:
		return StateInterrupted
	case f.Done && len(f.Issues) > 0:
		return StateFailed
	case f.Done:
		return StateOK
	case f.PID == 0 && age < spawnGrace:
		return StateStarting
	case f.PID == 0 || !alive:
		return StateInterrupted
	}
	return StateRunning
}

func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// readStatus reads every result file of a worktree, in member order.
// Pure over the files and the pids — it records nothing.
func readStatus(ref Ref) (Status, error) {
	st := Status{Ref: ref}
	entries, err := os.ReadDir(setupDir(ref.Slug()))
	if err != nil {
		if os.IsNotExist(err) {
			return st, nil
		}
		return st, err
	}
	byName := map[string]ProjectStatus{}
	var names []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		f, err := readResult(filepath.Join(setupDir(ref.Slug()), e.Name()))
		if err != nil {
			// A file mid-write reads as garbage for a moment; a stale
			// reader shows the last good state rather than an error.
			debug.Log("setup", "%s: %v", ref, err)
			continue
		}
		ps := ProjectStatus{Project: f.Project, State: deriveProjectState(f, pidAlive(f.PID), time.Since(f.StartedAt)), Steps: f.Steps, Issues: f.Issues}
		if f.FinishedAt != nil {
			ps.TookMs = f.FinishedAt.Sub(f.StartedAt).Milliseconds()
		}
		byName[f.Project] = ps
		names = append(names, f.Project)
	}
	var members []WorkspaceProject
	if ws, err := Load(ref.Workspace); err == nil {
		members = ws.Projects
	}
	for _, n := range memberOrder(names, members) {
		st.Projects = append(st.Projects, byName[n])
	}
	return st, nil
}

// memberOrder is the rows' order: members first as the workspace lists
// them, then whatever a removed member left behind, sorted. Pure.
func memberOrder(names []string, members []WorkspaceProject) []string {
	have := map[string]bool{}
	for _, n := range names {
		have[n] = true
	}
	var ordered []string
	seen := map[string]bool{}
	for _, wp := range members {
		if have[wp.Name] && !seen[wp.Name] {
			ordered = append(ordered, wp.Name)
			seen[wp.Name] = true
		}
	}
	rest := make([]string, 0, len(names))
	for _, n := range names {
		if !seen[n] {
			rest = append(rest, n)
		}
	}
	sort.Strings(rest)
	return append(ordered, rest...)
}

func (s Status) alive(proj string) bool {
	for _, p := range s.Projects {
		if p.Project == proj {
			return p.State.live()
		}
	}
	return false
}

// SetupStatus is what `crew setup status` shows: every project's state,
// steps and issues. A runner found gone without a verdict is recorded as
// interrupted here — whoever looks first writes it, so a killed window
// never leaves a clean row.
func SetupStatus(ref Ref) (Status, error) {
	st, err := readStatus(ref)
	if err != nil {
		return st, err
	}
	for i, p := range st.Projects {
		if p.State == StateInterrupted && len(p.Issues) == 0 {
			st.Projects[i] = markInterrupted(ref, p)
		}
	}
	return st, nil
}

// markInterrupted writes the abort a vanished runner could not — the file
// done and aborted, the issue on the worktree — and returns the row as it
// now stands.
func markInterrupted(ref Ref, p ProjectStatus) ProjectStatus {
	issue := interrupt(p.Steps, p.Project, "runner gone")
	p.Issues = []Issue{issue}
	debug.Log("setup", "%s/%s: %s", ref, p.Project, issue.Detail)
	if f, err := readResult(resultFile(ref.Slug(), p.Project)); err == nil {
		now := time.Now()
		f.Steps, f.Issues, f.Done, f.Aborted, f.FinishedAt = p.Steps, p.Issues, true, true, &now
		if err := writeResult(resultFile(ref.Slug(), p.Project), f); err != nil {
			debug.Log("setup", "%s/%s: interruption not written: %v", ref, p.Project, err)
		}
	}
	if err := recordMerged(ref, []string{p.Project}, p.Issues); err != nil {
		debug.Log("setup", "%s/%s: interruption not recorded: %v", ref, p.Project, err)
	}
	return p
}

// SetupRunning: a runner is alive on the worktree. What dev start, verify,
// setup and duplicate check before touching a checkout.
func SetupRunning(ref Ref) bool {
	if ref.Worktree == "" {
		return false
	}
	st, _ := readStatus(ref)
	return st.Running()
}

// WaitSetup polls until no runner is left, then returns the final status.
func WaitSetup(ref Ref) (Status, error) {
	return WatchSetup(ref, 500*time.Millisecond, func(Status) {})
}

// WatchSetup polls until no runner is left, with a look at every poll —
// for a terminal that redraws the table while it waits.
func WatchSetup(ref Ref, every time.Duration, look func(Status)) (Status, error) {
	for {
		st, err := SetupStatus(ref)
		if err != nil {
			return st, err
		}
		look(st)
		if !st.Running() {
			return st, nil
		}
		time.Sleep(every)
	}
}

// SetupLogs is the last n lines of a project's runner log — the steps and
// what its install printed — live while it runs, kept afterwards.
func SetupLogs(ref Ref, proj string, n int) (string, error) {
	data, err := os.ReadFile(RunnerLogFile(ref, proj))
	if err != nil {
		return "", err
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if n > 0 && len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n"), nil
}

// removeSetupArtifacts stops a worktree's runners and forgets their
// files. The runners get a moment to exit first: a killed session HUPs
// them and each writes its abort on the way out, which would recreate the
// directory under the removal.
func removeSetupArtifacts(ref Ref) {
	dev.StopSetup(ref.Slug())
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if !anyRunnerAlive(ref) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	os.RemoveAll(setupDir(ref.Slug()))
}

// anyRunnerAlive: a result file whose pid still answers — done or not,
// since a runner is still writing for a moment after its verdict.
func anyRunnerAlive(ref Ref) bool {
	entries, err := os.ReadDir(setupDir(ref.Slug()))
	if err != nil {
		return false
	}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		if f, err := readResult(filepath.Join(setupDir(ref.Slug()), e.Name())); err == nil && pidAlive(f.PID) {
			return true
		}
	}
	return false
}

// ── Rendering ──

// RenderSetupTable is one line per project: its state, then its steps in
// order with how long each took (a running one: so far, against now) —
// what `crew setup status` prints and the page shows while a setup runs.
// frame is the spinner glyph for a running step (a static one without a
// terminal). Pure.
func RenderSetupTable(st Status, frame string, now time.Time) string {
	if len(st.Projects) == 0 {
		return ""
	}
	width := 0
	for _, p := range st.Projects {
		width = max(width, len(p.Project))
	}
	var b strings.Builder
	for _, p := range st.Projects {
		glyph := frame
		switch p.State {
		case StateOK:
			glyph = "✓"
		case StateFailed, StateInterrupted:
			glyph = "✗"
		}
		fmt.Fprintf(&b, "  %s %-*s  %s\n", glyph, width, p.Project, describeSteps(p, frame, now))
	}
	return b.String()
}

// describeSteps is a project's steps as one line: done steps with their
// time, the running one with the frame, a failed one with its reason.
func describeSteps(p ProjectStatus, frame string, now time.Time) string {
	if p.State == StateStarting {
		return "starting"
	}
	if p.State == StateInterrupted && len(p.Issues) > 0 {
		return p.Issues[0].Detail
	}
	var parts []string
	for _, s := range p.Steps {
		took := ""
		if s.TookMs > 0 {
			took = " " + (time.Duration(s.TookMs) * time.Millisecond).Round(time.Second).String()
		}
		switch s.Status {
		case StepOK:
			parts = append(parts, s.Name+took)
		case StepSkipped:
			continue
		case StepRunning:
			elapsed := ""
			if !s.StartedAt.IsZero() && now.After(s.StartedAt) {
				elapsed = " " + now.Sub(s.StartedAt).Round(time.Second).String()
			}
			parts = append(parts, frame+" "+s.Name+elapsed)
		case StepFailed:
			detail := s.Detail
			if detail == "" {
				detail = "failed"
			}
			parts = append(parts, s.Name+" — "+detail)
		}
	}
	if len(parts) == 0 {
		return string(p.State)
	}
	return strings.Join(parts, " · ")
}
