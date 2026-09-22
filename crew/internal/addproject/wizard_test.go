package addproject

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	crewexec "github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/trash"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

func setupTestConfig(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	config.ConfigDir = tmp
	config.WorkspacesDir = filepath.Join(tmp, "workspaces")
	config.TrashDir = filepath.Join(tmp, "trash")
	config.ProjectsDir = filepath.Join(tmp, "projects")
	config.ClaudeConfigDir = filepath.Join(tmp, "claude")
	os.MkdirAll(config.WorkspacesDir, 0o755)
	trash.DisableSweepForTest(t)
	// A passed check stops the proxy if idle on the shared tmux server; a
	// name of our own keeps that away from a live proxy.
	prevProxy := dev.ProxySessionName
	dev.ProxySessionName = fmt.Sprintf("crew-test-proxy-%d", os.Getpid())
	t.Cleanup(func() {
		crewexec.KillTmuxSession(dev.ProxySessionName)
		dev.ProxySessionName = prevProxy
	})
	// Runners in-process, one after another: the check is done when
	// StartCheck returns, so the first poll reads the verdict.
	prev := workspace.SpawnRunner
	workspace.SpawnRunner = func(ref workspace.Ref, job workspace.ProjectJob) error { return workspace.RunProjectSetup(ref, job) }
	t.Cleanup(func() { workspace.SpawnRunner = prev })
	return tmp
}

// backgroundRunners runs each job in a goroutine — the real shape, minus
// tmux — for the one test about a runner still alive.
func backgroundRunners(t *testing.T) {
	t.Helper()
	prev := workspace.SpawnRunner
	var wg sync.WaitGroup
	workspace.SpawnRunner = func(ref workspace.Ref, job workspace.ProjectJob) error {
		wg.Add(1)
		go func() {
			defer wg.Done()
			workspace.RunProjectSetup(ref, job)
		}()
		return nil
	}
	t.Cleanup(func() {
		wg.Wait()
		workspace.SpawnRunner = prev
	})
}

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	if _, err := crewexec.RunGitCommand(dir, args...); err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
}

// bareRemote seeds a repo with a package.json (a dev script) and a
// lockfile, commits it, and returns a file:// URL to a bare clone of it —
// the shape a real remote has; IsGitURL refuses a bare path.
func bareRemote(t *testing.T, tmp, name string) string {
	t.Helper()
	seed := filepath.Join(tmp, "seed", name)
	os.MkdirAll(seed, 0o755)
	os.WriteFile(filepath.Join(seed, "package.json"), []byte(`{"scripts":{"dev":"node server.js"}}`), 0o644)
	os.WriteFile(filepath.Join(seed, "package-lock.json"), []byte(`{}`), 0o644)
	git(t, seed, "init", "-q", "-b", "main")
	git(t, seed, "add", ".")
	git(t, seed, "-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "-m", "init")
	bare := filepath.Join(tmp, "remotes", name+".git")
	os.MkdirAll(filepath.Dir(bare), 0o755)
	git(t, tmp, "clone", "-q", "--bare", seed, bare)
	return "file://" + bare
}

func keyRune(r string) tea.KeyMsg { return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(r)} }

func keyOf(k string) tea.Msg {
	switch k {
	case "esc":
		return tea.KeyMsg{Type: tea.KeyEsc}
	case "enter":
		return tea.KeyMsg{Type: tea.KeyEnter}
	case "tab":
		return tea.KeyMsg{Type: tea.KeyTab}
	case "ctrl+p":
		return tea.KeyMsg{Type: tea.KeyCtrlP}
	case "ctrl+c":
		return tea.KeyMsg{Type: tea.KeyCtrlC}
	}
	return keyRune(k)
}

// press sends a key and runs whatever it produced, feeding the wizard's
// own messages back until it settles — every step applies through a
// command, and tests want the settled state.
func press(t *testing.T, w Wizard, k string) Wizard {
	t.Helper()
	return settle(t, w, keyOf(k))
}

func settle(t *testing.T, w Wizard, msg tea.Msg) Wizard {
	t.Helper()
	m, cmd := w.Update(msg)
	w = m.(Wizard)
	for _, out := range runCmd(cmd) {
		w = settle(t, w, out)
	}
	return w
}

// runCmd runs a command tree and keeps the wizard's own messages; spinner
// ticks, cursor blinks and the page pushes reschedule or leave.
func runCmd(cmd tea.Cmd) []tea.Msg {
	if cmd == nil {
		return nil
	}
	var out []tea.Msg
	switch msg := cmd().(type) {
	case tea.BatchMsg:
		results := make([][]tea.Msg, len(msg))
		var wg sync.WaitGroup
		for i, sub := range msg {
			wg.Add(1)
			go func() {
				defer wg.Done()
				results[i] = runCmd(sub)
			}()
		}
		wg.Wait()
		for _, r := range results {
			out = append(out, r...)
		}
	case addedMsg, factsMsg, savedMsg, checkStartedMsg, checkPollMsg, errMsg:
		out = append(out, msg)
	}
	return out
}

// quits: the key ends the program.
func quits(w Wizard, k string) bool {
	_, cmd := w.Update(keyOf(k))
	if cmd == nil {
		return false
	}
	_, ok := cmd().(tea.QuitMsg)
	return ok
}

// pushed returns the page a key pushes, or nil.
func pushed(w Wizard, k string) app.Page {
	_, cmd := w.Update(keyOf(k))
	if cmd == nil {
		return nil
	}
	if msg, ok := cmd().(app.PushPageMsg); ok {
		return msg.Page
	}
	return nil
}

func typeURL(w Wizard, url string) Wizard {
	for _, r := range url {
		m, _ := w.Update(keyRune(string(r)))
		w = m.(Wizard)
	}
	return w
}

// cloned walks the source card with a URL: the clone lands, the project is
// recorded, the install card opens with the clone's own facts.
func cloned(t *testing.T, tmp, name string) (Wizard, string) {
	t.Helper()
	url := bareRemote(t, tmp, name)
	w := newWizard()
	w = typeURL(w, url)
	if got := w.inputs[fieldName].Value(); got != name {
		t.Fatalf("the name follows the URL: %q", got)
	}
	w = press(t, w, "enter")
	if w.err != nil || w.step != stepInstall || w.name != name {
		t.Fatalf("after enter: err=%v step=%v name=%q", w.err, w.step, w.name)
	}
	return w, url
}

func TestWizard_SourceClones(t *testing.T) {
	tmp := setupTestConfig(t)
	w, url := cloned(t, tmp, "store-api")
	target := project.ClonePath("store-api")
	if _, err := os.Stat(filepath.Join(target, ".git")); err != nil {
		t.Fatal("no clone at the clone target")
	}
	p := project.Get("store-api")
	if p == nil || p.Path != target {
		t.Fatalf("record = %+v", p)
	}
	if crewexec.RepoKey(w.facts.remote) != crewexec.RepoKey(url) {
		t.Errorf("remote read off the clone = %q, want %q", w.facts.remote, url)
	}
	// The install card previews what the clone's own files ask for.
	if got := plain(w.View()); !strings.Contains(got, "a new checkout would run  npm ci") {
		t.Errorf("install preview:\n%s", got)
	}
}

func TestWizard_SourceRefusals(t *testing.T) {
	tmp := setupTestConfig(t)
	url := bareRemote(t, tmp, "signals")
	project.Add(project.Project{Name: "taken", Path: tmp})
	os.MkdirAll(project.ClonePath("blocked"), 0o755)
	for _, tt := range []struct {
		url, name, want string
	}{
		{"/tmp/signals", "", notURLLine},
		{url, "taken", "project 'taken' is already in the pool — crew project: t setup  e env cmd  s servers  b bindings"},
		{url, "blocked", "crew add project blocked --path=" + project.ClonePath("blocked")},
		{url, "a--b", "'a--b' cannot be checked"},
		{url, "Bad", "not a valid project name"},
	} {
		w := newWizard()
		w = typeURL(w, tt.url)
		if tt.name != "" {
			// Typed in by hand, so the name stops following the URL.
			w = press(t, w, "tab")
			w.inputs[fieldName].SetValue("")
			w = typeURL(w, tt.name)
		}
		w = press(t, w, "enter")
		if w.err == nil || !strings.Contains(w.err.Error(), tt.want) {
			t.Errorf("%s/%s: err = %v, want %q", tt.url, tt.name, w.err, tt.want)
		}
		if w.step != stepSource || w.name != "" {
			t.Errorf("%s/%s: the walk moved on: step=%v name=%q", tt.url, tt.name, w.step, w.name)
		}
	}
	if project.Get("signals") != nil || project.Get("blocked") != nil {
		t.Error("a refusal records nothing")
	}
	if _, err := os.Stat(filepath.Join(project.ClonePath("signals"), ".git")); err == nil {
		t.Error("a refusal clones nothing")
	}
}

func TestWizard_KeysWaitForTheClone(t *testing.T) {
	tmp := setupTestConfig(t)
	url := bareRemote(t, tmp, "admin")
	w := typeURL(newWizard(), url)
	m, cmd := w.Update(keyOf("enter"))
	w = m.(Wizard)
	if !w.applying || !strings.Contains(plain(w.View()), "Cloning admin → "+config.Tildify(project.ClonePath("admin"))) {
		t.Fatalf("after enter:\n%s", plain(w.View()))
	}
	// A second enter, or esc, while the clone runs is ignored.
	if m, c := w.Update(keyOf("enter")); c != nil || m.(Wizard).step != stepSource {
		t.Error("enter twice must not start a second clone")
	}
	if m, c := w.Update(keyOf("esc")); c != nil || m.(Wizard).step != stepSource {
		t.Error("esc during the clone is ignored")
	}
	for _, msg := range runCmd(cmd) {
		w = settle(t, w, msg)
	}
	if w.step != stepInstall || project.Get("admin") == nil {
		t.Errorf("one clone, then the install card: step=%v", w.step)
	}
}

func TestWizard_PathAdopts(t *testing.T) {
	tmp := setupTestConfig(t)
	have := filepath.Join(tmp, "code", "infra-ops")
	os.MkdirAll(have, 0o755)
	git(t, have, "init", "-q", "-b", "main")
	w := press(t, newWizard(), "ctrl+p")
	if got := plain(w.View()); !strings.Contains(got, "· adopt a path") || !strings.Contains(got, "\n  path      > ") {
		t.Fatalf("ctrl+p asks for a path:\n%s", got)
	}
	w = typeURL(w, filepath.Join(tmp, "code", "nope"))
	w = press(t, w, "enter")
	if w.err == nil || !strings.Contains(w.err.Error(), "is not a directory") {
		t.Fatalf("a missing dir is refused in place: %v", w.err)
	}
	w.inputs[fieldPath].SetValue(have)
	w = press(t, w, "enter")
	if w.err != nil || w.name != "infra-ops" {
		t.Fatalf("adopt: err=%v name=%q", w.err, w.name)
	}
	if p := project.Get("infra-ops"); p == nil || p.Path != have {
		t.Errorf("record = %+v", p)
	}
	if _, err := os.Stat(project.ClonePath("infra-ops")); !os.IsNotExist(err) {
		t.Error("adopting clones nothing")
	}
	if w.facts.remote != "" {
		t.Errorf("a repo with no origin has no remote: %q", w.facts.remote)
	}
	// esc in the path field goes back to the URL field, not out.
	w2 := press(t, press(t, newWizard(), "ctrl+p"), "esc")
	if got := plain(w2.View()); !strings.Contains(got, "\n  url       > ") || strings.Contains(got, "adopt a path\n") {
		t.Errorf("esc from the path field returns to the url:\n%s", got)
	}
}

func TestWizard_InstallSavesBoth(t *testing.T) {
	tmp := setupTestConfig(t)
	w, _ := cloned(t, tmp, "store-api")
	w.inputs[fieldSetup].SetValue("make sync")
	w = press(t, w, "tab")
	w.inputs[fieldEnvCmd].SetValue("make get-env")
	w = press(t, w, "enter")
	if w.step != stepServers {
		t.Fatalf("enter saves and moves on: step=%v", w.step)
	}
	if p := project.Get("store-api"); p.Setup != "make sync" || p.EnvCmd != "make get-env" {
		t.Errorf("saved = %+v", p)
	}
	if w.facts.proj.Setup != "make sync" {
		t.Error("the facts are re-read after a save")
	}
}

func TestWizard_ServersDetectedAndByHand(t *testing.T) {
	tmp := setupTestConfig(t)
	w, _ := cloned(t, tmp, "store-api")
	w = press(t, w, "enter")
	if !strings.Contains(plain(w.View()), "package.json says  store-api  npm run dev") {
		t.Fatalf("detection off the clone:\n%s", plain(w.View()))
	}
	w = press(t, w, "enter")
	if w.err == nil || !strings.Contains(w.err.Error(), "the port") {
		t.Fatalf("enter without a port: %v", w.err)
	}
	w.inputs[fieldPort].SetValue("3000")
	w = press(t, w, "enter")
	p := project.Get("store-api")
	if w.err != nil || len(p.DevServers) != 1 || p.DevServers[0] != (project.DevServer{Name: "store-api", Port: 3000, Command: "npm run dev"}) {
		t.Fatalf("recorded = %+v, err=%v", p.DevServers, w.err)
	}
	if got := plain(w.View()); !strings.Contains(got, "servers   store-api :3000  npm run dev") {
		t.Errorf("the card lists what is recorded:\n%s", got)
	}
	if _, ok := pushed(w, "a").(project.DevServerView); !ok {
		t.Error("a pushes the servers editor")
	}
	// Digits only, so a and n stay keys — and q is a typo, not a quit.
	for _, k := range []string{"a", "q", "x"} {
		m, _ := w.Update(keyRune(k))
		if m.(Wizard).inputs[fieldPort].Value() != "3000" {
			t.Errorf("%s must not land in the port field", k)
		}
	}
	if quits(w, "q") {
		t.Error("q on the servers card must not quit the TUI")
	}
	if !quits(w, "ctrl+c") {
		t.Error("ctrl+c quits everywhere")
	}
	// A server recorded on the pushed page shows up on pop.
	project.AddDevServer("store-api", project.DevServer{Name: "worker", Port: 3001, Command: "npm run worker"})
	w = settle(t, w, w.Init()())
	if got := plain(w.View()); !strings.Contains(got, "            worker :3001  npm run worker") {
		t.Errorf("the card re-reads on pop:\n%s", got)
	}
	w = press(t, w, "n")
	if w.step != stepBindings {
		t.Errorf("n moves on: step=%v", w.step)
	}
}

func TestWizard_BindingsNeedATarget(t *testing.T) {
	tmp := setupTestConfig(t)
	w, _ := cloned(t, tmp, "store-api")
	w = press(t, w, "enter")
	w.inputs[fieldPort].SetValue("3000")
	w = press(t, w, "enter")
	w = press(t, w, "n")
	// The project's own server is not a target.
	if got := plain(w.View()); !strings.Contains(got, noTargetsLine) || strings.Contains(got, "b bindings") {
		t.Errorf("only itself in the pool:\n%s", got)
	}
	if pushed(w, "b") != nil {
		t.Error("b is inert without a target")
	}
	project.Add(project.Project{Name: "signals", Path: tmp, DevServers: []project.DevServer{{Name: "signals", Port: 4000}}})
	w = settle(t, w, w.Init()())
	if got := plain(w.View()); !strings.Contains(got, "b bindings  n next") {
		t.Errorf("a target appeared on reload:\n%s", got)
	}
	if _, ok := pushed(w, "b").(project.BindingsView); !ok {
		t.Error("b pushes the bindings editor")
	}
	w = press(t, w, "n")
	if w.step != stepCheck {
		t.Errorf("n moves on: step=%v", w.step)
	}
}

// walkToCheck takes a cloned project to the check card with the given
// setup command and no servers — the check then touches no tmux.
func walkToCheck(t *testing.T, tmp, setup string) Wizard {
	t.Helper()
	w, _ := cloned(t, tmp, "store-api")
	w.inputs[fieldSetup].SetValue(setup)
	w = press(t, w, "enter")
	w = press(t, w, "n")
	w = press(t, w, "n")
	if w.step != stepCheck || w.check.phase != checkIdle {
		t.Fatalf("step=%v phase=%v", w.step, w.check.phase)
	}
	return w
}

func TestWizard_CheckPasses(t *testing.T) {
	tmp := setupTestConfig(t)
	w := walkToCheck(t, tmp, "true")
	if got := plain(w.View()); !strings.Contains(got, noSmokeLine) || !strings.Contains(got, "install   true") {
		t.Errorf("idle card:\n%s", got)
	}
	w = press(t, w, "y")
	if w.step != stepFinish || w.verdict != verdictPassed {
		t.Fatalf("after y: step=%v verdict=%v err=%v", w.step, w.verdict, w.err)
	}
	if workspace.CheckExists("store-api") {
		t.Error("a passed check removes its target")
	}
	got := plain(w.View())
	for _, want := range []string{"  Added store-api\n", "check     ✓ reproduces from nothing — target removed", "crew add workspace <workspace> store-api"} {
		if !strings.Contains(got, want) {
			t.Errorf("finish card lacks %q:\n%s", want, got)
		}
	}
	if _, cmd := w.Update(keyOf("enter")); cmd == nil {
		t.Error("enter closes the wizard")
	} else if _, ok := cmd().(app.PopPageMsg); !ok {
		t.Error("enter pops the page")
	}
}

func TestWizard_CheckInstallOnly(t *testing.T) {
	tmp := setupTestConfig(t)
	w := walkToCheck(t, tmp, "true")
	w = press(t, w, "i")
	if w.verdict != verdictInstallOnly || !strings.Contains(plain(w.View()), "✓ install — servers not smoked") {
		t.Errorf("verdict=%v\n%s", w.verdict, plain(w.View()))
	}
}

func TestWizard_CheckFailsThenAgain(t *testing.T) {
	tmp := setupTestConfig(t)
	w := walkToCheck(t, tmp, "sh -c 'echo no compiler >&2; exit 3'")
	w = press(t, w, "y")
	if w.step != stepCheck || w.check.phase != checkFailed {
		t.Fatalf("after y: step=%v phase=%v err=%v", w.step, w.check.phase, w.err)
	}
	got := plain(w.View())
	for _, want := range []string{"! install failed: store-api", "no compiler", "t install  s servers  c check again  l logs  f fix with Claude  n finish"} {
		if !strings.Contains(got, want) {
			t.Errorf("failed card lacks %q:\n%s", want, got)
		}
	}
	if !workspace.CheckExists("store-api") {
		t.Fatal("a failed check keeps its target")
	}
	if _, ok := pushed(w, "l").(workspace.LogsView); !ok {
		t.Error("l pushes the runner logs")
	}

	// t opens the install card and returns here; the project is not re-added.
	w = press(t, w, "t")
	if w.step != stepInstall || !w.fromCheck || w.inputs[fieldSetup].Value() != "sh -c 'echo no compiler >&2; exit 3'" {
		t.Fatalf("t: step=%v fromCheck=%v setup=%q", w.step, w.fromCheck, w.inputs[fieldSetup].Value())
	}
	w.inputs[fieldSetup].SetValue("true")
	w = press(t, w, "enter")
	if w.step != stepCheck || w.check.phase != checkFailed || w.fromCheck {
		t.Fatalf("enter returns to the check card: step=%v phase=%v", w.step, w.check.phase)
	}
	w = press(t, w, "s")
	if w.step != stepServers || !w.fromCheck {
		t.Fatalf("s: step=%v", w.step)
	}
	w = press(t, w, "n")
	if w.step != stepCheck {
		t.Fatalf("n returns to the check card: step=%v", w.step)
	}
	pool, _ := project.List()
	if len(pool) != 1 || pool[0].Path != project.ClonePath("store-api") {
		t.Errorf("one record, path unchanged: %+v", pool)
	}

	w = press(t, w, "c")
	if w.step != stepFinish || w.verdict != verdictPassed {
		t.Fatalf("c checks again from nothing: step=%v verdict=%v err=%v", w.step, w.verdict, w.err)
	}
}

func TestWizard_CheckFailedNKeepsTarget(t *testing.T) {
	tmp := setupTestConfig(t)
	w := walkToCheck(t, tmp, "false")
	w = press(t, w, "y")
	w = press(t, w, "n")
	if w.step != stepFinish || w.verdict != verdictFailed || !workspace.CheckExists("store-api") {
		t.Fatalf("n finishes with the failure kept: step=%v verdict=%v exists=%v", w.step, w.verdict, workspace.CheckExists("store-api"))
	}
	if !strings.Contains(plain(w.View()), "✗ kept with its evidence — crew fix check/store-api") {
		t.Errorf("finish card:\n%s", plain(w.View()))
	}
}

// c on a checkout with commits the base does not have asks first: an f
// fix not merged would be thrown away with the checkout.
func TestWizard_CheckAgainAsksAboutUnmergedFix(t *testing.T) {
	tmp := setupTestConfig(t)
	w := walkToCheck(t, tmp, "false")
	w = press(t, w, "y")
	ref := workspace.CheckRef("store-api")
	checkout := workspace.WorktreePath(ref, "store-api")
	os.WriteFile(filepath.Join(checkout, "fix.txt"), []byte("x"), 0o644)
	git(t, checkout, "add", ".")
	git(t, checkout, "-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "-m", "fix")
	w = press(t, w, "c")
	if w.check.phase != checkConfirm || !strings.Contains(plain(w.View()), "not merged into the base") {
		t.Fatalf("c with an unmerged fix asks: phase=%v\n%s", w.check.phase, plain(w.View()))
	}
	w = press(t, w, "n")
	if w.check.phase != checkFailed || !workspace.CheckExists("store-api") {
		t.Fatal("n keeps the checkout")
	}
	w = press(t, w, "c")
	w = press(t, w, "y")
	if w.check.phase != checkFailed || w.step != stepCheck {
		t.Fatalf("y replaces the checkout and checks again: phase=%v step=%v", w.check.phase, w.step)
	}
	if _, err := os.Stat(filepath.Join(checkout, "fix.txt")); !os.IsNotExist(err) {
		t.Error("the replaced checkout starts from the base again")
	}
}

func TestWizard_FixCommand(t *testing.T) {
	if !crewexec.HasClaude() {
		t.Skip("claude not installed")
	}
	tmp := setupTestConfig(t)
	w := walkToCheck(t, tmp, "false")
	w = press(t, w, "y")
	cmd, err := buildFix("store-api")
	if err != nil {
		t.Fatal(err)
	}
	if cmd.Dir != workspace.WorktreePath(workspace.CheckRef("store-api"), "store-api") {
		t.Errorf("f runs Claude in the check's checkout, got %s", cmd.Dir)
	}
}

func TestWizard_EscKeepsWhatWasRecorded(t *testing.T) {
	tmp := setupTestConfig(t)
	// esc on the source card before anything landed just leaves.
	_, cmd := newWizard().Update(keyOf("esc"))
	if cmd == nil {
		t.Fatal("esc on an empty source card pops")
	} else if _, ok := cmd().(app.PopPageMsg); !ok {
		t.Error("esc on an empty source card pops the page")
	}
	w, _ := cloned(t, tmp, "store-api")
	w.inputs[fieldSetup].SetValue("make sync")
	w = press(t, w, "esc")
	if w.step != stepFinish || w.stoppedAt != stepInstall {
		t.Fatalf("esc at install: step=%v stoppedAt=%v", w.step, w.stoppedAt)
	}
	if p := project.Get("store-api"); p == nil || p.Setup != "" {
		t.Errorf("typed text is not saved by esc; the project stays: %+v", p)
	}
	got := plain(w.View())
	for _, want := range []string{"Add project · stopped at install", "continue in crew project:  t setup  e env cmd  s servers  b bindings", "then crew check project store-api"} {
		if !strings.Contains(got, want) {
			t.Errorf("stopped card lacks %q:\n%s", want, got)
		}
	}
}

func TestWizard_EscDuringACheckLeavesItRunning(t *testing.T) {
	tmp := setupTestConfig(t)
	backgroundRunners(t)
	w := walkToCheck(t, tmp, "sleep 1")
	m, cmd := w.Update(keyOf("y"))
	w = m.(Wizard)
	if !w.applying || !strings.Contains(plain(w.View()), "starting the check") {
		t.Fatalf("y starts the check:\n%s", plain(w.View()))
	}
	// The runner is spawned; the first poll sees it alive.
	for _, msg := range runCmd(cmd) {
		m, _ = w.Update(msg)
		w = m.(Wizard)
	}
	if w.check.phase != checkRunning {
		t.Fatalf("spawned: phase=%v", w.check.phase)
	}
	m, _ = w.Update(pollCheck("store-api")())
	w = m.(Wizard)
	if w.check.status == nil || !w.check.status.Running() {
		t.Fatalf("the poll should see the runner alive: %+v", w.check.status)
	}
	if got := plain(w.View()); !strings.Contains(got, "l logs  esc leaves it running") {
		t.Errorf("running card:\n%s", got)
	}
	// Init (a pop back from the logs page) reloads the facts, and the
	// facts handler re-arms the poll while the runner is alive.
	facts := w.Init()()
	m, cmd = w.Update(facts)
	w = m.(Wizard)
	if cmd == nil {
		t.Fatal("Init while the runner is alive must poll again")
	} else if _, ok := cmd().(checkPollMsg); !ok {
		t.Error("the re-armed command is the poll")
	}
	w = press(t, w, "esc")
	if w.step != stepFinish || w.verdict != verdictRunning || !strings.Contains(plain(w.View()), "still running — crew setup status check/store-api") {
		t.Errorf("stopped mid-check: step=%v verdict=%v\n%s", w.step, w.verdict, plain(w.View()))
	}
	// A verdict that lands after esc must not rewrite the card being read.
	done := workspace.Status{Projects: []workspace.ProjectStatus{{Project: "store-api", State: workspace.StateOK}}}
	m, _ = w.Update(checkPollMsg{status: done})
	w = m.(Wizard)
	if w.verdict != verdictRunning || w.step != stepFinish {
		t.Errorf("a late poll rewrote the finish card: verdict=%v step=%v", w.verdict, w.step)
	}
}

// A refused start (here: the project vanished from the pool) is an error
// on the idle card, never a run to follow.
func TestWizard_CheckStartRefused(t *testing.T) {
	tmp := setupTestConfig(t)
	w := walkToCheck(t, tmp, "true")
	project.Remove("store-api")
	w = press(t, w, "y")
	if w.err == nil || w.check.phase != checkIdle || w.applying {
		t.Fatalf("refused start: err=%v phase=%v applying=%v", w.err, w.check.phase, w.applying)
	}
	if got := plain(w.View()); !strings.Contains(got, "y check  i install only  n skip") || !strings.Contains(got, "not found") {
		t.Errorf("idle card with the error:\n%s", got)
	}
	w = press(t, w, "esc")
	if w.verdict == verdictRunning {
		t.Error("nothing is running")
	}
}

// f only when there is a record to fix; without Claude the refusal is an
// error on the card, not silence.
func TestWizard_FixGate(t *testing.T) {
	tmp := setupTestConfig(t)
	w := walkToCheck(t, tmp, "false")
	w = press(t, w, "y")
	_, cmd := w.Update(keyRune("f"))
	if cmd == nil {
		t.Fatal("f on a failed check with a record builds the fix")
	}
	switch msg := cmd().(type) {
	case fixReadyMsg:
		if msg.cmd.Dir != workspace.WorktreePath(workspace.CheckRef("store-api"), "store-api") {
			t.Errorf("f runs Claude in the check's checkout, got %s", msg.cmd.Dir)
		}
	case errMsg:
		if crewexec.HasClaude() || !strings.Contains(msg.err.Error(), "claude not found") {
			t.Errorf("f without Claude says so: %v", msg.err)
		}
	default:
		t.Errorf("f → %T", msg)
	}
	workspace.RemoveCheck("store-api")
	w = settle(t, w, w.Init()())
	if got := plain(w.View()); strings.Contains(got, "f fix with Claude") {
		t.Errorf("no record, no f offered:\n%s", got)
	}
	if _, cmd := w.Update(keyRune("f")); cmd != nil {
		t.Error("f without a record is inert")
	}
}

// The confirm card takes y, n and esc — nothing else dismisses it.
func TestWizard_ConfirmTakesOnlyItsKeys(t *testing.T) {
	w := fixtureWizard(stepCheck)
	w.check = checkState{phase: checkConfirm, smoke: true}
	for _, k := range []string{"l", "t", "x", "enter"} {
		m, _ := w.Update(keyOf(k))
		if m.(Wizard).check.phase != checkConfirm {
			t.Errorf("%s dismissed the confirm", k)
		}
	}
	m, _ := w.Update(keyOf("esc"))
	if m.(Wizard).check.phase != checkFailed {
		t.Error("esc keeps the checkout")
	}
}

// A clone that fails leaves the card usable: the error, nothing recorded,
// and a retry with a good URL then lands.
func TestWizard_CloneFailureThenRetry(t *testing.T) {
	tmp := setupTestConfig(t)
	w := typeURL(newWizard(), "file://"+filepath.Join(tmp, "nope.git"))
	w = press(t, w, "enter")
	if w.err == nil || !strings.HasPrefix(w.err.Error(), "git clone:") || w.applying || w.step != stepSource {
		t.Fatalf("failed clone: err=%v applying=%v step=%v", w.err, w.applying, w.step)
	}
	if project.Get("nope") != nil {
		t.Error("nothing recorded")
	}
	url := bareRemote(t, tmp, "signals")
	w.inputs[fieldURL].SetValue("")
	w = typeURL(w, url)
	w = press(t, w, "enter")
	if w.err != nil || w.name != "signals" {
		t.Errorf("retry: err=%v name=%q", w.err, w.name)
	}
}

// esc on a form reopened from the failed check card returns there.
func TestWizard_EscFromReopenedForms(t *testing.T) {
	tmp := setupTestConfig(t)
	w := walkToCheck(t, tmp, "false")
	w = press(t, w, "y")
	for _, k := range []string{"t", "s"} {
		w = press(t, w, k)
		w = press(t, w, "esc")
		if w.step != stepCheck || w.check.phase != checkFailed || w.fromCheck {
			t.Errorf("%s then esc: step=%v phase=%v fromCheck=%v", k, w.step, w.check.phase, w.fromCheck)
		}
	}
}

// The name follows the URL until typed by hand, and follows again once
// the hand-typed name is cleared.
func TestWizard_NameFollowsURLUntilEdited(t *testing.T) {
	w := typeURL(newWizard(), "git@github.com:example/store")
	w = press(t, w, "tab")
	w = typeURL(w, "-api")
	w = press(t, w, "tab")
	w = typeURL(w, "-front.git")
	if got := w.inputs[fieldName].Value(); got != "store-api" {
		t.Errorf("a hand-typed name holds: %q", got)
	}
	w = press(t, w, "tab")
	w.inputs[fieldName].SetValue("x")
	m, _ := w.Update(tea.KeyMsg{Type: tea.KeyBackspace})
	w = m.(Wizard)
	w = press(t, w, "tab")
	w = typeURL(w, "/")
	if got := w.inputs[fieldName].Value(); got != "store-front" {
		t.Errorf("a cleared name follows the URL again: %q", got)
	}
}
