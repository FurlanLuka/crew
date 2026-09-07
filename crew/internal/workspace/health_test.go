package workspace

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

func TestHealthSummaryAndIssues(t *testing.T) {
	if healthOf(nil) != nil {
		t.Error("no issues should be nil health")
	}
	one := healthOf([]Issue{{Stage: StageInstall, Project: "api", Detail: "uv sync: no solution"}})
	if one.Summary() != "install failed: api" {
		t.Errorf("Summary = %q", one.Summary())
	}
	if got := healthOf([]Issue{{Stage: StageCheckout, Project: "web"}}).Summary(); got != "checkout failed: web" {
		t.Errorf("checkout Summary = %q", got)
	}
	if got := healthOf(smokeIssues([]SmokeResult{
		{Project: "api", Server: "api", Alive: true},
		{Project: "web", Server: "web", Alive: false, Tail: "short", Evidence: "trace\nError: X is not set"},
	})); got.Summary() != "server died: web/web" || got.Issues[0].Detail != "trace\nError: X is not set" {
		t.Errorf("smoke health = %+v", got)
	}
	if len(smokeIssues([]SmokeResult{{Project: "api", Server: "api", Alive: true}})) != 0 {
		t.Error("all alive should be no issues")
	}
	many := healthOf([]Issue{{Stage: StageCheckout, Project: "a"}, {Stage: StageSmoke, Project: "b", Server: "b"}})
	if many.Summary() != "2 issues" {
		t.Errorf("Summary for two = %q", many.Summary())
	}
	var none *Health
	if none.Summary() != "" {
		t.Error("nil Summary should be empty")
	}
	if got := many.installIssues(); len(got) != 0 {
		t.Errorf("installIssues = %v", got)
	}
	if got := one.installIssues(); !got["api"] {
		t.Errorf("installIssues = %v", got)
	}
}

// The shape an unreleased build wrote — stage on top, none on the issues —
// still reads, with the stage where it lives now.
func TestHealthUnmarshal_BackFillsStage(t *testing.T) {
	var h Health
	if err := json.Unmarshal([]byte(`{"stage":"smoke","at":"2026-09-07T10:00:00Z","issues":[{"project":"api","server":"api","detail":"x"}]}`), &h); err != nil {
		t.Fatal(err)
	}
	if len(h.Issues) != 1 || h.Issues[0].Stage != StageSmoke || h.Summary() != "server died: api/api" {
		t.Errorf("unmarshalled = %+v", h)
	}
	var fresh Health
	json.Unmarshal([]byte(`{"at":"2026-09-07T10:00:00Z","issues":[{"stage":"checkout","project":"web","detail":"x"}]}`), &fresh)
	if fresh.Issues[0].Stage != StageCheckout {
		t.Errorf("current shape = %+v", fresh)
	}
}

func TestRecordHealth_RoundTripsAndClears(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	ref := Ref{Workspace: "ws", Worktree: DefaultWorktree}

	h := &Health{At: time.Now(), Issues: []Issue{{Stage: StageSmoke, Project: "api", Server: "api", Detail: "boom"}}}
	if err := RecordHealth(ref, h); err != nil {
		t.Fatal(err)
	}
	res, _ := Resolve(ref)
	if res.Health == nil || res.Health.Issues[0].Detail != "boom" {
		t.Fatalf("Resolved.Health = %+v", res.Health)
	}
	data, _ := os.ReadFile(config.WorkspaceFile("ws"))
	if !strings.Contains(string(data), `"health"`) {
		t.Error("health should be in the workspace file")
	}

	if err := ClearHealth(ref); err != nil {
		t.Fatal(err)
	}
	res, _ = Resolve(ref)
	if res.Health != nil {
		t.Error("ClearHealth should remove it")
	}
	data, _ = os.ReadFile(config.WorkspaceFile("ws"))
	if strings.Contains(string(data), `"health"`) {
		t.Error("cleared health should not be in the file")
	}
}

// The reload discipline: a health write after a sibling's override write
// keeps both, even though the caller of RecordHealth loaded nothing itself.
func TestRecordHealth_KeepsSiblingWrites(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	if _, err := AddWorktree("ws", "wrk2", CheckoutOptions{}); err != nil {
		t.Fatal(err)
	}
	main, wrk2 := Ref{Workspace: "ws", Worktree: DefaultWorktree}, Ref{Workspace: "ws", Worktree: "wrk2"}

	if err := SetOverride(wrk2, "K", "v"); err != nil {
		t.Fatal(err)
	}
	if err := RecordHealth(main, &Health{At: time.Now(), Issues: []Issue{{Stage: StageInstall, Project: "api"}}}); err != nil {
		t.Fatal(err)
	}
	ws, _ := Load("ws")
	if got, _ := selectWorktree(ws, "wrk2"); got.Overrides["K"] != "v" {
		t.Error("the sibling's override was lost")
	}
	if got, _ := selectWorktree(ws, DefaultWorktree); got.Health == nil {
		t.Error("health was not recorded")
	}
}

func TestSetupFailureRecordsHealthAndPassClears(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	project.SetSetup("api", "exit 7")
	ref := Ref{Workspace: "ws", Worktree: "wrk2"}

	h, err := AddWorktree("ws", "wrk2", CheckoutOptions{Install: true})
	if err != nil {
		t.Fatalf("a failed install is not an error any more: %v", err)
	}
	if h == nil || h.Issues[0].Stage != StageInstall || h.Issues[0].Project != "api" {
		t.Fatalf("Health after a failed install = %+v", h)
	}
	res, _ := Resolve(ref)
	if res.Health == nil || res.Health.Summary() != "install failed: api" {
		t.Fatalf("recorded = %+v", res.Health)
	}

	project.SetSetup("api", "true")
	result, err := Setup(ref, CheckoutOptions{Install: true})
	if err != nil {
		t.Fatal(err)
	}
	if result.Health != nil {
		t.Errorf("a passing install should clear, got %+v", result.Health)
	}
	res, _ = Resolve(ref)
	if res.Health != nil {
		t.Errorf("cleared on disk too, got %+v", res.Health)
	}
}

// A project that cannot be checked out is a recorded issue, not a rollback:
// the sibling's checkout stays, the worktree is listed, and nothing is left
// behind for the retry to trip on.
func TestAddWorktree_CheckoutFailureIsRecorded(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	ws, _ := Load("ws")
	ws.Projects = append(ws.Projects, WorkspaceProject{Name: "ghost", Role: "x"})
	Save(ws)

	h, err := AddWorktree("ws", "wrk2", CheckoutOptions{})
	if err != nil {
		t.Fatalf("err = %v, want none", err)
	}
	ref := Ref{Workspace: "ws", Worktree: "wrk2"}
	if _, err := os.Stat(filepath.Join(WorktreePath(ref, "api"), ".git")); err != nil {
		t.Error("api's checkout should exist")
	}
	if _, err := os.Stat(WorktreePath(ref, "ghost")); !os.IsNotExist(err) {
		t.Error("ghost left a directory behind")
	}
	if h == nil || h.Summary() != "checkout failed: ghost" || !strings.Contains(h.Issues[0].Detail, "not in the project pool") {
		t.Errorf("Health = %+v", h)
	}
	loaded, _ := Load("ws")
	if _, err := selectWorktree(loaded, "wrk2"); err != nil {
		t.Error("worktree should be recorded")
	}
}

// Verify finishes what is missing: a checkout that failed before is made
// now, and a project with a recorded install failure is installed again.
func TestVerify_FinishesMissingCheckoutsAndInstalls(t *testing.T) {
	if !exec.HasTmux() {
		t.Skip("tmux not available")
	}
	newRepoWorkspace(t, "ws", "api", "web")
	project.AddDevServer("api", project.DevServer{Name: "api", Port: 3000, Command: "sleep 30"})
	ref := Ref{Workspace: "ws", Worktree: "wrk2"}
	t.Cleanup(func() { dev.StopAll("ws--wrk2") })

	// Make the worktree with web's checkout removed and an install issue on api.
	if _, err := AddWorktree("ws", "wrk2", CheckoutOptions{}); err != nil {
		t.Fatal(err)
	}
	cleanupWorktree(ref, WorkspaceProject{Name: "web"})
	RecordHealth(ref, &Health{At: time.Now(), Issues: []Issue{
		{Stage: StageCheckout, Project: "web", Detail: "x"},
		{Stage: StageInstall, Project: "api", Detail: "x"},
	}})
	installed := map[string]bool{}
	project.SetSetup("api", "true")
	project.SetSetup("web", "true")

	res, _ := Resolve(ref)
	result, err := Verify(res, CheckoutOptions{Install: true, Progress: func(p string, r exec.SetupResult) {
		if r.Step.Name != "checkout" && !strings.HasPrefix(r.Step.Name, "smoke") {
			installed[p] = true
		}
	}})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if _, err := os.Stat(filepath.Join(WorktreePath(ref, "web"), ".git")); err != nil {
		t.Error("web should have been checked out by verify")
	}
	if !installed["api"] || !installed["web"] {
		t.Errorf("installs ran for %v, want api (recorded) and web (just made)", installed)
	}
	if result.Health != nil {
		t.Errorf("everything passed, got %+v", result.Health)
	}
	if res.Health != nil {
		t.Error("the caller's Resolved should be updated")
	}
}

func fixFixture(t *testing.T) *Resolved {
	t.Helper()
	newRepoWorkspace(t, "phone-speak", "speak-api")
	project.AddDevServer("speak-api", project.DevServer{Name: "speak-api", Port: 3000, Command: "npm start"})
	res, err := Resolve(Ref{Workspace: "phone-speak", Worktree: DefaultWorktree})
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestRenderFixPrompt_Golden(t *testing.T) {
	res := fixFixture(t)
	h := &Health{Issues: []Issue{
		{Stage: StageCheckout, Project: "gcp-infra", Detail: "fatal: a branch named 'crew/phone-speak/main/gcp-infra' already exists"},
		{Stage: StageSmoke, Project: "speak-api", Server: "speak-api", Detail: "  at loadConfig (src/config.ts:12)\nError: SPEAK_DB_URL is not set"},
	}}
	got := RenderFixPrompt(res, h, "  speak-api\n    API_URL  left alone — tutor not in workspace\n")
	orientation := RenderPrompt(res, directBranches(res))
	if !strings.HasPrefix(got, orientation) {
		t.Fatalf("the fix prompt must start with the orientation prompt:\n%s", got)
	}
	want := strings.Join([]string{
		"",
		"## What failed",
		"",
		"Creating this worktree ran every step it could; these did not go through:",
		"",
		"gcp-infra — the git checkout failed:",
		"    fatal: a branch named 'crew/phone-speak/main/gcp-infra' already exists",
		"",
		"speak-api/speak-api — the server died within seconds of starting:",
		"      at loadConfig (src/config.ts:12)",
		"    Error: SPEAK_DB_URL is not set",
		"",
		"Env anomalies for this worktree (bindings crew could not resolve — a plain var missing from .env shows in the log above, not here):",
		"    speak-api",
		"    API_URL  left alone — tutor not in workspace",
		"",
		"Fix the cause in this checkout — .env, an override (crew add override phone-speak/main VAR=value), code, or git — then run: crew verify phone-speak/main",
		"verify checks out anything still missing, re-runs the installs that failed, starts the servers and records what it finds; the worktree page stays locked until it passes.",
		"",
	}, "\n")
	if tail := strings.TrimPrefix(got, orientation); tail != want {
		t.Errorf("fix prompt tail =\n%s\nwant\n%s", tail, want)
	}
	got = strings.TrimPrefix(RenderFixPrompt(res, &Health{Issues: []Issue{{Stage: StageInstall, Project: "speak-api", Detail: "make sync:\nuv sync: No solution found"}}}, ""), orientation)
	if !strings.Contains(got, "speak-api — the install failed:\n    make sync:\n    uv sync: No solution found") || strings.Contains(got, "Env anomalies") {
		t.Errorf("install prompt =\n%s", got)
	}
}

// A single-project worktree gets the fix prompt too: the orientation prompt's
// gate does not apply to a failure.
func TestFixCommand_AlwaysPassesThePrompt(t *testing.T) {
	if !exec.HasClaude() {
		t.Skip("claude not installed")
	}
	res := fixFixture(t)
	if NeedsPrompt(res) {
		t.Fatal("fixture should be a single, non-direct project")
	}
	if _, err := FixCommand(res, ""); err == nil {
		t.Error("nothing recorded must be refused")
	}
	res.Health = &Health{Issues: []Issue{{Stage: StageSmoke, Project: "speak-api", Server: "speak-api", Detail: "died"}}}
	cmd, err := FixCommand(res, "")
	if err != nil {
		t.Fatal(err)
	}
	script := strings.Join(cmd.Args, " ")
	if !strings.Contains(script, "$(cat ") || !strings.Contains(script, PromptFilePath(res.Ref)) {
		t.Errorf("fix command does not pass the prompt: %s", script)
	}
	data, _ := os.ReadFile(PromptFilePath(res.Ref))
	if !strings.Contains(string(data), "## What failed") {
		t.Error("prompt file should hold the fix prompt")
	}
}

func TestVerify_RecordsADeathAndRefusesWhileRunning(t *testing.T) {
	if !exec.HasTmux() {
		t.Skip("tmux not available")
	}
	newRepoWorkspace(t, "ws", "api")
	// A server that prints why and exits: the evidence is the log tail.
	project.AddDevServer("api", project.DevServer{Name: "api", Port: 3000, Command: "sh -c 'echo trace line; echo Error: DB_URL is not set; exit 1'"})
	ref := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	t.Cleanup(func() { dev.StopAll("ws--main") })

	res, _ := Resolve(ref)
	result, err := Verify(res, CheckoutOptions{})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if len(SmokeFailures(result.Smoke)) != 1 {
		t.Fatalf("results = %+v, want one death", result.Smoke)
	}
	res, _ = Resolve(ref)
	if res.Health == nil || res.Health.Issues[0].Stage != StageSmoke || !strings.Contains(res.Health.Issues[0].Detail, "DB_URL is not set") {
		t.Fatalf("Health after a death = %+v", res.Health)
	}

	// Fixed: a server that stays up clears it.
	project.AddDevServer("api", project.DevServer{Name: "api", Port: 3000, Command: "sleep 30"})
	res, _ = Resolve(ref)
	if _, err := Verify(res, CheckoutOptions{}); err != nil {
		t.Fatal(err)
	}
	res, _ = Resolve(ref)
	if res.Health != nil {
		t.Errorf("a passing verify should clear health, got %+v", res.Health)
	}

	// Running servers: verify refuses rather than restarting them.
	if _, err := StartDev(res, true, false); err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(res, CheckoutOptions{}); !errors.Is(err, ErrServersRunning) {
		t.Errorf("Verify while running = %v, want ErrServersRunning", err)
	}
	if !dev.Running(res.Slug) {
		t.Error("the refused verify must leave the session alone")
	}
}

func TestWorktreeListShowsHealth(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	ref := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	RecordHealth(ref, &Health{At: time.Now(), Issues: []Issue{{Stage: StageSmoke, Project: "api", Server: "api", Detail: "x"}}})

	summaries, _ := ListSummaries()
	if len(summaries) != 1 || summaries[0].Health != "server died: api/api" {
		t.Errorf("summaries = %+v", summaries)
	}
}

// Creation smokes when asked, and what it finds is on the worktree it
// returns — the page opens on exactly that.
func TestAddWorktree_SmokeDeathIsRecorded(t *testing.T) {
	if !exec.HasTmux() {
		t.Skip("tmux not available")
	}
	newRepoWorkspace(t, "ws", "api")
	project.AddDevServer("api", project.DevServer{Name: "api", Port: 3000, Command: "sh -c 'echo Error: DB_URL is not set; exit 1'"})
	t.Cleanup(func() { dev.StopAll("ws--wrk2") })

	var steps []string
	h, err := AddWorktree("ws", "wrk2", CheckoutOptions{Smoke: true, Progress: func(p string, r exec.SetupResult) {
		steps = append(steps, p+":"+r.Step.Name)
	}})
	if err != nil {
		t.Fatal(err)
	}
	if h == nil || h.Summary() != "server died: api/api" || !strings.Contains(h.Issues[0].Detail, "DB_URL is not set") {
		t.Errorf("Health = %+v", h)
	}
	if strings.Join(steps, ",") != "api:checkout,api:smoke api" {
		t.Errorf("steps = %v", steps)
	}
	res, _ := Resolve(Ref{Workspace: "ws", Worktree: "wrk2"})
	if res.Health == nil {
		t.Error("recorded on the worktree")
	}
}

// A duplicate carries the source's overrides and the creation's verdict.
func TestDuplicateWorktree_CarriesHealth(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	src := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	SetOverride(src, "K", "v")
	project.SetSetup("api", "exit 5")

	h, err := DuplicateWorktree(src, "wrk2", CheckoutOptions{Install: true})
	if err != nil {
		t.Fatal(err)
	}
	if h == nil || h.Summary() != "install failed: api" {
		t.Errorf("Health = %+v", h)
	}
	res, _ := Resolve(Ref{Workspace: "ws", Worktree: "wrk2"})
	if res.Overrides["K"] != "v" || res.Health == nil {
		t.Errorf("overrides=%v health=%+v", res.Overrides, res.Health)
	}
}

func TestSetup_RefusesWhileServersRun(t *testing.T) {
	if !exec.HasTmux() {
		t.Skip("tmux not available")
	}
	newRepoWorkspace(t, "ws", "api")
	project.AddDevServer("api", project.DevServer{Name: "api", Port: 3000, Command: "sleep 30"})
	ref := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	t.Cleanup(func() { dev.StopAll("ws--main") })
	res, _ := Resolve(ref)
	if _, err := StartDev(res, true, false); err != nil {
		t.Fatal(err)
	}
	if _, err := Setup(ref, CheckoutOptions{Install: true, Smoke: true}); !errors.Is(err, ErrServersRunning) {
		t.Errorf("Setup with smoke while running = %v", err)
	}
	if !dev.Running(res.Slug) {
		t.Error("the refused setup must leave the session alone")
	}
	if _, err := Setup(ref, CheckoutOptions{Install: true}); err != nil {
		t.Errorf("Setup without smoke should proceed: %v", err)
	}
}
