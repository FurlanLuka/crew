package workspace

import (
	"errors"
	"fmt"
	"net"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/trash"
)

// TestMain doubles as the runner for the real-spawn test: with
// CREW_TEST_CONFIG_DIR set, this process is a runner window's command, not
// the suite — it points config at that dir, runs the one job named in the
// arguments and exits. The os/exec helper-process pattern.
func TestMain(m *testing.M) {
	if dir := os.Getenv("CREW_TEST_CONFIG_DIR"); dir != "" {
		os.Exit(helperRunner(dir))
	}
	os.Exit(m.Run())
}

func helperRunner(dir string) int {
	config.ConfigDir = dir
	config.WorkspacesDir = filepath.Join(dir, "workspaces")
	config.TrashDir = filepath.Join(dir, "trash")
	config.ClaudeConfigDir = filepath.Join(dir, "claude")
	// What the suite set in its own process, the runner has to be told.
	if d, err := time.ParseDuration(os.Getenv("CREW_TEST_SMOKE_CEILING")); err == nil {
		SmokeCeiling = d
	}
	if name := os.Getenv("CREW_TEST_PROXY_SESSION"); name != "" {
		dev.ProxySessionName = name
	}
	args := os.Args
	for i, a := range args {
		if a == "--" {
			args = args[i+1:]
			break
		}
	}
	// args: _setup <ref> <project> [flags]
	if len(args) < 3 {
		fmt.Fprintln(os.Stderr, "helper: not enough arguments:", os.Args)
		return 2
	}
	ref, err := ParseRef(args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, "helper:", err)
		return 2
	}
	job := ProjectJob{Project: args[2], Install: true, Smoke: true}
	for _, a := range args[3:] {
		switch a {
		case "--no-install":
			job.Install = false
		case "--no-smoke":
			job.Smoke = false
		}
	}
	if err := RunProjectSetup(ref, job); err != nil {
		fmt.Fprintln(os.Stderr, "helper:", err)
		return 1
	}
	return 0
}

// realRunners restores the tmux spawn and points the runner argv at this
// test binary's helper process, so one test proves the window, the
// command line and the result files agree.
func realRunners(t *testing.T) {
	t.Helper()
	if !exec.HasTmux() {
		t.Skip("tmux not available")
	}
	prevSpawn, prevArgv := SpawnRunner, runnerArgv
	SpawnRunner = spawnTmuxRunner
	dir := config.ConfigDir
	runnerArgv = func() []string {
		return []string{"env", "CREW_TEST_CONFIG_DIR=" + dir, "CREW_TEST_SMOKE_CEILING=" + SmokeCeiling.String(), "CREW_TEST_PROXY_SESSION=" + dev.ProxySessionName, os.Args[0], "-test.run=^$", "--", "_setup"}
	}
	t.Cleanup(func() { SpawnRunner, runnerArgv = prevSpawn, prevArgv })
}

func TestDeriveProjectState(t *testing.T) {
	old := time.Minute
	for _, tt := range []struct {
		name  string
		f     RunResult
		alive bool
		age   time.Duration
		want  ProjectState
	}{
		{"stub, fresh", RunResult{}, false, 0, StateStarting},
		{"stub, stale", RunResult{}, false, old, StateInterrupted},
		{"running, alive", RunResult{PID: 1}, true, old, StateRunning},
		{"running, dead", RunResult{PID: 1}, false, old, StateInterrupted},
		{"done, clean", RunResult{PID: 1, Done: true}, false, old, StateOK},
		{"done, issues", RunResult{PID: 1, Done: true, Issues: []Issue{{}}}, false, old, StateFailed},
		{"aborted", RunResult{PID: 1, Done: true, Aborted: true, Issues: []Issue{{}}}, false, old, StateInterrupted},
	} {
		if got := deriveProjectState(tt.f, tt.alive, tt.age); got != tt.want {
			t.Errorf("%s → %s, want %s", tt.name, got, tt.want)
		}
	}
}

func TestStatusExitCode(t *testing.T) {
	ps := func(states ...ProjectState) Status {
		var st Status
		for _, s := range states {
			st.Projects = append(st.Projects, ProjectStatus{State: s})
		}
		return st
	}
	for _, tt := range []struct {
		st   Status
		want int
	}{
		{ps(), 0},
		{ps(StateOK, StateOK), 0},
		{ps(StateOK, StateFailed), 1},
		{ps(StateInterrupted), 1},
		{ps(StateRunning), 2},
		{ps(StateStarting), 2},
		{ps(StateFailed, StateRunning), 2}, // the verdict is pending, whatever the table shows
	} {
		if got := tt.st.ExitCode(); got != tt.want {
			t.Errorf("%v → %d, want %d", tt.st.Projects, got, tt.want)
		}
	}
}

func TestRunnerCommand(t *testing.T) {
	ref := Ref{Workspace: "ws", Worktree: "wrk2"}
	got := runnerCommand([]string{"/Applications/My Tools/crew", "_setup"}, "/Users/me", ref, ProjectJob{Project: "api", Install: true, Smoke: true})
	want := "HOME='/Users/me' '/Applications/My Tools/crew' '_setup' 'ws/wrk2' 'api'"
	if got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
	got = runnerCommand([]string{"crew", "_setup"}, "/h", ref, ProjectJob{Project: "api"})
	if !strings.HasSuffix(got, "'api' --no-install --no-smoke") {
		t.Errorf("flags: %s", got)
	}
}

func TestInterrupt(t *testing.T) {
	steps := []RunStep{{Name: "checkout", Status: StepOK, TookMs: 5}, {Name: "npm ci", Status: StepRunning}}
	i := interrupt(steps, "api", "hangup")
	if i.Stage != StageInstall || i.Detail != "runner interrupted during npm ci (hangup)" {
		t.Errorf("install: %+v", i)
	}
	if steps[1].Status != StepFailed || steps[1].Detail != "interrupted" || steps[0].Status != StepOK {
		t.Errorf("steps after interrupt = %+v", steps)
	}
	if i := interrupt([]RunStep{{Name: "smoke api", Status: StepRunning}}, "api", ""); i.Stage != StageSmoke || i.Detail != "runner interrupted during smoke api" {
		t.Errorf("smoke, no reason: %+v", i)
	}
	if i := interrupt(nil, "api", "runner gone"); i.Stage != StageCheckout || i.Detail != "runner interrupted (runner gone)" {
		t.Errorf("no step: %+v", i)
	}
}

func TestMemberOrder(t *testing.T) {
	members := []WorkspaceProject{{Name: "api"}, {Name: "web"}, {Name: "worker"}}
	got := memberOrder([]string{"zed", "worker", "api", "old"}, members)
	if strings.Join(got, ",") != "api,worker,old,zed" {
		t.Errorf("order = %v", got)
	}
	if got := memberOrder([]string{"b", "a"}, nil); strings.Join(got, ",") != "a,b" {
		t.Errorf("no workspace → sorted: %v", got)
	}
}

// The failed-step detail is the step's own last line, not the StepError's
// "<step>: " repeat of the name the table already shows.
func TestRunner_FailedStepDetail(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	project.SetSetup("api", "sh -c 'echo no such module >&2; exit 7'")
	ref := Ref{Workspace: "ws", Worktree: "wrk2"}
	if err := AddWorktree("ws", "wrk2", CheckoutOptions{Install: true}); err != nil {
		t.Fatal(err)
	}
	st, _ := SetupStatus(ref)
	last := st.Projects[0].Steps[len(st.Projects[0].Steps)-1]
	if last.Status != StepFailed || last.Detail != "no such module" {
		t.Errorf("failed step = %+v", last)
	}
}

// Abort mid-step: the step fails as interrupted, the file is done and
// aborted, the worktree carries the issue; a second Abort or one after
// the verdict changes nothing.
func TestRunner_Abort(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	ref := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	r, err := NewRunner(ref, ProjectJob{Project: "api", Install: true})
	if err != nil {
		t.Fatal(err)
	}
	r.begin("npm ci")
	r.Abort("hangup")
	f, err := readResult(resultFile(ref.Slug(), "api"))
	if err != nil || !f.Done || !f.Aborted || f.Steps[0].Status != StepFailed || f.Steps[0].Detail != "interrupted" {
		t.Errorf("result = %+v, %v", f, err)
	}
	if h := recorded(t, ref); h == nil || h.Issues[0].Stage != StageInstall || h.Issues[0].Detail != "runner interrupted during npm ci (hangup)" {
		t.Errorf("health = %+v", h)
	}
	before, _ := os.ReadFile(resultFile(ref.Slug(), "api"))
	r.Abort("again")
	after, _ := os.ReadFile(resultFile(ref.Slug(), "api"))
	if string(before) != string(after) {
		t.Error("a second Abort must change nothing")
	}

	// A verdict that landed first stands.
	r2, _ := NewRunner(ref, ProjectJob{Project: "api"})
	r2.finish(nil)
	r2.Abort("late")
	if f, _ := readResult(resultFile(ref.Slug(), "api")); f.Aborted || len(f.Issues) != 0 {
		t.Errorf("Abort after finish must not overwrite: %+v", f)
	}
	if h := recorded(t, ref); h != nil {
		t.Errorf("health after a clean finish = %+v", h)
	}
}

// A smoke whose servers could not be started at all is one issue with no
// server on it, every smoke step failed with the reason.
func TestRunner_SmokeNotStarted(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	ref := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	project.AddDevServer("api", project.DevServer{Name: "api", Port: 3000, Command: "sleep 30"})
	r, err := NewRunner(ref, ProjectJob{Project: "api", Smoke: true})
	if err != nil {
		t.Fatal(err)
	}
	project.Remove("api")
	if err := r.Run(); err != nil {
		t.Fatal(err)
	}
	st, _ := SetupStatus(ref)
	steps := st.Projects[0].Steps
	if len(steps) == 0 || steps[len(steps)-1].Name != "checkout" || steps[len(steps)-1].Status != StepFailed {
		t.Fatalf("a project gone from the pool fails at checkout: %+v", steps)
	}

	// Still in the pool, but its worktree record is gone: the ports cannot
	// be reserved inside the smoke, so the servers never start.
	project.Add(project.Project{Name: "api", Path: t.TempDir()})
	project.AddDevServer("api", project.DevServer{Name: "api", Port: 3000, Command: "sleep 30"})
	r, _ = NewRunner(ref, ProjectJob{Project: "api", Smoke: true})
	Update("ws", func(ws *Workspace) error { ws.Worktrees = nil; return nil })
	if err := r.Run(); err != nil {
		t.Fatal(err)
	}
	f, _ := readResult(resultFile(ref.Slug(), "api"))
	last := f.Steps[len(f.Steps)-1]
	if last.Name != "smoke api" || last.Status != StepFailed || last.Detail == "" {
		t.Errorf("smoke step = %+v", last)
	}
	if len(f.Issues) != 1 || f.Issues[0].Stage != StageSmoke || f.Issues[0].Server != "" || !strings.HasPrefix(f.Issues[0].Detail, "could not start: ") {
		t.Errorf("issue = %+v", f.Issues)
	}
}

func TestSavePorts_Merges(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	ref := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	SavePorts(ref, map[string]int{"a/a": 1, "b/b": 2})
	SavePorts(ref, map[string]int{"b/b": 3, "c/c": 4})
	res, _ := Resolve(ref)
	if res.Ports["a/a"] != 1 || res.Ports["b/b"] != 3 || res.Ports["c/c"] != 4 {
		t.Errorf("ports = %v", res.Ports)
	}
}

// A reserved port that is taken by the time the smoke starts is replaced
// and the replacement saved; a free one and an untouched sibling stay.
func TestReservePorts_ReplacesTakenPort(t *testing.T) {
	newRepoWorkspace(t, "ws", "api", "web")
	ref := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	project.AddDevServer("api", project.DevServer{Name: "api", Port: 3000, Command: "x"})
	project.AddDevServer("web", project.DevServer{Name: "web", Port: 3001, Command: "x"})
	taken, _ := dev.FindFreePort()
	l, err := net.Listen("tcp", fmt.Sprintf(":%d", taken))
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	free, _ := dev.FindFreePort()
	SavePorts(ref, map[string]int{"api/api": taken, "web/web": free})

	res, _ := Resolve(ref)
	var api []dev.DevProject
	for _, p := range res.DevProjects() {
		if p.Name == "api" {
			api = append(api, p)
		}
	}
	ports, err := reservePorts(ref, api, res.Ports)
	if err != nil {
		t.Fatal(err)
	}
	if ports["api/api"] == taken || ports["api/api"] == 0 || ports["web/web"] != free {
		t.Errorf("ports = %v (taken %d, free %d)", ports, taken, free)
	}
	res, _ = Resolve(ref)
	if res.Ports["api/api"] != ports["api/api"] || res.Ports["web/web"] != free {
		t.Errorf("saved = %v", res.Ports)
	}
}

// StartSetup clears what was recorded about the projects it re-checks —
// stale evidence in the fix prompt misleads — and nothing else.
func TestStartSetup_ClearsStaleIssues(t *testing.T) {
	newRepoWorkspace(t, "ws", "api", "web")
	backgroundRunners(t)
	ref := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	RecordHealth(ref, &Health{At: time.Now(), Issues: []Issue{{Stage: StageInstall, Project: "api", Detail: "old"}, {Stage: StageInstall, Project: "web", Detail: "keep"}}})
	project.SetSetup("api", "sleep 2")
	if err := StartSetup(ref, []ProjectJob{{Project: "api", Install: true}}); err != nil {
		t.Fatal(err)
	}
	h := recorded(t, ref)
	if h == nil || len(h.Issues) != 1 || h.Issues[0].Project != "web" {
		t.Errorf("health right after start = %+v, want only web's", h)
	}
	WaitSetup(ref)
}

// A spawn that fails leaves no stub behind: a stub would read as starting,
// then interrupted, for a runner that never existed.
func TestStartSetup_SpawnFailureLeavesNoStub(t *testing.T) {
	newRepoWorkspace(t, "ws", "api", "web")
	ref := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	prev := SpawnRunner
	SpawnRunner = func(ref Ref, job ProjectJob) error {
		if job.Project == "web" {
			return errors.New("no tmux")
		}
		return RunProjectSetup(ref, job)
	}
	t.Cleanup(func() { SpawnRunner = prev })
	if err := StartSetup(ref, []ProjectJob{{Project: "api"}, {Project: "web"}}); err == nil || !strings.Contains(err.Error(), "web") {
		t.Fatalf("err = %v", err)
	}
	if SetupRunning(ref) {
		t.Error("nothing should read as running")
	}
	st, _ := SetupStatus(ref)
	for _, p := range st.Projects {
		if p.Project == "web" {
			t.Errorf("web should have no row: %+v", p)
		}
	}
}

// A result file mid-write is skipped for that read, not an error.
func TestReadStatus_ToleratesTornFile(t *testing.T) {
	newRepoWorkspace(t, "ws", "api", "web")
	ref := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	os.WriteFile(resultFile(ref.Slug(), "web"), []byte(`{"project":"we`), 0o644)
	st, err := SetupStatus(ref)
	if err != nil || len(st.Projects) != 1 || st.Projects[0].Project != "api" {
		t.Errorf("status = %+v, %v", st.Projects, err)
	}
}

func TestSetupLogs_TailsN(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	ref := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	os.WriteFile(RunnerLogFile(ref, "api"), []byte("1\n2\n3\n4\n5\n"), 0o644)
	if got, _ := SetupLogs(ref, "api", 2); got != "4\n5" {
		t.Errorf("n=2 → %q", got)
	}
	if got, _ := SetupLogs(ref, "api", 0); got != "1\n2\n3\n4\n5" {
		t.Errorf("n=0 → %q", got)
	}
	if _, err := SetupLogs(ref, "nope", 0); err == nil {
		t.Error("missing log must be an error")
	}
}

// A direct-mode member gets a runner that skips the checkout and install
// but still smokes its servers from the canonical checkout — the smoke is
// about the servers crew will start there, whoever owns the checkout.
func TestRunner_DirectMemberSmokesOnly(t *testing.T) {
	if !exec.HasTmux() {
		t.Skip("tmux not available")
	}
	tmp := setupTestConfig(t)
	repo := filepath.Join(tmp, "repos", "api")
	os.MkdirAll(repo, 0o755)
	initRepo(t, repo)
	project.Add(project.Project{Name: "api", Path: repo, Setup: "exit 9"})
	project.AddDevServer("api", project.DevServer{Name: "api", Port: 3000, Command: "sleep 30"})
	if err := Create("ws"); err != nil {
		t.Fatal(err)
	}
	ref := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	if _, err := AddProjects("ws", []ProjectSpec{{Name: "api", Mode: ModeDirect}}, CheckoutOptions{Install: true, Smoke: true}); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(stepsOf(t, ref), ","); got != "api:smoke api" {
		t.Errorf("steps = %s, want the smoke only (no checkout, no install of the canonical repo)", got)
	}
	if h := recorded(t, ref); h != nil {
		t.Errorf("health = %+v", h)
	}
}

// The pre-2.0 flat path: in this process, no smoke, nothing recorded, an
// install failure returned.
func TestRunFlat(t *testing.T) {
	tmp := setupTestConfig(t)
	repo := filepath.Join(tmp, "repos", "api")
	os.MkdirAll(repo, 0o755)
	initRepo(t, repo)
	project.Add(project.Project{Name: "api", Path: repo})
	Save(&Workspace{Name: "flat", Projects: []WorkspaceProject{{Name: "api"}}})
	ref := Ref{Workspace: "flat"}
	os.MkdirAll(WorktreeDir(ref), 0o755)

	if err := StartSetup(ref, []ProjectJob{{Project: "api", Install: true, Smoke: true}}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(WorktreePath(ref, "api"), ".git")); err != nil {
		t.Error("flat checkout should exist")
	}
	if _, err := os.Stat(setupDir(ref.Slug())); !os.IsNotExist(err) {
		t.Error("a flat workspace has no setup dir")
	}
	if SetupRunning(ref) {
		t.Error("a flat workspace never has runners")
	}
	project.SetSetup("api", "exit 4")
	if err := StartSetup(ref, []ProjectJob{{Project: "api", Install: true}}); err == nil {
		t.Error("a flat install failure is returned, not recorded")
	}
}

func TestRenderSetupTable(t *testing.T) {
	st := Status{Projects: []ProjectStatus{
		{Project: "api", State: StateOK, Steps: []RunStep{{Name: "checkout", Status: StepOK, TookMs: 1200}, {Name: "npm ci", Status: StepOK, TookMs: 11400}, {Name: "smoke api", Status: StepOK, TookMs: 2100}}},
		{Project: "web", State: StateFailed, Steps: []RunStep{{Name: "checkout", Status: StepSkipped, Detail: "present"}, {Name: "make sync", Status: StepFailed, TookMs: 900, Detail: "exit 3"}}},
		{Project: "worker", State: StateRunning, Steps: []RunStep{{Name: "checkout", Status: StepOK, TookMs: 800}, {Name: "uv sync", Status: StepRunning}}},
		{Project: "admin", State: StateStarting},
		{Project: "signals", State: StateInterrupted, Steps: []RunStep{{Name: "pnpm install", Status: StepFailed, Detail: "interrupted"}}, Issues: []Issue{{Detail: "runner interrupted during pnpm install (runner gone)"}}},
		{Project: "infra-ops", State: StateFailed, Steps: []RunStep{{Name: "checkout", Status: StepFailed}}},
		{Project: "store-app", State: StateOK},
	}}
	got := RenderSetupTable(st, "⣾")
	want := strings.Join([]string{
		"  ✓ api        checkout 1s · npm ci 11s · smoke api 2s",
		"  ✗ web        make sync — exit 3",
		"  ⣾ worker     checkout 1s · ⣾ uv sync",
		"  ⣾ admin      starting",
		"  ✗ signals    runner interrupted during pnpm install (runner gone)",
		"  ✗ infra-ops  checkout — failed",
		"  ✓ store-app  ok",
		"",
	}, "\n")
	if got != want {
		t.Errorf("table =\n%s\nwant\n%s", got, want)
	}
	if RenderSetupTable(Status{}, "x") != "" {
		t.Error("no projects → nothing")
	}
}

func TestResultFile_RoundTripAndTruncated(t *testing.T) {
	path := filepath.Join(t.TempDir(), "api.json")
	now := time.Now().Round(time.Millisecond)
	r := RunResult{Project: "api", PID: 42, StartedAt: now, Steps: []RunStep{{Name: "checkout", Status: StepRunning}}}
	if err := writeResult(path, r); err != nil {
		t.Fatal(err)
	}
	got, err := readResult(path)
	if err != nil || got.Project != "api" || got.PID != 42 || len(got.Steps) != 1 || got.Steps[0].Status != StepRunning || !got.StartedAt.Equal(now) {
		t.Errorf("round trip = %+v, %v", got, err)
	}
	os.WriteFile(path, []byte(`{"project":"api","st`), 0o644)
	if _, err := readResult(path); err == nil {
		t.Error("a truncated file must read as an error, not a zero result")
	}
}

// The headline: a failing install is on the worktree while a slower
// sibling still runs, and verify of the one fixed project leaves the
// sibling's result alone.
func TestStartSetup_EarlyVisibility(t *testing.T) {
	newRepoWorkspace(t, "ws", "bad", "slow")
	backgroundRunners(t)
	project.SetSetup("bad", "sh -c 'echo boom >&2; exit 3'")
	project.SetSetup("slow", "sleep 3")
	ref := Ref{Workspace: "ws", Worktree: "wrk2"}

	start := time.Now()
	if err := AddWorktree("ws", "wrk2", CheckoutOptions{Install: true}); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took > time.Second {
		t.Errorf("AddWorktree must return at once, took %s", took)
	}

	deadline := time.Now().Add(3 * time.Second)
	var st Status
	for {
		st, _ = SetupStatus(ref)
		if len(st.Projects) == 2 && st.Projects[0].State == StateFailed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("bad never failed: %+v", st.Projects)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if st.Projects[1].State != StateRunning || st.ExitCode() != 2 {
		t.Errorf("while bad failed slow should still run: %+v exit=%d", st.Projects, st.ExitCode())
	}
	if h := recorded(t, ref); h == nil || h.Summary() != "install failed: bad" || !strings.Contains(h.Issues[0].Detail, "boom") {
		t.Errorf("health while slow runs = %+v", h)
	}
	if !SetupRunning(ref) {
		t.Error("SetupRunning should be true while slow runs")
	}
	if logs, err := SetupLogs(ref, "bad", 50); err != nil || !strings.Contains(logs, "boom") {
		t.Errorf("runner log = %q, %v", logs, err)
	}

	final, err := WaitSetup(ref)
	if err != nil || final.Running() || final.ExitCode() != 1 {
		t.Fatalf("final = %+v, %v", final.Projects, err)
	}
	if final.Projects[1].State != StateOK {
		t.Errorf("slow should pass: %+v", final.Projects[1])
	}
	slowBefore, _ := os.ReadFile(resultFile(ref.Slug(), "slow"))

	project.SetSetup("bad", "true")
	res, _ := Resolve(ref)
	if err := Verify(res, CheckoutOptions{Install: true}, []string{"bad"}); err != nil {
		t.Fatal(err)
	}
	if _, err := WaitSetup(ref); err != nil {
		t.Fatal(err)
	}
	if h := recorded(t, ref); h != nil {
		t.Errorf("verify of the fixed project should clear: %+v", h)
	}
	slowAfter, _ := os.ReadFile(resultFile(ref.Slug(), "slow"))
	if string(slowBefore) != string(slowAfter) {
		t.Error("a verify of one project must not touch the other's result")
	}
	if err := Verify(res, CheckoutOptions{}, []string{"nope"}); err == nil {
		t.Error("an unknown project must be refused")
	}
}

// A runner that vanished — a result file left running with a dead pid —
// reads as interrupted, is recorded on the worktree, and no longer blocks
// the next setup.
func TestSetupStatus_VanishedRunnerIsInterrupted(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	ref := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	gone := osexec.Command("true")
	gone.Run()
	f := RunResult{Project: "api", PID: gone.Process.Pid, StartedAt: time.Now().Add(-time.Minute), Steps: []RunStep{{Name: "checkout", Status: StepOK}, {Name: "npm ci", Status: StepRunning}}}
	if err := writeResult(resultFile(ref.Slug(), "api"), f); err != nil {
		t.Fatal(err)
	}

	done := make(chan Status, 1)
	go func() {
		st, _ := WaitSetup(ref)
		done <- st
	}()
	select {
	case st := <-done:
		if len(st.Projects) != 1 || st.Projects[0].State != StateInterrupted || st.ExitCode() != 1 {
			t.Errorf("status = %+v", st.Projects)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("WaitSetup must return for a dead runner")
	}
	h := recorded(t, ref)
	if h == nil || h.Summary() != "install failed: api" || h.Issues[0].Detail != "runner interrupted during npm ci (runner gone)" {
		t.Errorf("health = %+v", h)
	}
	if SetupRunning(ref) {
		t.Error("a vanished runner must not count as running")
	}
	if err := StartSetup(ref, []ProjectJob{{Project: "api"}}); err != nil {
		t.Errorf("the next setup must not be blocked by a dead runner: %v", err)
	}
}

// While a runner is alive: dev start, verify, setup and a second runner
// for the same project refuse; a runner for another project is fine.
func TestSetupRunning_Refusals(t *testing.T) {
	newRepoWorkspace(t, "ws", "api", "web")
	backgroundRunners(t)
	project.SetSetup("api", "sleep 3")
	project.AddDevServer("api", project.DevServer{Name: "api", Port: 3000, Command: "sleep 30"})
	ref := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	t.Cleanup(func() { dev.StopAll(ref.Slug()) })

	if err := StartSetup(ref, []ProjectJob{{Project: "api", Install: true}}); err != nil {
		t.Fatal(err)
	}
	res, _ := Resolve(ref)
	if _, err := StartDev(res, true, false); !errors.Is(err, ErrSetupRunning) {
		t.Errorf("dev start while installing = %v", err)
	}
	if err := Verify(res, CheckoutOptions{}, nil); !errors.Is(err, ErrSetupRunning) {
		t.Errorf("verify while installing = %v", err)
	}
	if err := Setup(ref, CheckoutOptions{}, nil); !errors.Is(err, ErrSetupRunning) {
		t.Errorf("setup while installing = %v", err)
	}
	if err := DuplicateWorktree(ref, "wrk2", CheckoutOptions{}); !errors.Is(err, ErrSetupRunning) {
		t.Errorf("duplicate while installing = %v", err)
	}
	if err := RemoveProject("ws", "api"); !errors.Is(err, ErrSetupRunning) {
		t.Errorf("rm workspace <p> while installing = %v", err)
	}
	if ws, _ := Load("ws"); len(ws.Projects) != 2 {
		t.Error("the refused removal must keep the member")
	}
	if err := StartSetup(ref, []ProjectJob{{Project: "web"}}); err != nil {
		t.Errorf("another project's runner should be fine: %v", err)
	}
	if _, err := WaitSetup(ref); err != nil {
		t.Fatal(err)
	}
	if !exec.HasTmux() {
		t.Skip("tmux not available")
	}
	if _, err := StartDev(res, true, false); err != nil {
		t.Errorf("dev start after the runners: %v", err)
	}
}

// Ten runners recording at once, with overrides written in between: every
// write lands. The lock is what makes this hold.
func TestUpdate_ConcurrentWritesAllLand(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	ref := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			p := fmt.Sprintf("p%d", i)
			if err := recordMerged(ref, []string{p}, []Issue{{Stage: StageInstall, Project: p}}); err != nil {
				t.Error(err)
			}
		}(i)
		go func(i int) {
			defer wg.Done()
			if err := SetOverride(ref, fmt.Sprintf("K%d", i), "v"); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	res, _ := Resolve(ref)
	if res.Health == nil || len(res.Health.Issues) != 10 {
		t.Errorf("issues = %+v, want all ten", res.Health)
	}
	if len(res.Overrides) != 10 {
		t.Errorf("overrides = %v, want all ten", res.Overrides)
	}
	// Clearing the last one clears the record, never an empty locked page.
	for i := 0; i < 10; i++ {
		recordMerged(ref, []string{fmt.Sprintf("p%d", i)}, nil)
	}
	if res, _ := Resolve(ref); res.Health != nil {
		t.Errorf("nothing left should be nil, got %+v", res.Health)
	}
}

// The real spawn: a window per project in the setup session, running this
// binary's helper; result files land; the session is gone with the last
// runner; the log holds the install's output.
func TestStartSetup_TmuxSpawn(t *testing.T) {
	newRepoWorkspace(t, "ws", "bad", "good")
	realRunners(t)
	project.SetSetup("bad", "sh -c 'echo boom >&2; exit 3'")
	project.SetSetup("good", "sleep 1")
	ref := Ref{Workspace: "ws", Worktree: "wrk2"}
	session := dev.SetupSessionName(ref.Slug())
	t.Cleanup(func() { exec.KillTmuxSession(session) })

	if err := AddWorktree("ws", "wrk2", CheckoutOptions{Install: true}); err != nil {
		t.Fatal(err)
	}
	if !exec.TmuxSessionExists(session) {
		t.Fatal("the setup session should exist while runners are alive")
	}
	st, err := WaitSetup(ref)
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Projects) != 2 || st.Projects[0].State != StateFailed || st.Projects[1].State != StateOK {
		t.Errorf("status = %+v", st.Projects)
	}
	if h := recorded(t, ref); h == nil || h.Summary() != "install failed: bad" {
		t.Errorf("health = %+v", h)
	}
	if logs, _ := SetupLogs(ref, "bad", 0); !strings.Contains(logs, "boom") {
		t.Errorf("runner log = %q", logs)
	}
	deadline := time.Now().Add(3 * time.Second)
	for exec.TmuxSessionExists(session) && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if exec.TmuxSessionExists(session) {
		t.Error("the session should go with its last window")
	}
}

// A killed window mid-install never reads as verified: the pane sweep
// kills the install step first, which the runner records as a failure
// ("signal: killed"); a runner that dies before recording is marked
// interrupted by the next status read. Either way a failure is on the
// worktree.
func TestStartSetup_KilledWindowIsInterrupted(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	realRunners(t)
	project.SetSetup("api", "sleep 30")
	ref := Ref{Workspace: "ws", Worktree: "wrk2"}
	session := dev.SetupSessionName(ref.Slug())
	t.Cleanup(func() { exec.KillTmuxSession(session) })

	if err := AddWorktree("ws", "wrk2", CheckoutOptions{Install: true}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		st, _ := SetupStatus(ref)
		if len(st.Projects) == 1 && st.Projects[0].State == StateRunning && len(st.Projects[0].Steps) > 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("runner never reached its install: %+v", st.Projects)
		}
		time.Sleep(100 * time.Millisecond)
	}
	exec.KillTmuxWindow(session, "api")

	deadline = time.Now().Add(5 * time.Second)
	for {
		st, _ := SetupStatus(ref)
		if len(st.Projects) == 1 && (st.Projects[0].State == StateInterrupted || st.Projects[0].State == StateFailed) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("killed runner never read as a failure: %+v", st.Projects)
		}
		time.Sleep(200 * time.Millisecond)
	}
	h := recorded(t, ref)
	if h == nil || h.Summary() != "install failed: api" || !(strings.Contains(h.Issues[0].Detail, "interrupted") || strings.Contains(h.Issues[0].Detail, "killed")) {
		t.Errorf("health = %+v", h)
	}
	if SetupRunning(ref) {
		t.Error("a killed runner must not count as running")
	}
}

// The smoke in the setup session: a binding to a sibling that is not up
// resolves (ports were reserved first), no dev session or routes appear,
// and the smoke's windows are gone afterwards.
func TestRunner_SmokeInSetupSession(t *testing.T) {
	if !exec.HasTmux() {
		t.Skip("tmux not available")
	}
	if _, err := osexec.LookPath("python3"); err != nil {
		t.Skip("python3 not available")
	}
	newRepoWorkspace(t, "ws", "api", "web")
	// api is referenced, so it has to listen; web only has to stay up
	// once it has seen the resolved URL (no sh -c wrapper: the pane's
	// foreground command would read as an idle shell).
	project.AddDevServer("api", project.DevServer{Name: "api", Port: 3000, Command: "python3 -m http.server $PORT"})
	project.AddDevServer("web", project.DevServer{Name: "web", Port: 3001, Command: "test -n \"$API_URL\" && sleep 30"})
	project.AddBinding("web", project.Binding{Var: "API_URL", Value: "{{api}}"})
	ref := Ref{Workspace: "ws", Worktree: "wrk2"}
	session := dev.SetupSessionName(ref.Slug())
	t.Cleanup(func() { exec.KillTmuxSession(session); dev.StopAll(ref.Slug()) })

	// Runners run inline here, api's first; by the time web's smoke starts
	// api's server has been stopped again. What web sees is API_URL from
	// the reserved ports, not a live sibling.
	if err := AddWorktree("ws", "wrk2", CheckoutOptions{Smoke: true}); err != nil {
		t.Fatal(err)
	}
	if h := recorded(t, ref); h != nil {
		t.Errorf("web sees API_URL from the reserved ports: %+v", h)
	}
	res, _ := Resolve(ref)
	if res.Ports[dev.PortKey("api", "api")] == 0 || res.Ports[dev.PortKey("web", "web")] == 0 {
		t.Errorf("ports should be reserved for every server: %v", res.Ports)
	}
	if dev.Running(ref.Slug()) || exec.TmuxSessionExists(dev.SessionName(ref.Slug())) {
		t.Error("a smoke must not look like a dev start")
	}
	if exec.TmuxSessionExists(session) {
		t.Error("the smoke's windows must be gone")
	}
	if _, err := os.Stat(smokeLogFile(ref.Slug(), "web", "web")); err != nil {
		t.Error("the smoke's log should be kept under the setup dir")
	}
}

// Removing a worktree mid-install stops its runners first — one still
// installing into a checkout on its way to the trash would record on a
// worktree that no longer exists — and takes the setup dir with it.
func TestRemoveWorktree_StopsLiveRunners(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	realRunners(t)
	project.SetSetup("api", "sleep 30")
	ref := Ref{Workspace: "ws", Worktree: "wrk2"}
	session := dev.SetupSessionName(ref.Slug())
	t.Cleanup(func() { exec.KillTmuxSession(session) })
	trash.DisableSweepForTest(t)

	if err := AddWorktree("ws", "wrk2", CheckoutOptions{Install: true}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		if st, _ := SetupStatus(ref); len(st.Projects) == 1 && st.Projects[0].State == StateRunning {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("runner never started")
		}
		time.Sleep(100 * time.Millisecond)
	}
	f, _ := readResult(resultFile(ref.Slug(), "api"))
	if err := RemoveWorktree("ws", "wrk2"); err != nil {
		t.Fatal(err)
	}
	if exec.TmuxSessionExists(session) {
		t.Error("the runners' session should be gone")
	}
	if pidAlive(f.PID) {
		t.Error("the runner should have been stopped before the removal returned")
	}
	if _, err := os.Stat(setupDir(ref.Slug())); !os.IsNotExist(err) {
		t.Error("the setup dir should go with the worktree")
	}
	if ws, _ := Load("ws"); len(ws.Worktrees) != 1 {
		t.Errorf("worktrees after removal = %+v", ws.Worktrees)
	}
}

// Trash and the setup dir go together with the worktree.
func TestRemoveWorktree_ClearsSetupArtifacts(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	ref := Ref{Workspace: "ws", Worktree: "wrk2"}
	if err := AddWorktree("ws", "wrk2", CheckoutOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(setupDir(ref.Slug())); err != nil {
		t.Fatal("the setup dir should exist after a creation")
	}
	trash.DisableSweepForTest(t)
	if err := RemoveWorktree("ws", "wrk2"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(setupDir(ref.Slug())); !os.IsNotExist(err) {
		t.Error("the setup dir should go with the worktree")
	}
}

// Reserved words cannot name a workspace: `crew setup status <ref>` would
// never reach it.
func TestValidateName_ReservesSubcommands(t *testing.T) {
	for _, name := range []string{"status", "logs", "worktree"} {
		if err := ValidateName("workspace", name); err == nil {
			t.Errorf("%q should be reserved", name)
		}
	}
	if err := ValidateName("worktree", "status"); err != nil {
		t.Errorf("a worktree may be called status: %v", err)
	}
}

// The env command runs in the checkout before the install, as its own
// named step, so an install that needs the vars has them; a failing one
// ends the run as an install failure with its own tail; --no-install
// skips it with the rest.
func TestRunner_EnvCommand(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	project.SetEnvCmd("api", "printf 'SECRET=1\\n' > .env")
	project.SetSetup("api", "sh -c '. ./.env; test -n \"$SECRET\"'")
	ref := Ref{Workspace: "ws", Worktree: "wrk2"}
	if err := AddWorktree("ws", "wrk2", CheckoutOptions{Install: true}); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(stepsOf(t, ref), ","); got != "api:checkout,api:env: printf 'SECRET=1\\n' > .env,api:sh -c '. ./.env; test -n \"$SECRET\"'" {
		t.Errorf("steps = %s", got)
	}
	if data, err := os.ReadFile(filepath.Join(WorktreePath(ref, "api"), ".env")); err != nil || string(data) != "SECRET=1\n" {
		t.Errorf(".env = %q, %v", data, err)
	}
	if h := recorded(t, ref); h != nil {
		t.Errorf("health = %+v", h)
	}

	// The sibling's .env is copied in first; the command overwrites it.
	project.SetEnvCmd("api", "printf 'SECRET=2\\n' > .env")
	project.SetSetup("api", "")
	if err := AddWorktree("ws", "wrk5", CheckoutOptions{Install: true}); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(filepath.Join(WorktreePath(Ref{Workspace: "ws", Worktree: "wrk5"}, "api"), ".env")); string(data) != "SECRET=2\n" {
		t.Errorf("the env command must run over the copied .env, got %q", data)
	}

	project.SetSetup("api", "sh -c '. ./.env; test -n \"$SECRET\"'")
	project.SetEnvCmd("api", "sh -c 'echo sops: no key >&2; exit 2'")
	if err := AddWorktree("ws", "wrk3", CheckoutOptions{Install: true}); err != nil {
		t.Fatal(err)
	}
	ref3 := Ref{Workspace: "ws", Worktree: "wrk3"}
	h := recorded(t, ref3)
	if h == nil || h.Summary() != "install failed: api" || !strings.HasPrefix(h.Issues[0].Detail, "env: sh -c") || !strings.Contains(h.Issues[0].Detail, "sops: no key") {
		t.Errorf("health after a failed env command = %+v", h)
	}
	if got := strings.Join(stepsOf(t, ref3), ","); strings.Contains(got, "test -n") {
		t.Errorf("the install must not run after the env command failed: %s", got)
	}

	if err := AddWorktree("ws", "wrk4", CheckoutOptions{}); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(stepsOf(t, Ref{Workspace: "ws", Worktree: "wrk4"}), ","); got != "api:checkout" {
		t.Errorf("--no-install must skip the env command too: %s", got)
	}
}
