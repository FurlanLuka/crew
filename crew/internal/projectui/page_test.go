package projectui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// richFacts is a project with every kind of row: two servers (one with a
// dir), three bindings (resolved, scoped-unresolved, legacy form), two
// proposals (one ambiguous), a kept failed check.
func richFacts(now time.Time) pageFacts {
	return pageFacts{
		proj: project.Project{
			Name: "store-api", Path: "/repos/store-api", Setup: "make sync", EnvCmd: "make get-env",
			DevServers: []project.DevServer{{Name: "web", Port: 3000, Command: "pnpm dev", Dir: "apps/web"}, {Name: "worker", Port: 3001, Command: "pnpm worker"}},
			Bindings: []project.Binding{
				{Var: "SIGNALS_URL", Value: "{{signals}}"},
				{Var: "DB", Value: "{{infra-ops/db.host}}", Server: "worker"},
				{Var: "API_URL", Value: "{{url:store-api}}"},
			},
		},
		remote: "git@github.com:example/store-api.git",
		previews: map[dev.BindingKey][]workspace.BindingPreview{
			{Var: "SIGNALS_URL"}:          {{Ref: "store-front/main", Value: "http://localhost:54502", Resolved: true, Running: true}},
			{Var: "DB", Server: "worker"}: {{Ref: "store-front/main", Detail: "infra-ops has no server db"}},
			{Var: "API_URL"}:              {{Ref: "store-front/main", Value: "http://localhost:54494", Resolved: true}},
		},
		proposals: []dev.Proposal{
			{Var: "STORE_APP_URL", Value: "http://localhost:3001", Port: 3001, Template: "{{store-app}}"},
			{Var: "ADMIN_URL", Value: "http://localhost:4000", Port: 4000, Ambiguous: true},
		},
		check: workspace.CheckInfo{State: workspace.CheckFailed, At: now.Add(-2*time.Hour - time.Minute), Health: &workspace.Health{
			At:     now.Add(-2*time.Hour - time.Minute),
			Issues: []workspace.Issue{{Stage: "install", Project: "store-api", Reason: "make sync", Detail: "cc: command not found"}},
		}},
		now: now,
	}
}

func TestRenderProjectPage_RichGolden(t *testing.T) {
	f := richFacts(time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC))
	rows := pageRows(f)
	body, cursorLine := renderProjectPage(f, rows, 0, formBlock{}, checkCard{name: "store-api"})
	got := plain(body)
	want := strings.Join([]string{
		"  git@github.com:example/store-api.git · /repos/store-api (adopted)",
		"",
		"  ! install failed: store-api · 2 hours ago",
		"    install   store-api   cc: command not found",
		"",
		"  Install",
		"  > setup           make sync",
		"    env             make get-env",
		"                     a new checkout runs  make sync → env: make get-env",
		"  Servers",
		"    web             :3000   pnpm dev  dir:apps/web",
		"    worker          :3001   pnpm worker",
		"  Bindings",
		"    SIGNALS_URL     {{signals}}            → http://localhost:54502  in store-front/main",
		"    DB (worker)     {{infra-ops/db.host}}  → left alone  infra-ops has no server db",
		"    API_URL         {{url:store-api}}      · old form  → http://localhost:54494  in store-front/main · stopped",
		"    ○ STORE_APP_URL {{store-app}}          found in .env — enter adds it",
		"    ○ ADMIN_URL     ? two projects on :4000 — enter picks by hand",
		"  Check",
		"                    ✗ install failed: store-api · 2 hours ago — f fix with Claude  c check again  l logs",
		"",
	}, "\n")
	if got != want {
		t.Errorf("rich page =\n%s\nwant\n%s", got, want)
	}
	if cursorLine != 6 {
		t.Errorf("cursor line = %d, want the setup row", cursorLine)
	}
	// The cursor's line follows the cursor.
	if _, line := renderProjectPage(f, rows, rowFor(rows, rowCheck), formBlock{}, checkCard{name: "store-api"}); line != 19 {
		t.Errorf("cursor on the check row = line %d", line)
	}
}

func TestRenderProjectPage_EmptyGolden(t *testing.T) {
	f := pageFacts{proj: project.Project{Name: "docs", Path: "/repos/docs"}, now: time.Now()}
	body, _ := renderProjectPage(f, pageRows(f), 0, formBlock{}, checkCard{name: "docs"})
	want := strings.Join([]string{
		"  — · /repos/docs (adopted)",
		"",
		"  Install",
		"  > setup           —",
		"    env             —",
		"                     a new checkout runs  —",
		"  Servers",
		"                    none — a adds one; the command must listen on $PORT",
		"  Bindings",
		"                    none — a adds one; a binding points a var at a sibling's port",
		"  Check",
		"                    no check on record — c checks it",
		"",
	}, "\n")
	if got := plain(body); got != want {
		t.Errorf("empty page =\n%s\nwant\n%s", got, want)
	}
}

// With a form open the other sections collapse to a line each and the
// health block steps aside; the form renders in its section.
func TestRenderProjectPage_FormOpenCollapses(t *testing.T) {
	f := richFacts(time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC))
	rows := pageRows(f)
	body, _ := renderProjectPage(f, rows, rowFor(rows, rowServer), formBlock{sectionServers, "  Adding server\n"}, checkCard{name: "store-api"})
	got := plain(body)
	for _, want := range []string{"  Install · make sync → env: make get-env\n", "  Servers\n", "  Adding server\n", "  Bindings 3 · 2 found\n", "  Check · ✗\n"} {
		if !strings.Contains(got, want) {
			t.Errorf("collapsed page lacks %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "! install failed") || strings.Contains(got, "SIGNALS_URL") {
		t.Errorf("the other sections stay collapsed while a form is open:\n%s", got)
	}
}

// resolveCheck is the one triage of the record and the card; checkLine
// words it. The card wins while it is the one that ran.
func TestResolveCheckAndLine(t *testing.T) {
	now := time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)
	h := &workspace.Health{Issues: []workspace.Issue{{Stage: "install", Project: "api"}}}
	failed := workspace.CheckInfo{State: workspace.CheckFailed, At: now.Add(-3 * time.Hour), Health: h}
	passed := workspace.CheckInfo{State: workspace.CheckPassed, At: now.Add(-2 * 24 * time.Hour), Smoked: true}
	for name, tt := range map[string]struct {
		info       workspace.CheckInfo
		card       checkCard
		hasServers bool
		view       checkView
		line       string
	}{
		"none":            {workspace.CheckInfo{}, checkCard{}, true, checkView{}, "no check on record — c checks it"},
		"passed":          {passed, checkCard{}, true, checkView{phase: checkPassed, at: passed.At, smoked: true}, "✓ reproduces from nothing · 2 days ago — c checks again"},
		"install only":    {workspace.CheckInfo{State: workspace.CheckPassed, At: now.Add(-25 * time.Hour)}, checkCard{}, true, checkView{phase: checkPassed, at: now.Add(-25 * time.Hour)}, "✓ install — servers not smoked · 1 day ago — c checks again"},
		"no servers":      {workspace.CheckInfo{State: workspace.CheckPassed, At: now.Add(-25 * time.Hour)}, checkCard{}, false, checkView{phase: checkPassed, at: now.Add(-25 * time.Hour)}, "✓ reproduces from nothing · 1 day ago — c checks again"},
		"failed kept":     {failed, checkCard{}, true, checkView{phase: checkFailed, health: h, at: failed.At, kept: true}, "✗ install failed: api · 3 hours ago — f fix with Claude  c check again  l logs"},
		"vanished":        {workspace.CheckInfo{State: workspace.CheckFailed, At: failed.At}, checkCard{}, true, checkView{phase: checkFailed, at: failed.At, kept: true}, "✗ the runner vanished · 3 hours ago — f fix with Claude  c check again  l logs"},
		"running on disk": {workspace.CheckInfo{State: workspace.CheckRunning}, checkCard{}, true, checkView{phase: checkRunning, running: true}, "● running — l logs"},
		"card running":    {passed, checkCard{phase: checkRunning}, true, checkView{phase: checkRunning, running: true}, "● running — l logs"},
		"card failed":     {passed, checkCard{phase: checkFailed, health: h, kept: true}, true, checkView{phase: checkFailed, health: h, at: passed.At, kept: true}, "✗ install failed: api · 2 days ago — f fix with Claude  c check again  l logs"},
		"card passed":     {failed, checkCard{phase: checkPassed, smoke: true}, true, checkView{phase: checkPassed, at: failed.At, smoked: true}, "✓ reproduces from nothing · 3 hours ago — c checks again"},
	} {
		v := resolveCheck(tt.info, tt.card)
		if v != tt.view {
			t.Errorf("%s: view = %+v, want %+v", name, v, tt.view)
		}
		if got := plain(checkLine(v, tt.hasServers, now)); got != tt.line {
			t.Errorf("%s: %q, want %q", name, got, tt.line)
		}
	}
}

// d's question names the row and what goes with it — a server's scoped
// bindings counted as RemoveDevServer will drop them.
func TestConfirmPrompt(t *testing.T) {
	p := project.Project{
		DevServers: []project.DevServer{{Name: "web"}, {Name: "worker"}},
		Bindings:   []project.Binding{{Var: "DB", Value: "x"}, {Var: "DB", Value: "y", Server: "worker"}, {Var: "Q", Value: "z", Server: "worker"}},
	}
	rows := pageRows(pageFacts{proj: p, proposals: []dev.Proposal{{Var: "P"}}})
	for _, tt := range []struct {
		kind rowKind
		key  string
		want string
	}{
		{rowServer, "web", "Remove server 'web'? (y/n)"},
		{rowServer, "worker", "Remove server 'worker' and the 2 binding(s) scoped to it? (y/n)"},
		{rowBinding, "DB (worker)", "Remove binding 'DB (worker)'? (y/n)"},
		{rowBinding, "DB", "Remove binding 'DB'? (y/n)"},
		{rowSetup, "setup", ""},
		{rowProposal, "P", ""},
		{rowCheck, "check", ""},
	} {
		if got := confirmPrompt(p, rows[findRow(rows, tt.kind, tt.key)]); got != tt.want {
			t.Errorf("%s: %q, want %q", tt.key, got, tt.want)
		}
	}
}

// ── Flows ──

// pagePool is a pool with the project under test, a sibling with a
// server (a binding target), and one workspace holding the project with a
// reserved port — enough for a preview, no git needed.
func pagePool(t *testing.T) string {
	t.Helper()
	tmp := setupTestConfig(t)
	repo := filepath.Join(tmp, "repos", "store-api")
	os.MkdirAll(repo, 0o755)
	os.WriteFile(filepath.Join(repo, ".env"), []byte("SIGNALS_URL=http://localhost:4000\nPORT=3000\n"), 0o644)
	project.Add(project.Project{Name: "store-api", Path: repo, DevServers: []project.DevServer{{Name: "web", Port: 3000, Command: "pnpm dev"}, {Name: "worker", Port: 3001, Command: "pnpm worker"}}})
	project.Add(project.Project{Name: "signals", Path: filepath.Join(tmp, "repos", "signals"), DevServers: []project.DevServer{{Name: "signals", Port: 4000, Command: "go run ."}}})
	workspace.Save(&workspace.Workspace{
		Name:      "store-front",
		Projects:  []workspace.WorkspaceProject{{Name: "store-api"}, {Name: "signals"}},
		Worktrees: []workspace.Worktree{{Name: "main", Ports: map[string]int{"store-api/web": 54494, "store-api/worker": 54495, "signals/signals": 54502}}},
	})
	return tmp
}

// settlePage runs a page's Init and feeds every message back.
func settlePage(t *testing.T, p Page) Page {
	t.Helper()
	m := tea.Model(p)
	for _, msg := range runCmd(p.Init()) {
		m = settle(t, m, msg)
	}
	return m.(Page)
}

func pressPage(t *testing.T, p Page, k string) Page {
	t.Helper()
	return settle(t, p, keyOf(k)).(Page)
}

func TestPage_LoadsAndJumps(t *testing.T) {
	pagePool(t)
	p := settlePage(t, NewPage("store-api", rowBinding))
	got := plain(p.View())
	for _, want := range []string{"web             :3000   pnpm dev", "○ SIGNALS_URL", "{{signals}}", "found in .env — enter adds it", "no check on record"} {
		if !strings.Contains(got, want) {
			t.Errorf("page lacks %q:\n%s", want, got)
		}
	}
	// No binding yet: b lands on the first proposal, the section's own row.
	if p.rows[p.cursor].Kind != rowProposal {
		t.Errorf("b landed on %+v", p.rows[p.cursor])
	}
	p = pressPage(t, p, "t")
	if p.rows[p.cursor].Kind != rowSetup {
		t.Errorf("t lands on setup: %+v", p.rows[p.cursor])
	}
	p = pressPage(t, p, "s")
	if p.rows[p.cursor].Kind != rowServer || p.rows[p.cursor].Key != "web" {
		t.Errorf("s lands on the first server: %+v", p.rows[p.cursor])
	}
}

func TestPage_EditsSetupInPlace(t *testing.T) {
	pagePool(t)
	p := settlePage(t, NewPage("store-api", rowSetup))
	p = pressPage(t, p, "enter")
	if p.open != openCommand || !strings.Contains(plain(p.View()), "Leave empty to detect from the lockfile") {
		t.Fatalf("enter opens the command form under the row:\n%s", plain(p.View()))
	}
	// Letters go to the field, not the page.
	for _, r := range "make sync" {
		p = pressPage(t, p, string(r))
	}
	if p.open != openCommand || p.cmdInput.Value() != "make sync" {
		t.Fatalf("typed into the form: open=%v value=%q", p.open, p.cmdInput.Value())
	}
	p = pressPage(t, p, "enter")
	if p.open != openNone || project.Get("store-api").Setup != "make sync" {
		t.Fatalf("enter saves and closes: open=%v setup=%q", p.open, project.Get("store-api").Setup)
	}
	if got := plain(p.View()); !strings.Contains(got, "> setup           make sync") || !strings.Contains(got, "Saved") {
		t.Errorf("the row shows the save:\n%s", got)
	}
	p = pressPage(t, p, "e")
	p = pressPage(t, p, "enter")
	if !strings.Contains(plain(p.View()), "not print values") {
		t.Errorf("the env form keeps its hint:\n%s", plain(p.View()))
	}
	p = pressPage(t, p, "esc")
	if p.open != openNone || p.rows[p.cursor].Kind != rowEnv {
		t.Errorf("esc closes the form and stays on the row: open=%v row=%+v", p.open, p.rows[p.cursor])
	}
}

func TestPage_ServersAddRenameRemove(t *testing.T) {
	pagePool(t)
	project.AddBinding("store-api", project.Binding{Var: "DB", Value: "{{signals.host}}", Server: "worker"})
	p := settlePage(t, NewPage("store-api", rowServer))
	p = pressPage(t, p, "a")
	if p.open != openServer {
		t.Fatal("a in Servers opens the server form")
	}
	p.serverForm.inputs[serverName].SetValue("api")
	p.serverForm.inputs[serverPort].SetValue("8000")
	p.serverForm.inputs[serverCommand].SetValue("uvicorn app --port $PORT")
	p = pressPage(t, p, "enter")
	if p.open != openNone || len(project.Get("store-api").DevServers) != 3 {
		t.Fatalf("the form records: open=%v servers=%+v", p.open, project.Get("store-api").DevServers)
	}
	if !strings.Contains(plain(p.View()), "api             :8000   uvicorn app --port $PORT") {
		t.Errorf("the new row shows:\n%s", plain(p.View()))
	}
	// enter on a server edits it; a rename keeps the scoped binding.
	p.cursor = findRow(p.rows, rowServer, "worker")
	p = pressPage(t, p, "enter")
	p.serverForm.inputs[serverName].SetValue("jobs")
	p = pressPage(t, p, "enter")
	if pr := project.Get("store-api"); pr.Bindings[0].Server != "jobs" {
		t.Errorf("a rename re-scopes: %+v", pr.Bindings)
	}
	if p.rows[p.cursor].Key != "jobs" {
		t.Errorf("the cursor follows the renamed row: %+v", p.rows[p.cursor])
	}
	// d asks, naming the scoped binding, then removes both.
	p = pressPage(t, p, "d")
	if p.confirm == nil || !strings.Contains(plain(p.View()), "Remove server 'jobs' and the 1 binding(s) scoped to it? (y/n)") {
		t.Fatalf("d asks:\n%s", plain(p.View()))
	}
	p = pressPage(t, p, "y")
	if pr := project.Get("store-api"); len(pr.DevServers) != 2 || len(pr.Bindings) != 0 {
		t.Errorf("removed with its binding: %+v %+v", pr.DevServers, pr.Bindings)
	}
	// d on setup is a no-op.
	p = pressPage(t, p, "t")
	p = pressPage(t, p, "d")
	if p.confirm != nil {
		t.Error("d on setup asks nothing")
	}
	// With every server gone, s lands on the placeholder and a adds there.
	for _, name := range []string{"web", "api"} {
		project.RemoveDevServer("store-api", name)
	}
	p = settle(t, p, savedMsg{section: sectionServers}).(Page)
	p = pressPage(t, p, "s")
	if p.rows[p.cursor].Kind != rowNoServers {
		t.Fatalf("s with no servers lands on the placeholder: %+v", p.rows[p.cursor])
	}
	p = pressPage(t, p, "a")
	if p.open != openServer {
		t.Error("a on the placeholder opens the server form")
	}
}

func TestPage_BindingsProposalsAndEditor(t *testing.T) {
	pagePool(t)
	p := settlePage(t, NewPage("store-api", rowSetup))
	if len(p.facts.proposals) != 1 || p.facts.proposals[0].Var != "SIGNALS_URL" {
		t.Fatalf("the scan proposes what points at a sibling's port: %+v", p.facts.proposals)
	}
	// enter on the proposal adds it as proposed; the row leaves the list.
	p.cursor = rowFor(p.rows, rowProposal)
	p = pressPage(t, p, "enter")
	pr := project.Get("store-api")
	if len(pr.Bindings) != 1 || pr.Bindings[0].Value != "{{signals}}" || len(p.facts.proposals) != 0 {
		t.Fatalf("proposal added: %+v, left %+v", pr.Bindings, p.facts.proposals)
	}
	if got := plain(p.View()); !strings.Contains(got, "SIGNALS_URL     {{signals}}  → http://localhost:54502  in store-front/main · stopped") {
		t.Errorf("the binding row previews against the reserved port:\n%s", got)
	}
	// a in Bindings opens the editor; typing abc lands in the var field —
	// a and c are letters there, not actions.
	p.cursor = rowFor(p.rows, rowBinding)
	p = pressPage(t, p, "a")
	if p.open != openBinding {
		t.Fatal("a in Bindings opens the editor")
	}
	for _, r := range "abc" {
		p = pressPage(t, p, string(r))
	}
	if p.open != openBinding || p.editor.varInput.Value() != "abc" || p.check.phase != checkIdle {
		t.Fatalf("letters go to the field: open=%v var=%q phase=%v", p.open, p.editor.varInput.Value(), p.check.phase)
	}
	// A reload landing while the editor is open leaves the draft alone.
	p = settle(t, p, loadPageFacts("store-api")()).(Page)
	if p.open != openBinding || p.editor.varInput.Value() != "abc" {
		t.Errorf("a reload under an open editor: open=%v var=%q", p.open, p.editor.varInput.Value())
	}
	for range "abc" {
		p = settle(t, p, tea.KeyMsg{Type: tea.KeyBackspace}).(Page)
	}
	for _, r := range "SIGNALS_HOST" {
		p = pressPage(t, p, string(r))
	}
	p = pressPage(t, p, "tab")
	p = pressPage(t, p, "tab") // past the scope field (two servers)
	for _, r := range "{{signals.host}}" {
		p = pressPage(t, p, string(r))
	}
	p = pressPage(t, p, "enter")
	pr = project.Get("store-api")
	if len(pr.Bindings) != 2 || pr.Bindings[1].Var != "SIGNALS_HOST" || pr.Bindings[1].Value != "{{signals.host}}" {
		t.Fatalf("the editor saves what is typed: %+v", pr.Bindings)
	}
	if p.open != openNone || p.rows[p.cursor].Key != "SIGNALS_HOST" {
		t.Errorf("the cursor lands on the saved row: %+v", p.rows[p.cursor])
	}
	// enter on a scoped row opens the editor on that scope; a changed
	// scope leaves one binding.
	project.AddBinding("store-api", project.Binding{Var: "DB", Value: "x", Server: "worker"})
	p = settle(t, p, savedMsg{section: sectionBindings}).(Page)
	p.cursor = findRow(p.rows, rowBinding, "DB (worker)")
	p = pressPage(t, p, "enter")
	if p.open != openBinding || p.editor.draft.Server != "worker" {
		t.Fatalf("enter on a scoped row: %+v", p.editor)
	}
	p.editor.draft.Server = "web"
	p = pressPage(t, p, "enter")
	if pr := project.Get("store-api"); len(project.BoundFor(pr.Bindings, "web")) != 3 || len(pr.Bindings) != 3 {
		t.Errorf("the old scope goes: %+v", pr.Bindings)
	}
	p = pressPage(t, p, "d")
	if !strings.Contains(plain(p.View()), "Remove binding 'DB (web)'? (y/n)") {
		t.Errorf("d names the scoped label:\n%s", plain(p.View()))
	}
	p = pressPage(t, p, "n")
	if p.confirm != nil || len(project.Get("store-api").Bindings) != 3 {
		t.Error("n keeps it")
	}
}

func TestPage_AddAllProposals(t *testing.T) {
	tmp := pagePool(t)
	repo := project.Get("store-api").Path
	os.WriteFile(filepath.Join(repo, ".env"), []byte("SIGNALS_URL=http://localhost:4000\nSIGNALS_HOST=localhost:4000\nOTHER=http://localhost:9999\n"), 0o644)
	_ = tmp
	p := settlePage(t, NewPage("store-api", rowSetup))
	if len(p.facts.proposals) != 2 {
		t.Fatalf("proposals = %+v", p.facts.proposals)
	}
	p = pressPage(t, p, "A")
	if pr := project.Get("store-api"); len(pr.Bindings) != 2 || len(p.facts.proposals) != 0 {
		t.Errorf("A adds every unambiguous proposal: %+v, left %+v", pr.Bindings, p.facts.proposals)
	}
}

func TestPage_EscLevelsAndQuit(t *testing.T) {
	pagePool(t)
	p := settlePage(t, NewPage("store-api", rowSetup))
	if _, cmd := p.Update(keyOf("esc")); cmd == nil {
		t.Fatal("esc pops")
	} else if _, ok := cmd().(app.PopPageMsg); !ok {
		t.Error("esc pops the page")
	}
	if !quits(p, "q") {
		t.Error("q quits with no form open")
	}
	p = pressPage(t, p, "s")
	p = pressPage(t, p, "a")
	if quits(p, "q") {
		t.Error("q is a letter while a form is open")
	}
	if !quits(p, "ctrl+c") {
		t.Error("ctrl+c quits everywhere")
	}
}

func TestPage_CheckPassesThenFails(t *testing.T) {
	tmp := setupTestConfig(t)
	repo := filepath.Join(tmp, "repos", "docs")
	os.MkdirAll(repo, 0o755)
	git(t, repo, "init", "-q", "-b", "main")
	git(t, repo, "-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
	project.Add(project.Project{Name: "docs", Path: repo, Setup: "true"})

	p := settlePage(t, NewPage("docs", rowSetup))
	p.cursor = rowFor(p.rows, rowCheck)
	p = pressPage(t, p, "c")
	if p.check.phase != checkPassed || p.facts.check.State != workspace.CheckPassed {
		t.Fatalf("c passes: phase=%v disk=%v err=%v", p.check.phase, p.facts.check.State, p.err)
	}
	if got := plain(p.View()); !strings.Contains(got, "✓ reproduces from nothing · just now — c checks again") {
		t.Errorf("the row reads the verdict:\n%s", got)
	}
	// A second reload is idempotent: the target stays gone, the ✓ stays.
	p = settlePage(t, p)
	if p.facts.check.State != workspace.CheckPassed || workspace.CheckExists("docs") {
		t.Errorf("reload after a pass: %+v", p.facts.check)
	}

	project.SetSetup("docs", "sh -c 'echo no compiler >&2; exit 3'")
	p = settle(t, p, savedMsg{section: sectionInstall}).(Page)
	p = pressPage(t, p, "c")
	if p.check.phase != checkFailed || p.facts.check.State != workspace.CheckFailed {
		t.Fatalf("c fails: phase=%v disk=%v", p.check.phase, p.facts.check.State)
	}
	got := plain(p.View())
	for _, want := range []string{"! install failed: docs · just now", "no compiler", "f fix with Claude  c check again  l logs"} {
		if !strings.Contains(got, want) {
			t.Errorf("failed page lacks %q:\n%s", want, got)
		}
	}
	if _, ok := pushed(p, "l").(workspace.LogsView); !ok {
		t.Error("l pushes the runner logs")
	}
	// t edits the setup in place; c again passes.
	p = pressPage(t, p, "t")
	p = pressPage(t, p, "enter")
	p.cmdInput.SetValue("true")
	p = pressPage(t, p, "enter")
	p = pressPage(t, p, "c")
	if p.check.phase != checkPassed || workspace.CheckExists("docs") {
		t.Errorf("c after the fix: phase=%v kept=%v", p.check.phase, workspace.CheckExists("docs"))
	}
	// A refused start (the project is gone) is an error on the row.
	project.Remove("docs")
	p = pressPage(t, p, "c")
	if p.err == nil || p.check.phase == checkRunning {
		t.Errorf("refused start: err=%v phase=%v", p.err, p.check.phase)
	}
}

func TestPage_WindowsAroundTheCursor(t *testing.T) {
	pagePool(t)
	p := settlePage(t, NewPage("store-api", rowSetup))
	p.height = 12
	top := plain(p.View())
	if !strings.Contains(top, "Install") || strings.Contains(top, "no check on record") {
		t.Errorf("a short terminal shows the top with the cursor there:\n%s", top)
	}
	p.cursor = rowFor(p.rows, rowCheck)
	bottom := plain(p.View())
	if !strings.Contains(bottom, "no check on record") || !strings.Contains(bottom, "c check  esc back") {
		t.Errorf("the window follows the cursor and keeps the keys:\n%s", bottom)
	}
}

// The cursor is moved by keys; the prefix renders where it is; a and d
// are no-ops where there is nothing to add or remove.
func TestPage_CursorWalk(t *testing.T) {
	pagePool(t)
	project.AddBinding("store-api", project.Binding{Var: "A", Value: "x"})
	p := settlePage(t, NewPage("store-api", rowSetup))
	var walked []rowKind
	for i := 0; i < len(p.rows); i++ {
		walked = append(walked, p.rows[p.cursor].Kind)
		if got := plain(p.View()); !strings.Contains(got, "  > ") {
			t.Errorf("no cursor rendered at row %d:\n%s", i, got)
		}
		p = settle(t, p, tea.KeyMsg{Type: tea.KeyDown}).(Page)
	}
	want := []rowKind{rowSetup, rowEnv, rowServer, rowServer, rowBinding, rowProposal, rowCheck}
	if len(walked) != len(want) {
		t.Fatalf("walked %v", walked)
	}
	for i := range want {
		if walked[i] != want[i] {
			t.Errorf("row %d = %v, want %v", i, walked[i], want[i])
		}
	}
	if p.cursor != len(p.rows)-1 {
		t.Error("down stops at the last row")
	}
	// a on Check, d on a proposal: nothing happens.
	p = pressPage(t, p, "a")
	if p.open != openNone {
		t.Error("a on the check row adds nothing")
	}
	p = settle(t, p, tea.KeyMsg{Type: tea.KeyUp}).(Page)
	p = pressPage(t, p, "d")
	if p.confirm != nil {
		t.Error("d on a proposal asks nothing — it leaves when bound")
	}
	p.cursor = rowFor(p.rows, rowSetup)
	p = pressPage(t, p, "a")
	if p.open != openNone {
		t.Error("a on Install adds nothing")
	}
}

// An ambiguous proposal (two projects on its port) opens the editor
// prefilled; A skips it and takes the rest; past the cap the rest fold
// into one line A still takes.
func TestPage_AmbiguousAndFoldedProposals(t *testing.T) {
	tmp := pagePool(t)
	project.Add(project.Project{Name: "admin", Path: filepath.Join(tmp, "repos", "admin"), DevServers: []project.DevServer{{Name: "admin", Port: 4000, Command: "x"}}})
	repo := project.Get("store-api").Path
	os.WriteFile(filepath.Join(repo, ".env"), []byte("SIGNALS_URL=http://localhost:4000\nA1=http://localhost:4000\nA2=http://localhost:4000\nA3=http://localhost:4000\nA4=http://localhost:4000\n"), 0o644)
	p := settlePage(t, NewPage("store-api", rowBinding))
	if len(p.facts.proposals) != 5 || !p.facts.proposals[0].Ambiguous {
		t.Fatalf("proposals = %+v", p.facts.proposals)
	}
	if got := plain(p.View()); !strings.Contains(got, "? two projects on :4000 — enter picks by hand") || !strings.Contains(got, "○ +2 more found — A adds all") {
		t.Errorf("ambiguous and folded rows:\n%s", got)
	}
	p = pressPage(t, p, "enter")
	if p.open != openBinding || p.editor.varInput.Value() != p.facts.proposals[0].Var {
		t.Fatalf("enter on an ambiguous proposal opens the editor prefilled: open=%v var=%q", p.open, p.editor.varInput.Value())
	}
	p = pressPage(t, p, "esc")
	p = pressPage(t, p, "A")
	if pr := project.Get("store-api"); len(pr.Bindings) != 0 {
		t.Errorf("A adds nothing when every proposal is ambiguous: %+v", pr.Bindings)
	}
}

// A save the pool refuses keeps the form open with the error.
func TestPage_RejectedSaveKeepsTheForm(t *testing.T) {
	pagePool(t)
	p := settlePage(t, NewPage("store-api", rowBinding))
	p = pressPage(t, p, "a")
	for _, r := range "NOPE" {
		p = pressPage(t, p, string(r))
	}
	p = pressPage(t, p, "tab")
	p = pressPage(t, p, "tab")
	for _, r := range "{{ghost}}" {
		p = pressPage(t, p, string(r))
	}
	p = pressPage(t, p, "enter")
	if p.open != openBinding || p.err == nil || p.editor.valueInput.Value() != "{{ghost}}" {
		t.Errorf("refused: open=%v err=%v value=%q", p.open, p.err, p.editor.valueInput.Value())
	}
}

// A runner alive on disk is followed: the page polls, Init re-arms the
// poll after a pop, and esc leaves the runner going.
func TestPage_FollowsALiveRunner(t *testing.T) {
	tmp := setupTestConfig(t)
	backgroundRunners(t)
	repo := filepath.Join(tmp, "repos", "docs")
	os.MkdirAll(repo, 0o755)
	git(t, repo, "init", "-q", "-b", "main")
	git(t, repo, "-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
	project.Add(project.Project{Name: "docs", Path: repo, Setup: "sleep 1"})
	p := settlePage(t, NewPage("docs", rowSetup))
	p.cursor = rowFor(p.rows, rowCheck)
	m, cmd := p.Update(keyOf("c"))
	p = m.(Page)
	for _, msg := range runCmd(cmd) {
		m, _ = p.Update(msg)
		p = m.(Page)
	}
	m, _ = p.Update(pollCheck("docs")())
	p = m.(Page)
	if p.check.phase != checkRunning || !strings.Contains(plain(p.View()), "l logs  esc back") {
		t.Fatalf("running: phase=%v\n%s", p.check.phase, plain(p.View()))
	}
	// Init (a pop back from the logs page) re-reads and re-arms the poll.
	facts := loadPageFacts("docs")()
	m, cmd = p.Update(facts)
	p = m.(Page)
	if cmd == nil {
		t.Fatal("Init while the runner is alive must poll again")
	}
	if _, ok := cmd().(checkPollMsg); !ok {
		t.Error("the re-armed command is the poll")
	}
	if _, cmd := p.Update(keyOf("esc")); cmd == nil {
		t.Error("esc leaves the runner and pops")
	} else if _, ok := cmd().(app.PopPageMsg); !ok {
		t.Error("esc pops the page")
	}
	// A fresh page on the same project follows the runner it finds on disk.
	fresh := NewPage("docs", rowSetup)
	m, cmd = fresh.Update(loadPageFacts("docs")())
	fresh = m.(Page)
	if fresh.check.phase != checkRunning || cmd == nil {
		t.Errorf("a runner started elsewhere is followed: phase=%v", fresh.check.phase)
	}
}

// A page opened after a failed check acts on it: the health block is on
// top, l opens the logs, f builds the fix, c guards an unmerged fix.
func TestPage_KeptFailedCheck(t *testing.T) {
	tmp := setupTestConfig(t)
	repo := filepath.Join(tmp, "repos", "docs")
	os.MkdirAll(repo, 0o755)
	git(t, repo, "init", "-q", "-b", "main")
	git(t, repo, "-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
	project.Add(project.Project{Name: "docs", Path: repo, Setup: "false"})
	if err := workspace.StartCheck("docs", workspace.CheckoutOptions{Install: true}); err != nil {
		t.Fatal(err)
	}
	p := settlePage(t, NewPage("docs", rowSetup))
	got := plain(p.View())
	if p.check.phase != checkFailed || !strings.Contains(got, "! install failed: docs") || !strings.Contains(got, "f fix with Claude  c check again  l logs") {
		t.Fatalf("a kept failure is adopted:\n%s", got)
	}
	if _, ok := pushed(p, "l").(workspace.LogsView); !ok {
		t.Error("l pushes the logs")
	}
	if _, cmd := p.Update(keyOf("f")); cmd == nil {
		t.Error("f builds the fix")
	}
	// A fix committed on the scratch branch: c asks before replacing it.
	ref := workspace.CheckRef("docs")
	checkout := workspace.WorktreePath(ref, "docs")
	os.WriteFile(filepath.Join(checkout, "fix.txt"), []byte("x"), 0o644)
	git(t, checkout, "add", ".")
	git(t, checkout, "-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "-m", "fix")
	p = pressPage(t, p, "c")
	if p.check.phase != checkConfirm || !strings.Contains(plain(p.View()), "not merged into the base") {
		t.Fatalf("c with an unmerged fix asks: phase=%v\n%s", p.check.phase, plain(p.View()))
	}
	p = pressPage(t, p, "n")
	if p.check.phase != checkFailed {
		t.Error("n keeps the checkout")
	}
	// The record removed elsewhere: the card lets go of it.
	workspace.RemoveCheck("docs")
	p = settlePage(t, p)
	if p.check.phase != checkIdle || strings.Contains(plain(p.View()), "f fix") {
		t.Errorf("a removed record leaves nothing to act on: phase=%v\n%s", p.check.phase, plain(p.View()))
	}
}

// The pending cursor: a jump waits for both loads; a save's key is
// followed once its row exists.
func TestPage_PendingCursor(t *testing.T) {
	pagePool(t)
	p := NewPage("store-api", rowServer)
	p = settle(t, p, loadPageFacts("store-api")()).(Page)
	if p.pending == nil {
		t.Fatal("the jump waits for the scan")
	}
	p = settle(t, p, loadPageScan("store-api")()).(Page)
	if p.pending != nil || p.rows[p.cursor].Key != "web" {
		t.Errorf("both loads in → the jump lands: %+v", p.rows[p.cursor])
	}
	p = settle(t, p, savedMsg{section: sectionServers, key: "worker"}).(Page)
	if p.rows[p.cursor].Key != "worker" {
		t.Errorf("a save's key is followed: %+v", p.rows[p.cursor])
	}
}
