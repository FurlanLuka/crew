package workspace

import (
	"errors"
	"fmt"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// checkFixture is one pool project with a git repo and the given setup
// command; the ref its check answers to comes back.
func checkFixture(t *testing.T, setup string) Ref {
	t.Helper()
	tmp := setupTestConfig(t)
	repo := filepath.Join(tmp, "repos", "api")
	os.MkdirAll(repo, 0o755)
	initRepo(t, repo)
	project.Add(project.Project{Name: "api", Path: repo, Setup: setup})
	return CheckRef("api")
}

func gitLines(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := exec.RunGitCommand(dir, args...)
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return out
}

// check is the reserved workspace half of a check ref: parseable as a
// ref, never creatable as a workspace.
func TestCheckRef_ReservedNotUnparseable(t *testing.T) {
	setupTestConfig(t)
	ref, err := ParseRef("check/api")
	if err != nil || !IsCheck(ref) || ref.Worktree != "api" {
		t.Fatalf("ParseRef(check/api) = %+v, %v", ref, err)
	}
	if err := Create(CheckWorkspace); err == nil || !strings.Contains(err.Error(), "reserved") {
		t.Errorf("Create(check) = %v, want reserved", err)
	}
	project.Add(project.Project{Name: "a--b", Path: t.TempDir()})
	if err := StartCheck("a--b", CheckoutOptions{}); err == nil || !strings.Contains(err.Error(), "cannot be checked") {
		t.Errorf("StartCheck(a--b) = %v", err)
	}
	if err := StartCheck("nope", CheckoutOptions{}); err == nil || !strings.Contains(err.Error(), "not found in pool") {
		t.Errorf("StartCheck(unknown) = %v", err)
	}
}

// Every ref-keyed write on a check lands in its record, never in a
// workspace file called check.
func TestCheckStore_RecordNotWorkspaceFile(t *testing.T) {
	ref := checkFixture(t, "exit 3")
	if err := StartCheck("api", CheckoutOptions{Install: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(checkFile("api")); err != nil {
		t.Fatal("the record should be on disk")
	}
	if _, err := os.Stat(config.WorkspaceFile(CheckWorkspace)); !os.IsNotExist(err) {
		t.Error("a check must not write workspaces/check.json")
	}
	if err := updateFor(ref, func(ws *Workspace) error {
		ws.Worktrees[0].Overrides = map[string]string{"X": "1"}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	c, err := loadCheck("api")
	if err != nil || c.Worktree.Overrides["X"] != "1" {
		t.Errorf("updateFor should write the record's worktree half: %+v, %v", c, err)
	}
	res, err := Resolve(ref)
	if err != nil || len(res.Projects) != 1 || res.Projects[0].Path != WorktreePath(ref, "api") || res.Health == nil {
		t.Errorf("Resolve(check/api) = %+v, %v", res, err)
	}
	names, _ := List()
	if len(names) != 0 {
		t.Errorf("List() must not see the check: %v", names)
	}
	sums, _ := ListSummaries()
	if len(sums) != 0 {
		t.Errorf("ListSummaries() must not see the check: %+v", sums)
	}
	if !Addressable(ref) || Addressable(CheckRef("other")) || Addressable(Ref{Workspace: CheckWorkspace}) {
		t.Error("Addressable: a kept check yes, an unknown or bare check no")
	}
	if _, err := loadFor(Ref{Workspace: CheckWorkspace}); err == nil || !strings.Contains(err.Error(), "say which check") {
		t.Errorf("loadFor(check) = %v", err)
	}
}

// A pass takes the target away — checkout, branch, record — and leaves
// the result files so a later poll still sees the ✓ table.
func TestCheck_PassRemovesTarget(t *testing.T) {
	ref := checkFixture(t, "true")
	project.SetEnvCmd("api", "printf 'A=1\\n' > .env")
	repo := project.Get("api").Path
	if err := StartCheck("api", CheckoutOptions{Install: true, Smoke: true}); err != nil {
		t.Fatal(err)
	}
	checkout := WorktreePath(ref, "api")
	if _, err := os.Stat(filepath.Join(checkout, ".env")); err != nil {
		t.Fatal("the runner should have made the checkout and run the env command in it")
	}
	for i := 0; i < 2; i++ {
		st, err := SetupStatus(ref)
		if err != nil || st.ExitCode() != 0 {
			t.Fatalf("SetupStatus #%d = %+v, %v", i, st, err)
		}
	}
	if got := strings.Join(stepsOf(t, ref), ","); got != "api:checkout,api:true,api:env: printf 'A=1\\n' > .env" {
		t.Errorf("steps kept after the pass = %s", got)
	}
	if _, err := os.Stat(checkout); !os.IsNotExist(err) {
		t.Error("the checkout should be gone")
	}
	if _, err := os.Stat(checkFile("api")); !os.IsNotExist(err) {
		t.Error("the record should be gone")
	}
	if CheckExists("api") || Addressable(ref) {
		t.Error("a passed check is not addressable")
	}
	if wl := gitLines(t, repo, "worktree", "list", "--porcelain"); strings.Contains(wl, checkout) || strings.Count(wl, "worktree ") != 1 {
		t.Errorf("git worktree list still has the check: %s", wl)
	}
	if b := gitLines(t, repo, "branch", "--list", BranchName(ref, "api")); strings.TrimSpace(b) != "" {
		t.Errorf("the scratch branch should be deleted: %q", b)
	}
	entries, _ := os.ReadDir(config.TrashDir)
	if len(entries) == 0 {
		t.Error("the checkout goes to the trash, never rm'd inline")
	}
}

// A failure keeps the target with its evidence, listed as a worktree row,
// until a re-check replaces it from nothing or it is removed by hand.
func TestCheck_FailKeepsThenReplaced(t *testing.T) {
	ref := checkFixture(t, "sh -c 'echo no compiler >&2; exit 3'")
	repo := project.Get("api").Path
	if err := StartCheck("api", CheckoutOptions{Install: true}); err != nil {
		t.Fatal(err)
	}
	st, err := SetupStatus(ref)
	if err != nil || st.ExitCode() != 1 {
		t.Fatalf("SetupStatus = %+v, %v", st, err)
	}
	h := recorded(t, ref)
	if h == nil || h.Summary() != "install failed: api" || !strings.Contains(h.Issues[0].Detail, "no compiler") {
		t.Fatalf("health = %+v", h)
	}
	if _, err := os.Stat(WorktreePath(ref, "api")); err != nil {
		t.Error("a failed check keeps its checkout")
	}
	logs, err := SetupLogs(ref, "api", 0)
	if err != nil || !strings.Contains(logs, "no compiler") {
		t.Errorf("SetupLogs = %q, %v", logs, err)
	}
	checks, _ := ListChecks()
	if len(checks) != 1 || checks[0].Project != "api" {
		t.Fatalf("ListChecks = %+v", checks)
	}
	sm := CheckSummary(checks[0])
	if sm.Name != "check/api" || sm.Health != "install failed: api" || sm.Path != WorktreeDir(ref) {
		t.Errorf("CheckSummary = %+v", sm)
	}
	if sums, _ := ListSummaries(); len(sums) != 0 {
		t.Errorf("ListSummaries must still not see it: %+v", sums)
	}
	res, _ := Resolve(ref)
	if p := RenderFixPrompt(res, h, ""); !strings.Contains(p, "no compiler") || !strings.Contains(p, "check/api") {
		t.Errorf("fix prompt:\n%s", p)
	}

	// The base moves, the setup is fixed: the re-check starts from nothing
	// and lands on the new tip.
	commitOn(t, repo, "fix")
	head := strings.TrimSpace(gitLines(t, repo, "rev-parse", "HEAD"))
	project.SetSetup("api", "true")
	if err := StartCheck("api", CheckoutOptions{Install: true}); err != nil {
		t.Fatal(err)
	}
	checkout := WorktreePath(ref, "api")
	if got := strings.TrimSpace(gitLines(t, checkout, "rev-parse", "HEAD")); got != head {
		t.Errorf("re-check HEAD = %s, want the moved base %s", got, head)
	}
	if st, _ := SetupStatus(ref); st.ExitCode() != 0 {
		t.Errorf("after the fix: %+v", st)
	}
	if CheckExists("api") {
		t.Error("the passing re-check should remove the target")
	}
}

// --no-smoke: the checkout is the only step, no server window is opened,
// and the record still carries the port the server would have had.
func TestCheck_NoSmokeSkipsServers(t *testing.T) {
	ref := checkFixture(t, "")
	project.AddDevServer("api", project.DevServer{Name: "web", Command: "sleep 30", Port: 3000})
	if err := StartCheck("api", CheckoutOptions{Install: true, Smoke: false}); err != nil {
		t.Fatal(err)
	}
	if c, err := loadCheck("api"); err != nil || c.Worktree.Ports["api/web"] == 0 {
		t.Errorf("a check reserves its ports like a worktree: %+v, %v", c, err)
	}
	if got := strings.Join(stepsOf(t, ref), ","); got != "api:checkout" {
		t.Errorf("steps = %s, want the checkout alone", got)
	}
	if exec.TmuxSessionExists(dev.SetupSessionName(ref.Slug())) {
		t.Error("no smoke, no setup session")
	}
	st, _ := SetupStatus(ref)
	if !st.Passed() || CheckExists("api") {
		t.Errorf("a no-smoke check still passes and is removed: %+v", st)
	}
}

// crew verify check/<name> re-runs a kept check in place: the checkout is
// reused, and a pass removes the target like a fresh check would.
func TestVerify_OnCheckReusesCheckoutAndRemoves(t *testing.T) {
	ref := checkFixture(t, "exit 3")
	if err := StartCheck("api", CheckoutOptions{Install: true}); err != nil {
		t.Fatal(err)
	}
	SetupStatus(ref)
	project.SetSetup("api", "true")
	res, err := Resolve(ref)
	if err != nil {
		t.Fatal(err)
	}
	if err := Verify(res, CheckoutOptions{Install: true}, nil); err != nil {
		t.Fatal(err)
	}
	st, _ := SetupStatus(ref)
	if !st.Passed() {
		t.Fatalf("verify should pass: %+v", st)
	}
	if got := strings.Join(stepsOf(t, ref), ","); got != "api:true" {
		t.Errorf("verify reuses the checkout: steps = %s", got)
	}
	if CheckExists("api") {
		t.Error("a passing verify removes the target")
	}
}

// A checkout or a scratch branch left behind without a record (a crash
// between teardown and the record write) is taken away before the new
// check starts — a stale branch would be reused at its old tip otherwise.
func TestStartCheck_ReplacesLeftoverCheckout(t *testing.T) {
	ref := checkFixture(t, "")
	repo := project.Get("api").Path
	leftover := WorktreePath(ref, "api")
	os.MkdirAll(leftover, 0o755)
	os.WriteFile(filepath.Join(leftover, "marker"), nil, 0o644)
	gitLines(t, repo, "branch", BranchName(ref, "api"))
	commitOn(t, repo, "moved")
	head := strings.TrimSpace(gitLines(t, repo, "rev-parse", "HEAD"))
	if err := StartCheck("api", CheckoutOptions{}); err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(gitLines(t, leftover, "rev-parse", "HEAD")); got != head {
		t.Errorf("the stale branch was reused: HEAD %s, want the moved base %s", got, head)
	}
	if _, err := os.Stat(filepath.Join(leftover, "marker")); !os.IsNotExist(err) {
		t.Error("the leftover should have gone to the trash")
	}
	if _, err := os.Stat(filepath.Join(leftover, ".git")); err != nil {
		t.Error("a fresh git worktree should be in its place")
	}
	if entries, _ := os.ReadDir(config.TrashDir); len(entries) == 0 {
		t.Error("the leftover goes through the trash")
	}
}

// waitRunnersGone returns the moment the runner's pid is gone, and at the
// bound when it is not.
func TestWaitRunnersGone(t *testing.T) {
	ref := checkFixture(t, "")
	slug := ref.Slug()
	os.MkdirAll(SetupDir(slug), 0o755)
	child := osexec.Command("sleep", "0.3")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	writeResult(resultFile(slug, "api"), RunResult{PID: child.Process.Pid, Done: true})
	// Reaped as it exits — a zombie still answers kill(pid, 0), and a real
	// runner's parent is tmux, which reaps at once.
	go child.Wait()
	start := time.Now()
	waitRunnersGone(ref, 2*time.Second)
	if took := time.Since(start); took > time.Second {
		t.Errorf("should return as the runner exits, took %s", took)
	}

	long := osexec.Command("sleep", "10")
	if err := long.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { long.Process.Kill(); long.Wait() }()
	writeResult(resultFile(slug, "api"), RunResult{PID: long.Process.Pid, Done: true})
	start = time.Now()
	waitRunnersGone(ref, 300*time.Millisecond)
	if took := time.Since(start); took < 300*time.Millisecond || took > time.Second {
		t.Errorf("should give up at the bound, took %s", took)
	}
}

// The page opened on a check: a target that is gone means the check
// passed, and the page's last word is the pass line.
func TestWorktreeView_CheckPassed(t *testing.T) {
	setupTestConfig(t)
	v := NewWorktreeView(CheckRef("api"))
	msg := v.loadWith(false)()
	if _, ok := msg.(checkPassedMsg); !ok {
		t.Fatalf("a gone check loads as checkPassedMsg, got %T", msg)
	}
	if msg := NewWorktreeView(Ref{Workspace: "ws", Worktree: "wt"}).loadWith(false)(); msg == nil {
		t.Fatal("no message")
	} else if _, ok := msg.(errMsg); !ok {
		t.Errorf("a missing workspace is an error, got %T", msg)
	}
	_, cmd := v.Update(checkPassedMsg{project: "api"})
	if cmd == nil {
		t.Fatal("checkPassedMsg should exit")
	}
	if out, ok := cmd().(app.ExitWithOutputMsg); !ok || out.Output != CheckPassedLine("api") {
		t.Errorf("exit message = %+v", cmd())
	}
}

// A real smoke on a check: a server that runs and nobody points at passes
// and the target goes with its session; one the project's own binding
// points at but that never listens keeps the target.
func TestCheck_SmokeVerdicts(t *testing.T) {
	if !exec.HasTmux() {
		t.Skip("tmux not available")
	}
	name := fmt.Sprintf("api%d", os.Getpid())
	tmp := setupTestConfig(t)
	repo := filepath.Join(tmp, "repos", name)
	os.MkdirAll(repo, 0o755)
	initRepo(t, repo)
	project.Add(project.Project{Name: name, Path: repo})
	project.AddDevServer(name, project.DevServer{Name: "web", Command: "sleep 30", Port: 3000})
	shortCeiling(t)
	ref := CheckRef(name)
	t.Cleanup(func() { exec.KillTmuxSession(dev.SetupSessionName(ref.Slug())) })

	if err := StartCheck(name, CheckoutOptions{Smoke: true}); err != nil {
		t.Fatal(err)
	}
	st, _ := SetupStatus(ref)
	if !st.Passed() || CheckExists(name) {
		t.Fatalf("an idle server nobody points at passes: %+v", st)
	}
	if exec.TmuxSessionExists(dev.SetupSessionName(ref.Slug())) {
		t.Error("the setup session goes with the pass")
	}

	project.AddBinding(name, project.Binding{Var: "API_URL", Value: "{{" + name + "/web}}"})
	if err := StartCheck(name, CheckoutOptions{Smoke: true}); err != nil {
		t.Fatal(err)
	}
	st, _ = SetupStatus(ref)
	if st.Passed() || !CheckExists(name) {
		t.Fatalf("a referenced server that never listens keeps the target: %+v", st)
	}
	if h := recorded(t, ref); h == nil || h.Summary() != "server not listening: "+name+"/web" {
		t.Errorf("health = %+v", h)
	}
}

// A running check refuses a second start; WaitSetup returns after the
// pass has removed the target.
func TestStartCheck_WhileRunningAndWait(t *testing.T) {
	ref := checkFixture(t, "sleep 1")
	backgroundRunners(t)
	if err := StartCheck("api", CheckoutOptions{Install: true}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for !SetupRunning(ref) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if err := StartCheck("api", CheckoutOptions{}); !errors.Is(err, ErrSetupRunning) {
		t.Errorf("second StartCheck = %v, want ErrSetupRunning", err)
	}
	st, err := WaitSetup(ref)
	if err != nil || st.ExitCode() != 0 {
		t.Fatalf("WaitSetup = %+v, %v", st, err)
	}
	if CheckExists("api") {
		t.Error("the target should be gone when WaitSetup returns")
	}
}

func TestRemoveCheck(t *testing.T) {
	ref := checkFixture(t, "exit 3")
	repo := project.Get("api").Path
	if err := RemoveCheck("api"); err == nil {
		t.Error("removing an unknown check should fail")
	}
	if err := StartCheck("api", CheckoutOptions{Install: true}); err != nil {
		t.Fatal(err)
	}
	SetupStatus(ref)
	if err := RemoveWorktree(CheckWorkspace, "api"); err != nil {
		t.Fatal(err)
	}
	if CheckExists("api") {
		t.Error("record should be gone")
	}
	if _, err := os.Stat(WorktreePath(ref, "api")); !os.IsNotExist(err) {
		t.Error("checkout should be gone")
	}
	if _, err := os.Stat(SetupDir(ref.Slug())); !os.IsNotExist(err) {
		t.Error("a removal by hand takes the setup files too")
	}
	if b := gitLines(t, repo, "branch", "--list", BranchName(ref, "api")); strings.TrimSpace(b) != "" {
		t.Errorf("branch should be deleted: %q", b)
	}
}

// A clone whose only branch is master (most of what gh repo list returns)
// checks out on master, not a detached HEAD.
func TestDetectDefaultBranch_OriginHead(t *testing.T) {
	setupTestConfig(t)
	tmp := t.TempDir()
	seed := filepath.Join(tmp, "seed")
	os.MkdirAll(seed, 0o755)
	initRepo(t, seed)
	gitLines(t, seed, "branch", "-M", "master")
	remote := filepath.Join(tmp, "origin.git")
	gitLines(t, tmp, "clone", "--bare", "-q", seed, remote)
	clone := filepath.Join(tmp, "api")
	gitLines(t, tmp, "clone", "-q", remote, clone)
	if got := DefaultBranch(clone); got != "master" {
		t.Errorf("DefaultBranch = %s, want master", got)
	}
	if got := DefaultBranch(seed); got != "HEAD" {
		t.Errorf("no origin, no main: %s, want HEAD", got)
	}
}
