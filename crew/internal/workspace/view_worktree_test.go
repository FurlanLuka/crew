package workspace

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
)

func pageFixture() worktreePage {
	return worktreePage{
		Dir:     "/w/store-front/wrk1",
		Session: "crew-dev-store-front--wrk1",
		Items: []devItem{
			{ProjectName: "store-api", Server: project.DevServer{Name: "store-api", Port: 3000}, Running: true, Port: 54494, URL: "http://localhost:54494"},
			{ProjectName: "checkout-api", Server: project.DevServer{Name: "store-front-worker", Port: 8003}},
		},
		Anomalies:   "  checkout-api\n    GONE  left alone — not in workspace\n",
		LeadProject: "store-api",
		LeadBranch:  "feature/s4b-3071",
		HasEditor:   true,
		HasSSH:      true,
	}
}

func TestWorktreeRows(t *testing.T) {
	items := pageFixture().Items

	all := worktreeRows(items, true, true)
	kinds := make([]rowKind, 0, len(all))
	for _, r := range all {
		kinds = append(kinds, r.Kind)
	}
	want := []rowKind{rowServer, rowServer, rowLaunchEditor, rowLaunchClaude, rowOpenRemote, rowOpenShell}
	if len(kinds) != len(want) {
		t.Fatalf("rows = %v, want %v", kinds, want)
	}
	for i := range want {
		if kinds[i] != want[i] {
			t.Errorf("row %d = %v, want %v", i, kinds[i], want[i])
		}
	}
	if all[1].Item != 1 {
		t.Errorf("second server row points at item %d, want 1", all[1].Item)
	}

	// No editor, no ssh: the rows disappear rather than sit there and fail.
	bare := worktreeRows(items, false, false)
	if len(bare) != 4 {
		t.Errorf("without editor/ssh got %d rows, want 4", len(bare))
	}
	if bare[2].Kind != rowLaunchClaude || bare[3].Kind != rowOpenShell {
		t.Errorf("bare rows = %+v", bare)
	}
}

func TestRenderWorktreePage_Golden(t *testing.T) {
	page := pageFixture()
	rows := worktreeRows(page.Items, true, true)

	var b strings.Builder
	renderWorktreePage(&b, page, rows, 0, false)
	got := stripANSI(b.String())

	want := strings.Join([]string{
		"  /w/store-front/wrk1",
		"  proxy: on",
		"",
		"  Servers  crew-dev-store-front--wrk1",
		"  > store-api           ● :54494   http://localhost:54494",
		"    store-front-worker  ○ stopped",
		"",
		"    checkout-api",
		"      GONE  left alone — not in workspace",
		"",
		"  Launch",
		"    Editor + Claude             store-api · feature/s4b-3071",
		"    Claude in terminal          ",
		"",
		"  Open",
		"    Cursor / VS Code (remote)",
		"    Shell here",
		"",
	}, "\n")

	if got != want {
		t.Errorf("page =\n%s\nwant\n%s", got, want)
	}
}

func TestRenderWorktreePage_CleanHasNoAnomalyBlock(t *testing.T) {
	page := pageFixture()
	page.Anomalies = ""
	page.HasEditor = false
	page.HasSSH = false
	rows := worktreeRows(page.Items, false, false)

	var b strings.Builder
	renderWorktreePage(&b, page, rows, 3, true)
	got := stripANSI(b.String())

	if strings.Contains(got, "left alone") {
		t.Errorf("clean page should have no anomaly block:\n%s", got)
	}
	if !strings.Contains(got, "proxy: off") {
		t.Errorf("proxy state missing:\n%s", got)
	}
	if !strings.Contains(got, "  > Shell here") {
		t.Errorf("cursor should sit on Shell here (row 3 without editor/ssh):\n%s", got)
	}
	if strings.Contains(got, "Editor + Claude") || strings.Contains(got, "remote") {
		t.Errorf("hidden rows rendered:\n%s", got)
	}
}

func TestRenderWorktreePage_Locked(t *testing.T) {
	page := pageFixture()
	page.Anomalies = "  something\n"
	page.Health = &Health{At: time.Now().Add(-2 * time.Minute), Issues: []Issue{
		{Stage: StageCheckout, Project: "infra-ops", Detail: "fatal: a branch named 'x' already exists"},
		{Stage: StageSmoke, Project: "store-api", Server: "store-api", Detail: "l1\nl2\n  at loadConfig (src/config.ts:12)\nError: STORE_DB_URL is not set"},
	}}
	rows := worktreeRows(page.Items, true, true)

	var b strings.Builder
	renderWorktreePage(&b, page, rows, 0, true)
	got := stripANSI(b.String())

	want := strings.Join([]string{
		"  /w/store-front/wrk1",
		"  proxy: off",
		"",
		"  ! 2 issues · 2 minutes ago",
		"    checkout  infra-ops             fatal: a branch named 'x' already exists",
		"    smoke     store-api/store-api   l2",
		"                                      at loadConfig (src/config.ts:12)",
		"                                    Error: STORE_DB_URL is not set",
		"                                    … 1 more lines — f hands Claude all of it",
		"",
		"    f fix with Claude   v verify",
		"",
		"  Servers  locked until verified",
		"  > store-api           ● :54494   http://localhost:54494",
		"    store-front-worker  ○",
		"",
		"  Launch  locked until verified",
		"    Editor + Claude             ",
		"    Claude in terminal          ",
		"",
		"  Open",
		"    Cursor / VS Code (remote)",
		"    Shell here",
		"",
	}, "\n")
	if got != want {
		t.Errorf("page =\n%s\nwant\n%s", got, want)
	}
	// Anomalies are hidden on a locked page: the issues are the message.
	if strings.Contains(got, "something") {
		t.Error("anomalies should not show while locked")
	}
}

func TestAgo(t *testing.T) {
	now := time.Now()
	tests := map[time.Duration]string{
		10 * time.Second: "just now",
		2 * time.Minute:  "2 minutes ago",
		90 * time.Minute: "1 hour ago",
		25 * time.Hour:   "1 day ago",
		72 * time.Hour:   "3 days ago",
	}
	for d, want := range tests {
		if got := Ago(now.Add(-d)); got != want {
			t.Errorf("Ago(-%s) = %q, want %q", d, got, want)
		}
	}
}

func TestWorktreeView_VerifyAndFixKeys(t *testing.T) {
	press := func(v WorktreeView, k string) (WorktreeView, tea.Cmd) {
		m, cmd := v.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)})
		return m.(WorktreeView), cmd
	}
	v := NewWorktreeView(Ref{Workspace: "ws", Worktree: "wt"})
	v.page = pageFixture()
	v.page.Health = nil
	v.rows = worktreeRows(v.page.Items, true, true)

	// f without a recorded failure does nothing.
	v, cmd := press(v, "f")
	if cmd != nil {
		t.Error("f with no health should be a no-op")
	}

	// v while a session runs asks first; n backs out, y runs the verify.
	v, cmd = press(v, "v")
	if cmd != nil || !v.confirmVerify {
		t.Fatalf("v with a running session should ask: cmd=%v confirm=%v", cmd != nil, v.confirmVerify)
	}
	if !strings.Contains(stripANSI(v.View()), "Servers are running; verify restarts them. (y/n)") {
		t.Error("the confirm line should render")
	}
	v, _ = press(v, "n")
	if v.confirmVerify || v.loading {
		t.Error("n should back out")
	}
	v, _ = press(v, "v")
	v, cmd = press(v, "y")
	if cmd == nil || !v.loading || v.confirmVerify {
		t.Error("y should run the verify with the spinner")
	}

	// No session: v verifies at once.
	v.loading, v.page.Session = false, ""
	v, cmd = press(v, "v")
	if cmd == nil || !v.loading {
		t.Error("v with no session should verify without asking")
	}

	// The runners started: the page reloads and follows them.
	v.loading = true
	m, cmd := v.Update(verifyStartedMsg{})
	v = m.(WorktreeView)
	if v.loading || !strings.HasPrefix(v.statusMsg, "verifying") || cmd == nil {
		t.Errorf("started: loading=%v status=%q", v.loading, v.statusMsg)
	}

	// f with a recorded failure produces the exec command.
	v.page.Health = &Health{Issues: []Issue{{Stage: StageSmoke, Project: "a", Server: "a", Detail: "x"}}}
	_, cmd = press(v, "f")
	if cmd == nil {
		t.Error("f with health should run the fix")
	}

	// Locked: the keys that would start or launch say so and do nothing;
	// the shell and logs stay live.
	v.err, v.statusMsg = nil, ""
	for _, k := range []string{"s", "r", "x"} {
		v2, cmd := press(v, k)
		if cmd != nil || v2.statusMsg != lockedMsg {
			t.Errorf("%s on a locked page: cmd=%v status=%q", k, cmd != nil, v2.statusMsg)
		}
	}
	v.cursor = len(v.rows) - 1 // Shell here
	_, cmd = press(v, "enter")
	if cmd == nil {
		t.Error("enter on Shell here should still work while locked")
	}
	v.cursor = 2 // Editor + Claude
	v2, cmd := press(v, "enter")
	if cmd != nil || v2.statusMsg != lockedMsg {
		t.Errorf("enter on a launch row while locked: cmd=%v status=%q", cmd != nil, v2.statusMsg)
	}
	if _, cmd := press(v, "o"); cmd == nil {
		t.Error("o should open the shell while locked")
	}
	if !strings.Contains(stripANSI(v.View()), "f fix  v verify  l logs  o shell  p proxy  esc back") {
		t.Errorf("locked help line:\n%s", stripANSI(v.View()))
	}

}

// l lists every server with a log file, not only running ones: a dead
// server's smoke output is what you read on a locked page.
func TestLoggedItems_IncludeStoppedServersWithALog(t *testing.T) {
	setupTestConfig(t)
	ref := Ref{Workspace: "ws", Worktree: "wt"}
	v := NewWorktreeView(ref)
	v.page.Items = []devItem{
		{ProjectName: "api", Server: project.DevServer{Name: "api"}},
		{ProjectName: "web", Server: project.DevServer{Name: "web"}},
		{ProjectName: "run", Server: project.DevServer{Name: "run"}, Running: true},
	}
	os.MkdirAll(dev.LogDir(ref.Slug()), 0o755)
	os.WriteFile(dev.LogFile(ref.Slug(), "api"), []byte("Error: x\n"), 0o644)

	names := []string{}
	for _, item := range v.loggedItems() {
		names = append(names, item.Server.Name)
	}
	if strings.Join(names, ",") != "api,run" {
		t.Errorf("loggedItems = %v, want api (log file) and run (running), not web", names)
	}
	v.page.Items = v.page.Items[1:2]
	m, cmd := v.openLogs()
	if cmd != nil || m.(WorktreeView).err == nil || m.(WorktreeView).err.Error() != "no server has run yet" {
		t.Errorf("openLogs with nothing to show: cmd=%v err=%v", cmd != nil, m.(WorktreeView).err)
	}
}

// A running row is only "●" once the check says so; the two ways it can be
// wrong are spelled out on the row, and f is offered without locking.
func TestRenderWorktreePage_CheckedRows(t *testing.T) {
	page := pageFixture()
	page.Anomalies = ""
	page.HasEditor, page.HasSSH = false, false
	page.Items = []devItem{
		{ProjectName: "store-api", Server: project.DevServer{Name: "store-api"}, Running: true, Port: 54494, URL: "http://localhost:54494",
			Check: &SmokeResult{Alive: true, Listening: true}},
		{ProjectName: "checkout-api", Server: project.DevServer{Name: "checkout-api"}, Running: true, Port: 54496,
			Check: &SmokeResult{Alive: false, Tail: "ModuleNotFoundError: No module named 'x'\nmore"}},
		{ProjectName: "checkout-api", Server: project.DevServer{Name: "worker"}, Running: true, Port: 54497,
			Check: &SmokeResult{Alive: true, Listening: false, Referenced: true}},
		{ProjectName: "signals", Server: project.DevServer{Name: "ingress"}, Running: true, Port: 54498,
			Check: &SmokeResult{Alive: true, Listening: false}},
	}
	page.CheckHealth = CheckHealth([]SmokeResult{*page.Items[1].Check, *page.Items[2].Check})
	rows := worktreeRows(page.Items, false, false)

	var b strings.Builder
	renderWorktreePage(&b, page, rows, 0, true)
	got := stripANSI(b.String())
	want := strings.Join([]string{
		"  /w/store-front/wrk1",
		"  proxy: off",
		"",
		"  Servers  crew-dev-store-front--wrk1",
		"  > store-api     ● :54494   http://localhost:54494",
		"    checkout-api  ✗ died :54496   ModuleNotFoundError: No module named 'x'",
		"    worker        ! not listening :54497   something points at it",
		"    ingress       ● not listening :54498   nothing points at it",
		"",
		"  Launch",
		"    Claude in terminal          store-api · feature/s4b-3071",
		"",
		"  Open",
		"    Shell here",
		"",
	}, "\n")
	if got != want {
		t.Errorf("page =\n%s\nwant\n%s", got, want)
	}

	v := WorktreeView{ref: Ref{Workspace: "store-front", Worktree: "wrk1"}, page: page, rows: rows}
	if v.locked() {
		t.Error("a check never locks the page")
	}
	if help := stripANSI(v.View()); !strings.Contains(help, "f fix with Claude  enter act") {
		t.Errorf("help should offer f:\n%s", help)
	}
}

// While a referenced server is still starting the page schedules another
// look; once every row has its verdict, or the window closed, it stops.
func TestWorktreeLoaded_RechecksOnlyWhileStarting(t *testing.T) {
	starting := devItem{Running: true, Check: &SmokeResult{Alive: true, Referenced: true}}
	up := devItem{Running: true, Check: &SmokeResult{Alive: true, Listening: true}}
	for _, tt := range []struct {
		name     string
		page     worktreePage
		wantTick bool
	}{
		{"settling, one starting", worktreePage{Settling: true, Items: []devItem{starting, up}}, true},
		{"settling, all decided", worktreePage{Settling: true, Items: []devItem{up}}, false},
		{"window closed", worktreePage{Settling: false, Items: []devItem{starting}}, false},
	} {
		_, cmd := WorktreeView{}.Update(worktreeLoadedMsg{page: tt.page})
		if (cmd != nil) != tt.wantTick {
			t.Errorf("%s: tick=%v, want %v", tt.name, cmd != nil, tt.wantTick)
		}
	}
}

func TestRenderWorktreePage_StartingRow(t *testing.T) {
	page := pageFixture()
	page.Anomalies, page.HasEditor, page.HasSSH = "", false, false
	page.Settling = true
	page.Items = []devItem{
		{ProjectName: "api", Server: project.DevServer{Name: "api"}, Running: true, Port: 54494, URL: "http://localhost:54494",
			Check: &SmokeResult{Alive: true, Referenced: true}},
	}
	var b strings.Builder
	renderWorktreePage(&b, page, worktreeRows(page.Items, false, false), 0, true)
	if got := stripANSI(b.String()); !strings.Contains(got, "  > api  ● starting… :54494   http://localhost:54494") {
		t.Errorf("starting row:\n%s", got)
	}
}

func installingPage() worktreePage {
	page := pageFixture()
	page.Anomalies, page.Session, page.HasEditor, page.HasSSH = "", "", true, false
	page.Items[0].Running, page.Items[0].Port, page.Items[0].URL = false, 0, ""
	page.Setup = &Status{Projects: []ProjectStatus{
		{Project: "store-api", State: StateRunning, Steps: []RunStep{{Name: "checkout", Status: StepOK, TookMs: 1200}, {Name: "npm ci", Status: StepRunning}}},
		{Project: "checkout-api", State: StateFailed, Steps: []RunStep{{Name: "checkout", Status: StepOK, TookMs: 900}, {Name: "uv sync", Status: StepFailed, TookMs: 3000, Detail: "no solution"}}},
	}}
	return page
}

// While runners are alive the page shows their table under what is
// recorded so far, and every section that would touch a checkout says
// it waits for the install.
func TestRenderWorktreePage_Installing(t *testing.T) {
	page := installingPage()
	page.Health = &Health{At: time.Now(), Issues: []Issue{{Stage: StageInstall, Project: "checkout-api", Detail: "uv sync:\nno solution"}}}
	rows := worktreeRows(page.Items, true, false)

	var b strings.Builder
	renderWorktreePage(&b, page, rows, 0, true)
	got := stripANSI(b.String())
	want := strings.Join([]string{
		"  /w/store-front/wrk1",
		"  proxy: off",
		"",
		"  ! install failed: checkout-api · just now",
		"    install   checkout-api   uv sync:",
		"                             no solution",
		"",
		"    f fix with Claude",
		"",
		"  installing · one runner per project",
		"  ▸ store-api     checkout 1s · ▸ npm ci",
		"  ✗ checkout-api  checkout 1s · uv sync — no solution",
		"",
		"  Servers  after the install",
		"  > store-api           ○",
		"    store-front-worker  ○",
		"",
		"  Launch  after the install",
		"    Editor + Claude             ",
		"    Claude in terminal          ",
		"",
		"  Open",
		"    Shell here",
		"",
	}, "\n")
	if got != want {
		t.Errorf("page =\n%s\nwant\n%s", got, want)
	}
}

// Installing gates what a locked page gates plus the verify; the shell,
// the runner logs and the fix stay live; installing wins over locked.
func TestWorktreeView_InstallingKeys(t *testing.T) {
	press := func(v WorktreeView, k string) (WorktreeView, tea.Cmd) {
		m, cmd := v.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)})
		return m.(WorktreeView), cmd
	}
	v := NewWorktreeView(Ref{Workspace: "ws", Worktree: "wt"})
	v.page = installingPage()
	v.page.Health = &Health{Issues: []Issue{{Stage: StageInstall, Project: "checkout-api"}}}
	v.rows = worktreeRows(v.page.Items, true, false)

	for _, k := range []string{"s", "r", "x", "v"} {
		v2, cmd := press(v, k)
		if cmd != nil || v2.statusMsg != installingMsg {
			t.Errorf("%s while installing: cmd=%v status=%q", k, cmd != nil, v2.statusMsg)
		}
	}
	v.cursor = 2 // Editor + Claude
	if v2, cmd := press(v, "enter"); cmd != nil || v2.statusMsg != installingMsg {
		t.Errorf("enter on a launch row: cmd=%v status=%q", cmd != nil, v2.statusMsg)
	}
	if _, cmd := press(v, "o"); cmd == nil {
		t.Error("o (shell) must stay live")
	}
	if _, cmd := press(v, "f"); cmd == nil {
		t.Error("f on what is recorded so far must stay live")
	}
	_, cmd := press(v, "l")
	if cmd == nil {
		t.Fatal("l must open the runner logs")
	}
	push, ok := cmd().(app.PushPageMsg)
	if !ok {
		t.Fatalf("l → %T, want a pushed page", cmd())
	}
	logs, ok := push.Page.(LogsView)
	if !ok || len(logs.tabs) != 2 || logs.tabs[0].label != "store-api" || logs.tabs[0].file == "" {
		t.Errorf("runner logs view = %+v", push.Page)
	}
	if help := stripANSI(v.View()); !strings.Contains(help, "f fix what failed so far  l runner logs  o shell") {
		t.Errorf("help line:\n%s", help)
	}
	v.page.Health = nil
	if help := stripANSI(v.View()); !strings.Contains(help, "l runner logs  o shell") || strings.Contains(help, "f fix") {
		t.Errorf("help line without health:\n%s", help)
	}
}

// The page keeps looking while runners are alive, and stops once they are done.
func TestWorktreeLoaded_RechecksWhileInstalling(t *testing.T) {
	running := worktreePage{Setup: &Status{Projects: []ProjectStatus{{State: StateRunning}}}}
	done := worktreePage{Setup: &Status{Projects: []ProjectStatus{{State: StateOK}}}}
	if _, cmd := (WorktreeView{}).Update(worktreeLoadedMsg{page: running}); cmd == nil {
		t.Error("installing should schedule a recheck")
	}
	if _, cmd := (WorktreeView{}).Update(worktreeLoadedMsg{page: done}); cmd != nil {
		t.Error("finished runners should not")
	}
}

// A setup logs tab tails a file, live, with no restart key.
func TestSetupLogsView_TailsFile(t *testing.T) {
	setupTestConfig(t)
	ref := Ref{Workspace: "ws", Worktree: "wt"}
	v := NewSetupLogsView(ref, []string{"api"})
	if got := v.capturePane()().(paneContentMsg).content; got != "(nothing yet)" {
		t.Errorf("no file → %q", got)
	}
	os.MkdirAll(filepath.Dir(RunnerLogFile(ref, "api")), 0o755)
	os.WriteFile(RunnerLogFile(ref, "api"), []byte("▸ npm ci\nadded 12 packages\n"), 0o644)
	if got := v.capturePane()().(paneContentMsg).content; got != "▸ npm ci\nadded 12 packages" {
		t.Errorf("file → %q", got)
	}
	m, cmd := v.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("r")})
	if cmd != nil || strings.Contains(stripANSI(m.(LogsView).View()), "r restart") {
		t.Error("a file tab has nothing to restart")
	}
}

// The refused-key hint does not outlive the runners it was about.
func TestWorktreeLoaded_ClearsInstallingHint(t *testing.T) {
	v := WorktreeView{statusMsg: installingMsg}
	m, _ := v.Update(worktreeLoadedMsg{page: worktreePage{Setup: &Status{Projects: []ProjectStatus{{State: StateOK}}}}})
	if got := m.(WorktreeView).statusMsg; got != "" {
		t.Errorf("status after the runners = %q", got)
	}
	m, _ = v.Update(worktreeLoadedMsg{page: worktreePage{Setup: &Status{Projects: []ProjectStatus{{State: StateRunning}}}}})
	if got := m.(WorktreeView).statusMsg; got != installingMsg {
		t.Errorf("status while running = %q", got)
	}
}
