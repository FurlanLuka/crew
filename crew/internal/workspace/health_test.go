package workspace

import (
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

func TestHealthFromSetupAndSmoke(t *testing.T) {
	serr := &SetupError{Errors: []error{
		&ProjectSetupError{Project: "api", Err: errors.New("uv sync: no solution")},
		errors.New("something without a project"),
	}}
	h := HealthFromSetup(serr)
	if h.Stage != StageInstall || len(h.Issues) != 2 || h.Issues[0].Project != "api" || h.Issues[0].Detail != "uv sync: no solution" || h.Issues[1].Project != "" {
		t.Errorf("HealthFromSetup = %+v", h)
	}
	if h.Summary() != "install failed" {
		t.Errorf("Summary = %q", h.Summary())
	}

	if HealthFromSmoke([]SmokeResult{{Project: "api", Server: "api", Alive: true}}) != nil {
		t.Error("all alive should be nil")
	}
	h = HealthFromSmoke([]SmokeResult{
		{Project: "api", Server: "api", Alive: true},
		{Project: "web", Server: "web", Alive: false, Tail: "short", Evidence: "trace\nError: X is not set"},
	})
	if h.Stage != StageSmoke || len(h.Issues) != 1 || h.Issues[0].Server != "web" || h.Issues[0].Detail != "trace\nError: X is not set" {
		t.Errorf("HealthFromSmoke = %+v", h)
	}
	if h.Summary() != "server died: web/web" {
		t.Errorf("Summary = %q", h.Summary())
	}
	var none *Health
	if none.Summary() != "" {
		t.Error("nil Summary should be empty")
	}
}

func TestRecordHealth_RoundTripsAndClears(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	ref := Ref{Workspace: "ws", Worktree: DefaultWorktree}

	h := &Health{Stage: StageSmoke, At: time.Now(), Issues: []Issue{{Project: "api", Server: "api", Detail: "boom"}}}
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
	if err := AddWorktree("ws", "wrk2", CheckoutOptions{}); err != nil {
		t.Fatal(err)
	}
	main, wrk2 := Ref{Workspace: "ws", Worktree: DefaultWorktree}, Ref{Workspace: "ws", Worktree: "wrk2"}

	if err := SetOverride(wrk2, "K", "v"); err != nil {
		t.Fatal(err)
	}
	if err := RecordHealth(main, &Health{Stage: StageInstall, At: time.Now()}); err != nil {
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

	err := AddWorktree("ws", "wrk2", CheckoutOptions{Install: true})
	var setupErr *SetupError
	if !errors.As(err, &setupErr) {
		t.Fatalf("err = %v", err)
	}
	res, _ := Resolve(ref)
	if res.Health == nil || res.Health.Stage != StageInstall || res.Health.Issues[0].Project != "api" {
		t.Fatalf("Health after a failed install = %+v", res.Health)
	}

	project.SetSetup("api", "true")
	if err := Setup(ref, CheckoutOptions{Install: true}); err != nil {
		t.Fatal(err)
	}
	res, _ = Resolve(ref)
	if res.Health != nil {
		t.Errorf("a passing install should clear an install failure, got %+v", res.Health)
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
	h := &Health{Stage: StageSmoke, Issues: []Issue{{Project: "speak-api", Server: "speak-api", Detail: "  at loadConfig (src/config.ts:12)\nError: SPEAK_DB_URL is not set"}}}
	got := RenderFixPrompt(res, h, "  speak-api\n    API_URL  left alone — tutor not in workspace\n")
	orientation := RenderPrompt(res, directBranches(res))
	if !strings.HasPrefix(got, orientation) {
		t.Fatalf("the fix prompt must start with the orientation prompt:\n%s", got)
	}
	want := strings.Join([]string{
		"",
		"## What failed",
		"",
		"Stage: smoke — a server died within seconds of starting.",
		"",
		"speak-api/speak-api:",
		"      at loadConfig (src/config.ts:12)",
		"    Error: SPEAK_DB_URL is not set",
		"",
		"Env anomalies for this worktree (bindings crew could not resolve — a plain var missing from .env shows in the log above, not here):",
		"    speak-api",
		"    API_URL  left alone — tutor not in workspace",
		"",
		"Fix the cause in this checkout — .env, an override (crew add override phone-speak/main VAR=value), or code — then run: crew verify phone-speak/main",
		"Do not run crew setup phone-speak/main unless dependencies are actually missing.",
		"",
	}, "\n")
	if tail := strings.TrimPrefix(got, orientation); tail != want {
		t.Errorf("fix prompt tail =\n%s\nwant\n%s", tail, want)
	}

	// Install stage: the re-run hint flips, and no anomalies section when empty.
	h = &Health{Stage: StageInstall, Issues: []Issue{{Project: "speak-api", Detail: "uv sync: No solution found"}}}
	got = strings.TrimPrefix(RenderFixPrompt(res, h, ""), orientation)
	if !strings.Contains(got, "Stage: install") || !strings.Contains(got, "speak-api:\n    uv sync: No solution found") ||
		!strings.Contains(got, "crew setup phone-speak/main is the re-run") || strings.Contains(got, "Env anomalies") {
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
	res.Health = &Health{Stage: StageSmoke, Issues: []Issue{{Project: "speak-api", Server: "speak-api", Detail: "died"}}}
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
	results, err := Verify(res)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if len(SmokeFailures(results)) != 1 {
		t.Fatalf("results = %+v, want one death", results)
	}
	res, _ = Resolve(ref)
	if res.Health == nil || res.Health.Stage != StageSmoke || !strings.Contains(res.Health.Issues[0].Detail, "DB_URL is not set") {
		t.Fatalf("Health after a death = %+v", res.Health)
	}

	// Fixed: a server that stays up clears it.
	project.AddDevServer("api", project.DevServer{Name: "api", Port: 3000, Command: "sleep 30"})
	res, _ = Resolve(ref)
	if _, err := Verify(res); err != nil {
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
	if _, err := Verify(res); !errors.Is(err, ErrServersRunning) {
		t.Errorf("Verify while running = %v, want ErrServersRunning", err)
	}
	if !dev.Running(res.Slug) {
		t.Error("the refused verify must leave the session alone")
	}
}

func TestWorktreeListShowsHealth(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	ref := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	RecordHealth(ref, &Health{Stage: StageSmoke, At: time.Now(), Issues: []Issue{{Project: "api", Server: "api", Detail: "x"}}})

	summaries, _ := ListSummaries()
	if len(summaries) != 1 || summaries[0].Health != "server died: api/api" {
		t.Errorf("summaries = %+v", summaries)
	}
}
