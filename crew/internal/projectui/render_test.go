package projectui

import (
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

var ansi = regexp.MustCompile(`\x1b\[[0-9;]*m`)

func plain(s string) string { return ansi.ReplaceAllString(s, "") }

// The cards render facts, so a card at rest is a fixed string. One golden
// per shape; the rest of the variants assert the line that differs.

func fixtureWizard(step step) Wizard {
	w := newWizard()
	w.step = step
	w.name = "store-api"
	w.facts = factsMsg{proj: project.Project{Name: "store-api", Path: "/repos/store-api"}, remote: "git@github.com:example/store-api.git"}
	for i := range w.inputs {
		w.inputs[i].Blur()
	}
	return w
}

func TestRenderSource_Golden(t *testing.T) {
	setupTestConfig(t)
	w := newWizard()
	w.inputs[fieldURL].Blur()
	w.inputs[fieldURL].SetValue("git@github.com:example/store-api.git")
	w.inputs[fieldName].SetValue("store-api")
	got := plain(w.View())
	want := strings.Join([]string{
		"  Add project · 1 of 5 · source",
		"",
		"  A project is its git remote: that is what an export carries and what another",
		"  machine clones. crew keeps its own clone under ~/.crew/projects/<name> and never",
		"  works in it — every worktree and every check is a fresh checkout of it. The",
		"  name is fixed once the clone lands.",
		"",
		"  url       > git@github.com:example/store-api.git ",
		"  name      > store-api   → " + config.Tildify(project.ClonePath("store-api")),
		"",
		"  enter clone  tab name  ctrl+p adopt a path  esc stop",
		"  crew add project <name> <url>",
		"",
	}, "\n")
	if got != want {
		t.Errorf("source card =\n%s\nwant\n%s", got, want)
	}
	w.adopting = true
	if got := plain(w.View()); !strings.Contains(got, "· adopt a path") || !strings.Contains(got, "enter adopt  tab name  esc back to url") || !strings.Contains(got, "crew add project <name> --path=<dir>") {
		t.Errorf("adopt card:\n%s", got)
	}
}

func TestRenderInstall_Golden(t *testing.T) {
	w := fixtureWizard(stepInstall)
	w.facts.detected = []exec.SetupStep{{Name: "mise install"}, {Name: "npm ci"}}
	w.inputs[fieldEnvCmd].SetValue("make get-env")
	got := plain(w.View())
	want := strings.Join([]string{
		"  Add project · 2 of 5 · install",
		"",
		"  Every new checkout runs an install after mise: the lockfile picks the package",
		"  manager, or a setup command replaces that (a Makefile target, a monorepo",
		"  bootstrap, codegen). An env command then writes the checkout's env files — sops,",
		"  a vault, make get-env — over the .env crew copied in. It must write files, not",
		"  print values; its output is logged.",
		"",
		"  setup     > make sync   (empty: the lockfile decides)",
		"  env       > make get-env ",
		"",
		"  a new checkout would run  mise install → npm ci → env: make get-env",
		"",
		"  tab next  enter save  esc stop",
		"  crew add project store-api --setup=<cmd> --env-cmd=<cmd>",
		"",
	}, "\n")
	if got != want {
		t.Errorf("install card =\n%s\nwant\n%s", got, want)
	}
	// A setup command replaces the detected install, mise stays first.
	w.inputs[fieldSetup].SetValue("make sync")
	if got := plain(w.View()); !strings.Contains(got, "a new checkout would run  mise install → make sync → env: make get-env") {
		t.Errorf("preview with a setup command:\n%s", got)
	}
	w.fromCheck = true
	if got := plain(w.View()); !strings.Contains(got, "tab next  enter save  esc back to check\n") {
		t.Errorf("from the check card:\n%s", got)
	}
}

func TestRenderServers(t *testing.T) {
	w := fixtureWizard(stepServers)
	w.facts.devCmd = "npm run dev"
	got := plain(w.View())
	for _, want := range []string{"package.json says  store-api  npm run dev", "port      > 3000", "servers   none yet", "enter add with this port  a by hand  n next  esc stop", "crew dev setup store-api --apply --port=<port>"} {
		if !strings.Contains(got, want) {
			t.Errorf("servers card lacks %q:\n%s", want, got)
		}
	}
	w.facts.devCmd = ""
	w.facts.proj.DevServers = []project.DevServer{{Name: "web", Port: 3000, Command: "pnpm dev", Dir: "apps/web"}}
	got = plain(w.View())
	for _, want := range []string{"nothing detected — detection reads package.json only; a adds one by hand", "servers   web :3000  pnpm dev  dir:apps/web", "a by hand  n next  esc stop"} {
		if !strings.Contains(got, want) {
			t.Errorf("servers card lacks %q:\n%s", want, got)
		}
	}
}

func TestRenderBindings_NoTargetsGolden(t *testing.T) {
	w := fixtureWizard(stepBindings)
	w.facts.pool = []project.Project{w.facts.proj, {Name: "docs"}}
	got := plain(w.View())
	want := strings.Join([]string{
		"  Add project · 4 of 5 · bindings",
		"",
		"  A binding is VAR = template over {{proj[/server]}}, .host or .port, resolved",
		"  per worktree from the ports crew allocated and injected as exports ahead of",
		"  PORT — env files are read, never written; a worktree override wins. With two",
		"  or more servers a binding can be scoped to one: a monorepo's web and its",
		"  worker want different siblings.",
		"",
		"  nothing to point at yet — bindings come with the second project that has servers",
		"  to point an existing project at store-api: crew add binding <other> --scan",
		"",
		"  bindings  none yet",
		"",
		"  n next  esc stop",
		"  crew add binding store-api[/<server>] --var=<VAR> --url=<proj>  ·  --scan --apply",
		"",
	}, "\n")
	if got != want {
		t.Errorf("bindings card =\n%s\nwant\n%s", got, want)
	}
	w.facts.pool = append(w.facts.pool, project.Project{Name: "signals", DevServers: []project.DevServer{{Name: "signals", Port: 4000}}})
	w.facts.proj.Bindings = []project.Binding{{Var: "SIGNALS_URL", Value: "{{signals}}"}}
	got = plain(w.View())
	for _, want := range []string{"  targets   {{signals}}                      signals :4000\n", "bindings  SIGNALS_URL  {{signals}}", "b bindings  n next  esc stop"} {
		if !strings.Contains(got, want) {
			t.Errorf("bindings card with a target lacks %q:\n%s", want, got)
		}
	}
}

func TestRenderCheck(t *testing.T) {
	w := fixtureWizard(stepCheck)
	got := plain(w.View())
	for _, want := range []string{"5 of 5 · check", "install   —", "servers   none", "no servers recorded — the check proves the install", "y check  i install only  n skip  esc stop", "crew check project store-api [--no-smoke] --wait"} {
		if !strings.Contains(got, want) {
			t.Errorf("idle card lacks %q:\n%s", want, got)
		}
	}
	w.facts.proj.DevServers = []project.DevServer{{Name: "web", Port: 3000, Command: "pnpm dev"}}
	if got := plain(w.View()); !strings.Contains(got, "! "+envMissingLine) {
		t.Errorf("a clone with servers, no env files and no env command is warned:\n%s", got)
	}
	w.facts.proj.EnvCmd = "make get-env"
	if got := plain(w.View()); strings.Contains(got, envMissingLine) {
		t.Errorf("an env command answers the warning:\n%s", got)
	}

	w.check = checkCard{name: "store-api", phase: checkRunning, smoke: true}
	if got := plain(w.View()); !strings.Contains(got, "checking store-api — one runner, a fresh checkout") || !strings.Contains(got, "l logs  esc leaves it running") {
		t.Errorf("running card:\n%s", got)
	}
	w.check = checkCard{name: "store-api"}
	w.applying, w.pending = true, "starting the check — a fresh checkout"
	if got := plain(w.View()); !strings.Contains(got, "starting the check — a fresh checkout") || strings.Contains(got, "y check") {
		t.Errorf("starting card offers no keys:\n%s", got)
	}
}

func TestRenderCheck_FailedGolden(t *testing.T) {
	w := fixtureWizard(stepCheck)
	// The health block's timestamp is relative; a moment ago reads the same
	// for the length of a test.
	at := time.Now()
	st := workspace.Status{Projects: []workspace.ProjectStatus{{
		Project: "store-api", State: workspace.StateFailed,
		Steps:  []workspace.RunStep{{Name: "checkout", Status: "ok", TookMs: 400}, {Name: "make sync", Status: "failed", TookMs: 1200, Detail: "make sync: no compiler"}},
		Issues: []workspace.Issue{{Stage: "install", Project: "store-api", Reason: "make sync", Detail: "cc: command not found\nmake: *** [sync] Error 127"}},
	}}}
	w.check = checkCard{name: "store-api", phase: checkFailed, smoke: true, status: &st, health: st.Health(), now: at}
	w.check.health.At = at
	got := plain(w.View())
	want := strings.Join([]string{
		"  Add project · 5 of 5 · check",
		"",
		"  A check proves the project reproduces from nothing: a fresh checkout of the",
		"  clone through mise, the install, the env command, then a smoke of each server",
		"  alone (a sibling's URL resolves, nothing answers). ✓ removes the target; ✗",
		"  keeps it with the evidence for f fix or c again.",
		"",
		"  ✗ store-api  checkout 0s · make sync — make sync: no compiler",
		"",
		"  ! install failed: store-api · just now",
		"    install   store-api   cc: command not found",
		"                          make: *** [sync] Error 127",
		"",
		// No check record behind this constructed card, so no f: the flow
		// test on a real failure has it.
		"  t install  s servers  c check again  l logs  n finish  esc stop",
		"  crew fix check/store-api · crew check project store-api",
		"",
	}, "\n")
	if got != want {
		t.Errorf("failed card =\n%s\nwant\n%s", got, want)
	}
	w.check.phase = checkConfirm
	if got := plain(w.View()); !strings.Contains(got, "the fix on crew/check/store-api/store-api is not merged into the base — checking again replaces the checkout and loses it") || !strings.Contains(got, "y discard and check again  n keep  esc keep\n") {
		t.Errorf("confirm card:\n%s", got)
	}
}

func TestRenderFinish_Golden(t *testing.T) {
	c := finishCard{
		Project: project.Project{
			Name: "store-api", Path: "/repos/store-api", Setup: "make sync",
			DevServers: []project.DevServer{{Name: "web", Port: 3000, Command: "pnpm dev"}},
			Bindings:   []project.Binding{{Var: "SIGNALS_URL", Value: "{{signals}}"}},
		},
		Remote: "git@github.com:example/store-api.git", Verdict: verdictPassed, StoppedAt: stepFinish,
	}
	var b strings.Builder
	renderFinish(&b, c)
	got := plain(b.String())
	want := strings.Join([]string{
		"  Added store-api",
		"",
		"  remote    git@github.com:example/store-api.git",
		"  path      /repos/store-api",
		"  setup     make sync",
		"  env       —",
		"  servers   web :3000  pnpm dev",
		"  bindings  SIGNALS_URL  {{signals}}",
		"  check     ✓ reproduces from nothing — target removed",
		"",
		"  crew add workspace <workspace> store-api   the project joins a workspace; its first worktree is made then",
		"  crew project   t setup  e env cmd  s servers  b bindings — change any of it later",
		"",
		"  enter close  esc close",
		"",
	}, "\n")
	if got != want {
		t.Errorf("finish card =\n%s\nwant\n%s", got, want)
	}
	// Rows: the label on the first only, binding labels padded to the widest.
	c.Project.DevServers = append(c.Project.DevServers, project.DevServer{Name: "worker", Port: 3001, Command: "pnpm worker", Dir: "apps/worker"})
	c.Project.Bindings = append(c.Project.Bindings, project.Binding{Var: "DB", Server: "worker", Value: "{{infra-ops/db.host}}"}, project.Binding{Var: "PORT", Value: "{{store-api.port}}"})
	b.Reset()
	renderFinish(&b, c)
	if got := plain(b.String()); !strings.Contains(got, "  servers   web :3000  pnpm dev\n            worker :3001  pnpm worker  dir:apps/worker\n  bindings  SIGNALS_URL  {{signals}}\n            DB (worker)  {{infra-ops/db.host}}\n            PORT         {{store-api.port}}\n") {
		t.Errorf("two-row card:\n%s", got)
	}
	c.StoppedAt, c.Verdict = stepServers, verdictNone
	c.Project.DevServers, c.Project.Bindings = nil, nil
	b.Reset()
	renderFinish(&b, c)
	got = plain(b.String())
	for _, want := range []string{"  Add project · stopped at servers\n", "  servers   none\n", "  check     not run — crew check project store-api\n", "  continue in crew project:  s servers  b bindings\n", "  then crew check project store-api\n"} {
		if !strings.Contains(got, want) {
			t.Errorf("stopped card lacks %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "change any of it later") {
		t.Errorf("a stopped card names the resume keys once:\n%s", got)
	}
	c.StoppedAt = stepCheck
	b.Reset()
	renderFinish(&b, c)
	if got := plain(b.String()); !strings.Contains(got, "change any of it later") || strings.Contains(got, "continue in") {
		t.Errorf("stopped at the check: the generic line is the way back in:\n%s", got)
	}
}
