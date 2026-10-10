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
		Ref:     Ref{Workspace: "store-front", Worktree: "wrk1"},
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
		ManageURL:   "http://localhost:7300/",
	}
}

// Only launching moves the cursor; a row that cannot work is not there.
func TestWorktreeRows(t *testing.T) {
	all := worktreeRows(true, true)
	want := []rowKind{rowLaunchEditor, rowLaunchClaude, rowOpenRemote, rowOpenShell}
	if len(all) != len(want) {
		t.Fatalf("rows = %v, want %v", all, want)
	}
	for i := range want {
		if all[i] != want[i] {
			t.Errorf("row %d = %v, want %v", i, all[i], want[i])
		}
	}
	bare := worktreeRows(false, false)
	if len(bare) != 2 || bare[0] != rowLaunchClaude || bare[1] != rowOpenShell {
		t.Errorf("bare rows = %+v", bare)
	}
}

func TestRenderWorktreePage_Golden(t *testing.T) {
	page := pageFixture()
	rows := worktreeRows(true, true)

	var b strings.Builder
	renderWorktreePage(&b, page, rows, 0)
	got := stripANSI(b.String())

	want := strings.Join([]string{
		"  /w/store-front/wrk1",
		"",
		"  Servers  crew-dev-store-front--wrk1",
		"    store-api           ● :54494   http://localhost:54494",
		"    store-front-worker  ○ stopped",
		"",
		"    checkout-api",
		"      GONE  left alone — not in workspace",
		"  manage it in crew: http://localhost:7300/ · crew dev start store-front/wrk1",
		"",
		"  Launch",
		"  > Editor + Claude             store-api · feature/s4b-3071",
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

// With the server down the line still says where, and the cursor walks
// the launch rows only.
func TestRenderWorktreePage_NoServerNoExtras(t *testing.T) {
	page := pageFixture()
	page.Anomalies, page.HasEditor, page.HasSSH, page.ManageURL = "", false, false, ""
	rows := worktreeRows(false, false)

	var b strings.Builder
	renderWorktreePage(&b, page, rows, 1)
	got := stripANSI(b.String())

	if strings.Contains(got, "left alone") {
		t.Errorf("clean page should have no anomaly block:\n%s", got)
	}
	if !strings.Contains(got, "  manage it in crew: run crew · crew dev start store-front/wrk1\n") {
		t.Errorf("manage line without a server:\n%s", got)
	}
	if !strings.Contains(got, "  > Shell here") {
		t.Errorf("cursor should sit on Shell here:\n%s", got)
	}
	if strings.Contains(got, "Editor + Claude") || strings.Contains(got, "remote") {
		t.Errorf("hidden rows rendered:\n%s", got)
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
		if got := AgoAt(now.Add(-d), now); got != want {
			t.Errorf("AgoAt(-%s) = %q, want %q", d, got, want)
		}
	}
}

// The page manages nothing: the old start/stop/verify/fix/proxy keys do
// nothing at all now.
func TestWorktreeView_ManagementKeysAreGone(t *testing.T) {
	v := NewWorktreeView(Ref{Workspace: "ws", Worktree: "wt"}, "")
	v.page = pageFixture()
	v.page.Health = &Health{Issues: []Issue{{Stage: StageSmoke, Project: "store-api"}}}
	v.rows = worktreeRows(true, true)
	for _, k := range []string{"s", "r", "x", "p", "v", "f"} {
		m, cmd := v.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)})
		if cmd != nil || m.(WorktreeView).loading {
			t.Errorf("%s did something", k)
		}
	}
	if help := stripANSI(v.View()); !strings.Contains(help, "enter launch  l logs  o shell  esc back") {
		t.Errorf("help line:\n%s", help)
	}
	// A recorded failure no longer locks launching.
	if _, cmd := v.Update(tea.KeyMsg{Type: tea.KeyEnter}); cmd == nil {
		t.Error("enter on Editor + Claude should launch")
	}
}

// l lists every server with a log file, not only running ones: a dead
// server's smoke output is worth reading too.
func TestLoggedItems_IncludeStoppedServersWithALog(t *testing.T) {
	setupTestConfig(t)
	ref := Ref{Workspace: "ws", Worktree: "wt"}
	v := NewWorktreeView(ref, "")
	v.page.Items = []devItem{
		{ProjectName: "api", Server: project.DevServer{Name: "api"}},
		{ProjectName: "web", Server: project.DevServer{Name: "web"}},
		{ProjectName: "run", Server: project.DevServer{Name: "run"}, Running: true},
	}
	os.MkdirAll(dev.LogDir(ref.Slug()), 0o755)
	os.WriteFile(dev.LogFile(ref.Slug(), "api", "api"), []byte("Error: x\n"), 0o644)

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
// recorded so far, and launching waits for the install.
func TestRenderWorktreePage_Installing(t *testing.T) {
	page := installingPage()
	page.Health = &Health{At: time.Now(), Issues: []Issue{{Stage: StageInstall, Project: "checkout-api", Detail: "uv sync:\nno solution"}}}
	rows := worktreeRows(true, false)

	var b strings.Builder
	renderWorktreePage(&b, page, rows, 0)
	got := stripANSI(b.String())
	want := strings.Join([]string{
		"  /w/store-front/wrk1",
		"",
		"  ! install failed: checkout-api · just now",
		"    install   checkout-api   uv sync:",
		"                             no solution",
		"",
		"  installing · one runner per project",
		"  ▸ store-api     checkout 1s · ▸ npm ci",
		"  ✗ checkout-api  checkout 1s · uv sync — no solution",
		"",
		"  Servers",
		"    store-api           ○ stopped",
		"    store-front-worker  ○ stopped",
		"  manage it in crew: http://localhost:7300/ · crew dev start store-front/wrk1",
		"",
		"  Launch  after the install",
		"  > Editor + Claude             store-api · feature/s4b-3071",
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

// Installing gates the launch rows; the shell and the runner logs stay live.
func TestWorktreeView_InstallingKeys(t *testing.T) {
	press := func(v WorktreeView, k string) (WorktreeView, tea.Cmd) {
		m, cmd := v.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)})
		return m.(WorktreeView), cmd
	}
	v := NewWorktreeView(Ref{Workspace: "ws", Worktree: "wt"}, "")
	v.page = installingPage()
	v.rows = worktreeRows(true, false)

	if v2, cmd := v.Update(tea.KeyMsg{Type: tea.KeyEnter}); cmd != nil || v2.(WorktreeView).statusMsg != installingMsg {
		t.Errorf("enter on a launch row: cmd=%v status=%q", cmd != nil, v2.(WorktreeView).statusMsg)
	}
	if _, cmd := press(v, "o"); cmd == nil {
		t.Error("o (shell) must stay live")
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
	if help := stripANSI(v.View()); !strings.Contains(help, "l runner logs  o shell  esc back") {
		t.Errorf("help line:\n%s", help)
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

func TestRenderPicker(t *testing.T) {
	rows := []Summary{
		{Name: "store-front/main", DevRunning: true},
		{Name: "store-front/wrk1", Installing: true},
		{Name: "admin", Health: "install failed: admin"},
		{Name: "infra-ops/main"},
	}
	got := stripANSI(renderPicker(rows, 1))
	want := strings.Join([]string{
		"    store-front/main  [dev]",
		"  > store-front/wrk1  installing…",
		"    admin             ! install failed: admin",
		"    infra-ops/main  ",
		"",
	}, "\n")
	if got != want {
		t.Errorf("picker =\n%s\nwant\n%s", got, want)
	}
	if got := stripANSI(renderPicker(nil, 0)); got != "  no worktrees yet — set one up in the browser (run crew) or crew add workspace <ws> <project>…\n" {
		t.Errorf("empty picker = %q", got)
	}
}
