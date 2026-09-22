package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// Two bindings-bearing projects across two worktrees, with an override on the
// second. Real repos so StartDev's direct-mode check and dev.Start can run.
func bindingWorkspace(t *testing.T) {
	t.Helper()
	newRepoWorkspace(t, "ws", "api", "tutor")

	project.AddDevServer("api", project.DevServer{Name: "api", Port: 3000, Command: "sleep 30"})
	project.AddBinding("tutor", project.Binding{Var: "API_URL", Value: "{{url:api}}"})
	project.AddBinding("tutor", project.Binding{Var: "AGENT", Value: "{{worktree}}"})

	if err := AddWorktree("ws", "wrk2", CheckoutOptions{}); err != nil {
		t.Fatalf("AddWorktree: %v", err)
	}
	if err := SetOverride(Ref{Workspace: "ws", Worktree: "wrk2"}, "API_URL", "https://deployed"); err != nil {
		t.Fatalf("SetOverride: %v", err)
	}
}

func devResult(t *testing.T, r dev.StartResult, name string) dev.Resolution {
	t.Helper()
	for _, res := range r.Resolutions {
		if res.Var == name {
			return res
		}
	}
	t.Fatalf("no resolution for %s in %+v", name, r.Resolutions)
	return dev.Resolution{}
}

// The seam that let bindings vanish once: everything Resolved knows has to
// reach dev.StartParams — projects with their bindings, the identity tokens,
// and the overrides.
func TestStartDev_PassesOverridesAndIdentityThrough(t *testing.T) {
	if !exec.HasTmux() {
		t.Skip("tmux not available")
	}
	bindingWorkspace(t)
	t.Cleanup(func() {
		dev.StopAll("ws--main")
		dev.StopAll("ws--wrk2")
	})

	res, err := Resolve(Ref{Workspace: "ws", Worktree: "wrk2"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	result, err := StartDev(res, true, false)
	if err != nil {
		t.Fatalf("StartDev: %v", err)
	}

	if got := devResult(t, result, "API_URL"); got.Source != dev.SourceOverride || got.Value != "https://deployed" {
		t.Errorf("API_URL = %+v, want the wrk2 override", got)
	}
	if got := devResult(t, result, "AGENT"); got.Value != "wrk2" {
		t.Errorf("AGENT = %q, want the selected worktree — this is the Signals agent-name collision", got.Value)
	}
}

func TestStartDev_ResolvesAgainstTheSelectedWorktree(t *testing.T) {
	if !exec.HasTmux() {
		t.Skip("tmux not available")
	}
	bindingWorkspace(t)
	t.Cleanup(func() {
		dev.StopAll("ws--main")
		dev.StopAll("ws--wrk2")
	})

	res, err := Resolve(Ref{Workspace: "ws", Worktree: DefaultWorktree})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	result, err := StartDev(res, true, false)
	if err != nil {
		t.Fatalf("StartDev: %v", err)
	}

	// main has no override, so the binding resolves to api's allocated port —
	// never the configured 3000.
	got := devResult(t, result, "API_URL")
	if got.Source != dev.SourceBinding || got.Value == "http://localhost:3000" || !strings.HasPrefix(got.Value, "http://localhost:") {
		t.Errorf("API_URL = %+v, want the binding resolved to an allocated port on main", got)
	}
	if got := devResult(t, result, "AGENT"); got.Value != DefaultWorktree {
		t.Errorf("AGENT = %q, want %s", got.Value, DefaultWorktree)
	}
}

// crew run / crew env resolve against the route file; with nothing running
// every reference binding is left alone, and the identity tokens still work.
func TestResolveEnv_NothingRunning(t *testing.T) {
	bindingWorkspace(t)

	res, err := Resolve(Ref{Workspace: "ws", Worktree: DefaultWorktree})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	by := dev.GroupResolutions(res.ResolveEnv())["tutor"]

	var apiURL, agent dev.Resolution
	for _, r := range by {
		switch r.Var {
		case "API_URL":
			apiURL = r
		case "AGENT":
			agent = r
		}
	}
	if apiURL.Source != dev.SourceUnresolved {
		t.Errorf("API_URL = %+v, want left alone with no servers running", apiURL)
	}
	if agent.Value != DefaultWorktree {
		t.Errorf("AGENT = %+v, want the worktree name regardless of servers", agent)
	}
}

// AddProject has to check the new project out into every worktree.
func TestAddProject_FansOutToEveryWorktree(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	AddWorktree("ws", "wrk2", CheckoutOptions{})
	AddWorktree("ws", "wrk3", CheckoutOptions{})

	repo := filepath.Join(t.TempDir(), "web")
	os.MkdirAll(repo, 0o755)
	initRepo(t, repo)
	project.Add(project.Project{Name: "web", Path: repo})

	if err := AddProject("ws", "web", "frontend", "", CheckoutOptions{}); err != nil {
		t.Fatalf("AddProject: %v", err)
	}

	seen := map[string]bool{}
	for _, wt := range []string{DefaultWorktree, "wrk2", "wrk3"} {
		ref := Ref{Workspace: "ws", Worktree: wt}
		path := WorktreePath(ref, "web")
		if _, err := os.Stat(path); err != nil {
			t.Errorf("%s has no checkout of web: %v", ref, err)
			continue
		}
		branch, _ := exec.RunGitCommand(path, "rev-parse", "--abbrev-ref", "HEAD")
		if seen[branch] {
			t.Errorf("branch %q checked out twice", branch)
		}
		seen[branch] = true
	}
}

// Remove has to tear down every worktree's artifacts, not one flat set.
func TestRemove_TearsDownEveryWorktreesArtifacts(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	AddWorktree("ws", "wrk2", CheckoutOptions{})

	var paths []string
	for _, wt := range []string{DefaultWorktree, "wrk2"} {
		ref := Ref{Workspace: "ws", Worktree: wt}
		os.WriteFile(PromptFilePath(ref), []byte("p"), 0o644)
		os.WriteFile(CodeWorkspaceFilePath(ref), []byte("{}"), 0o644)
		os.MkdirAll(dev.LogDir(ref.Slug()), 0o755)
		paths = append(paths, PromptFilePath(ref), CodeWorkspaceFilePath(ref), dev.LogDir(ref.Slug()), WorktreeDir(ref))
	}

	if err := Remove("ws"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	for _, path := range paths {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("%s survived Remove", path)
		}
	}
}

// Ports survive restarts: the second start of a worktree binds the same ports
// the first one got, and `crew env` output stays valid across it.
func TestStartDev_PortsSurviveRestart(t *testing.T) {
	if !exec.HasTmux() {
		t.Skip("tmux not available")
	}
	bindingWorkspace(t)
	t.Cleanup(func() { dev.StopAll("ws--main") })

	res, err := Resolve(Ref{Workspace: "ws", Worktree: DefaultWorktree})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	first, err := StartDev(res, true, false)
	if err != nil {
		t.Fatalf("first StartDev: %v", err)
	}
	firstPort := first.Ports[dev.PortKey("api", "api")]
	if firstPort == 0 {
		t.Fatalf("no port recorded for api: %+v", first.Ports)
	}

	// Re-resolve so the persisted reservation is what the restart sees.
	res, _ = Resolve(Ref{Workspace: "ws", Worktree: DefaultWorktree})
	if res.Ports[dev.PortKey("api", "api")] != firstPort {
		t.Fatalf("reservation not persisted: %+v", res.Ports)
	}
	second, err := StartDev(res, true, true)
	if err != nil {
		t.Fatalf("restart: %v", err)
	}
	if got := second.Ports[dev.PortKey("api", "api")]; got != firstPort {
		t.Errorf("api restarted on %d, want the reserved %d", got, firstPort)
	}
}

// Several projects in one call: every spec checked before anything happens,
// installs run at once, an install failure keeps the member and lands on the
// worktree's health.
func TestAddProjects_ManyAtOnce(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	for _, name := range []string{"web", "worker", "slow"} {
		repo := filepath.Join(t.TempDir(), name)
		os.MkdirAll(repo, 0o755)
		initRepo(t, repo)
		project.Add(project.Project{Name: name, Path: repo})
	}
	project.SetSetup("web", "exit 7")
	project.SetSetup("worker", "sleep 1")
	project.SetSetup("slow", "sleep 1")

	// Pre-flight: a bad call fails whole, nothing added.
	for _, bad := range [][]ProjectSpec{{{Name: "web"}, {Name: "nope"}}, {{Name: "web"}, {Name: "web"}}, {}} {
		if _, err := AddProjects("ws", bad, CheckoutOptions{}); err == nil {
			t.Errorf("%+v should fail before any side effect", bad)
		}
	}
	if ws, _ := Load("ws"); len(ws.Projects) != 1 {
		t.Fatalf("nothing should have been added: %+v", ws.Projects)
	}

	// One runner per project: the two one-second installs overlap — the
	// second starts before the first finishes.
	backgroundRunners(t)
	refs, err := AddProjects("ws", []ProjectSpec{{Name: "web", Role: "ui"}, {Name: "worker"}, {Name: "slow"}}, CheckoutOptions{Install: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 1 || refs[0].Worktree != DefaultWorktree {
		t.Fatalf("refs = %+v", refs)
	}
	if _, err := WaitSetup(refs[0]); err != nil {
		t.Fatal(err)
	}
	worker, _ := readResult(resultFile(refs[0].Slug(), "worker"))
	slow, _ := readResult(resultFile(refs[0].Slug(), "slow"))
	if worker.FinishedAt == nil || slow.FinishedAt == nil || !slow.StartedAt.Before(*worker.FinishedAt) || !worker.StartedAt.Before(*slow.FinishedAt) {
		t.Errorf("installs did not overlap: worker %v–%v, slow %v–%v", worker.StartedAt, worker.FinishedAt, slow.StartedAt, slow.FinishedAt)
	}
	ws, _ := Load("ws")
	names := []string{}
	for _, wp := range ws.Projects {
		names = append(names, wp.Name)
	}
	if strings.Join(names, ",") != "api,web,worker,slow" {
		t.Errorf("members = %v", names)
	}
	res, _ := Resolve(Ref{Workspace: "ws", Worktree: DefaultWorktree})
	if res.Health == nil || res.Health.Summary() != "install failed: web" {
		t.Errorf("health = %+v", res.Health)
	}
	if wp := ws.Projects[1]; wp.Role != "ui" {
		t.Errorf("role not kept: %+v", wp)
	}
}

// A checkout that fails is recorded on every worktree it failed in, the
// project stays a member, and the good project beside it is unaffected —
// verify finishes what is missing.
func TestAddProjects_CheckoutFailureIsRecordedAndKept(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	AddWorktree("ws", "wrk2", CheckoutOptions{})
	good := filepath.Join(t.TempDir(), "web")
	os.MkdirAll(good, 0o755)
	initRepo(t, good)
	project.Add(project.Project{Name: "web", Path: good})
	// Not a git repository: every worktree's checkout of it fails.
	project.Add(project.Project{Name: "broken", Path: t.TempDir()})

	refs, err := AddProjects("ws", []ProjectSpec{{Name: "web"}, {Name: "broken"}}, CheckoutOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 2 {
		t.Fatalf("refs = %+v, want both worktrees", refs)
	}
	ws, _ := Load("ws")
	if len(ws.Projects) != 3 || ws.Projects[2].Name != "broken" {
		t.Errorf("broken should stay a member: %+v", ws.Projects)
	}
	for _, wt := range []string{DefaultWorktree, "wrk2"} {
		ref := Ref{Workspace: "ws", Worktree: wt}
		if _, err := os.Stat(WorktreePath(ref, "web")); err != nil {
			t.Errorf("%s: web's checkout should be there", ref)
		}
		if _, err := os.Stat(WorktreePath(ref, "broken")); err == nil {
			t.Errorf("%s: broken should have no checkout", ref)
		}
		res, _ := Resolve(ref)
		if res.Health == nil || res.Health.Summary() != "checkout failed: broken" {
			t.Errorf("%s health = %+v", ref, res.Health)
		}
	}
}

// A second add keeps the first add's record about other projects.
func TestAddProjects_KeepsOtherProjectsIssues(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	ref := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	RecordHealth(ref, &Health{At: time.Now(), Issues: []Issue{{Stage: StageCheckout, Project: "api", Detail: "old"}}})
	repo := filepath.Join(t.TempDir(), "web")
	os.MkdirAll(repo, 0o755)
	initRepo(t, repo)
	project.Add(project.Project{Name: "web", Path: repo})
	project.SetSetup("web", "exit 7")

	if _, err := AddProjects("ws", []ProjectSpec{{Name: "web"}}, CheckoutOptions{Install: true}); err != nil {
		t.Fatal(err)
	}
	res, _ := Resolve(ref)
	if res.Health == nil || len(res.Health.Issues) != 2 ||
		res.Health.Issues[0].Project != "api" || res.Health.Issues[0].Detail != "old" ||
		res.Health.Issues[1].Project != "web" || res.Health.Issues[1].Stage != StageInstall {
		t.Errorf("health = %+v", res.Health)
	}
}

// The page's rows get their check through one join; a key mismatch would
// show plain ● everywhere. And a check of nothing running is nil.
func TestLoadWorktreePage_JoinsTheCheck(t *testing.T) {
	if !exec.HasTmux() {
		t.Skip("tmux not available")
	}
	newRepoWorkspace(t, "ws", "api")
	project.AddDevServer("api", project.DevServer{Name: "api", Port: 3000, Command: "sleep 30"})
	res, _ := Resolve(Ref{Workspace: "ws", Worktree: DefaultWorktree})
	if CheckServers(res) != nil {
		t.Error("nothing running should check as nil")
	}
	if _, err := StartDev(res, true, false); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { dev.StopAll(res.Slug) })
	// The pane's shell needs a moment to be running the command — on a
	// loaded machine more than a moment, so wait for it rather than guess.
	deadline := time.Now().Add(15 * time.Second)
	for !exec.TmuxPaneBusy(dev.SessionName(res.Slug), string(res.Slug)+"/api") {
		if time.Now().After(deadline) {
			t.Fatal("the pane never became busy — tmux, not the join")
		}
		time.Sleep(100 * time.Millisecond)
	}

	page := loadWorktreePage(res, false, false)
	if page.Items[0].Check != nil || page.CheckHealth != nil {
		t.Errorf("without a check: %+v", page.Items[0])
	}
	page = loadWorktreePage(res, true, false)
	if c := page.Items[0].Check; c == nil || !c.Alive || c.Listening || c.Port != page.Items[0].Port {
		t.Errorf("with a check: %+v", page.Items[0])
	}
	if page.CheckHealth != nil {
		t.Errorf("an idle, unreferenced worker is not a failure: %+v", page.CheckHealth)
	}
}

// The smoke stage runs for an added project and lands on the worktree —
// unless that worktree's servers are running, which a smoke would kill.
func TestAddProjects_SmokeRecordedUnlessRunning(t *testing.T) {
	if !exec.HasTmux() {
		t.Skip("tmux not available")
	}
	newRepoWorkspace(t, "ws", "api")
	repo := filepath.Join(t.TempDir(), "web")
	os.MkdirAll(repo, 0o755)
	initRepo(t, repo)
	project.Add(project.Project{Name: "web", Path: repo})
	project.AddDevServer("web", project.DevServer{Name: "web", Port: 3001, Command: "sh -c 'exit 1'"})
	ref := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	t.Cleanup(func() { dev.StopAll(ref.Slug()) })

	if _, err := AddProjects("ws", []ProjectSpec{{Name: "web"}}, CheckoutOptions{Smoke: true}); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(stepsOf(t, ref), ","); got != "api:checkout,web:checkout,web:smoke web" {
		t.Errorf("steps = %s", got)
	}
	if res, _ := Resolve(ref); res.Health == nil || res.Health.Summary() != "server died: web/web" {
		t.Errorf("health = %+v", res.Health)
	}

	// Servers up: no smoke, the running session is left alone.
	RemoveProject("ws", "web")
	project.AddDevServer("api", project.DevServer{Name: "api", Port: 3000, Command: "sleep 30"})
	res, _ := Resolve(ref)
	if _, err := StartDev(res, true, false); err != nil {
		t.Fatal(err)
	}
	if _, err := AddProjects("ws", []ProjectSpec{{Name: "web"}}, CheckoutOptions{Smoke: true}); err != nil {
		t.Fatal(err)
	}
	if h := recorded(t, ref); h != nil || !dev.Running(ref.Slug()) {
		t.Errorf("running servers must be left alone: health=%+v running=%v", h, dev.Running(ref.Slug()))
	}
	if got := strings.Join(stepsOf(t, ref), ","); strings.Contains(got, "smoke") {
		t.Errorf("no smoke while servers run: %s", got)
	}
}

// A scoped binding survives the trip from the pool through Resolved into
// the resolver: the row carries the server, and a preview of the scoped
// draft does not collide with its project-wide sibling.
func TestResolveEnv_CarriesScope(t *testing.T) {
	newRepoWorkspace(t, "ws", "api", "mono")
	project.AddDevServer("api", project.DevServer{Name: "api", Port: 3000, Command: "sleep 30"})
	project.AddDevServer("mono", project.DevServer{Name: "web", Port: 3001, Command: "sleep 30"})
	project.AddDevServer("mono", project.DevServer{Name: "worker", Port: 3002, Command: "sleep 30"})
	project.AddBinding("mono", project.Binding{Var: "API_URL", Value: "literal"})
	project.AddBinding("mono", project.Binding{Var: "API_URL", Value: "{{api}}", Server: "web"})
	ref := Ref{Workspace: "ws", Worktree: DefaultWorktree}

	res, err := Resolve(ref)
	if err != nil {
		t.Fatal(err)
	}
	var scoped, pw bool
	for _, p := range res.DevProjects() {
		for _, b := range p.Bindings {
			if p.Name == "mono" && b.Var == "API_URL" {
				if b.Server == "web" {
					scoped = true
				} else if b.Server == "" {
					pw = true
				}
			}
		}
	}
	if !scoped || !pw {
		t.Fatalf("DevProjects must copy the scope: scoped=%v pw=%v", scoped, pw)
	}
	rows := dev.GroupResolutions(res.ResolveEnv())["mono"]
	if len(rows) != 2 || rows[1].Server != "web" || rows[0].Server != "" {
		t.Errorf("rows = %+v", rows)
	}
	web := dev.EnvFor(rows, dev.ProjectServer{Project: "mono", Server: "web"})
	if len(web) != 1 || web[0].Server != "web" {
		t.Errorf("web gets its own row: %+v", web)
	}

	// No ports are reserved yet (the servers were added after the worktree),
	// so the scoped draft's own outcome is "api not running" — never the
	// project-wide sibling's literal.
	previews := PreviewBinding("mono", project.Binding{Var: "API_URL", Value: "{{api.port}}", Server: "web"})
	if len(previews) != 1 || previews[0].Resolved || previews[0].Value == "literal" || !strings.Contains(previews[0].Detail, "api") {
		t.Errorf("a scoped draft previews as itself, not as the project-wide sibling: %+v", previews)
	}
	previews = PreviewBinding("mono", project.Binding{Var: "API_URL", Value: "other"})
	if len(previews) != 1 || previews[0].Value != "other" {
		t.Errorf("a project-wide draft previews as itself: %+v", previews)
	}
}
