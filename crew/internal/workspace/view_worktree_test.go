package workspace

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/project"
)

func pageFixture() worktreePage {
	return worktreePage{
		Dir:     "/w/phone-speak/wrk1",
		Session: "crew-dev-phone-speak--wrk1",
		Items: []devItem{
			{ProjectName: "speak-api", Server: project.DevServer{Name: "speak-api", Port: 3000}, Running: true, Port: 54494, URL: "http://localhost:54494"},
			{ProjectName: "ai-tutor-api", Server: project.DevServer{Name: "phone-speak-worker", Port: 8003}},
		},
		Anomalies:   "  ai-tutor-api\n    GONE  left alone — not in workspace\n",
		LeadProject: "speak-api",
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
		"  /w/phone-speak/wrk1",
		"  proxy: on",
		"",
		"  Servers  crew-dev-phone-speak--wrk1",
		"  > speak-api           ● :54494   http://localhost:54494",
		"    phone-speak-worker  ○ stopped",
		"",
		"    ai-tutor-api",
		"      GONE  left alone — not in workspace",
		"",
		"  Launch",
		"    Editor + Claude             speak-api · feature/s4b-3071",
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

func TestRenderWorktreePage_HealthBlock(t *testing.T) {
	page := pageFixture()
	page.Anomalies = ""
	page.Health = &Health{Stage: StageSmoke, At: time.Now().Add(-2 * time.Minute), Issues: []Issue{
		{Project: "speak-api", Server: "speak-api", Detail: "l1\nl2\n  at loadConfig (src/config.ts:12)\nError: SPEAK_DB_URL is not set"},
	}}
	rows := worktreeRows(page.Items, true, true)

	var b strings.Builder
	renderWorktreePage(&b, page, rows, 0, true)
	got := stripANSI(b.String())

	want := strings.Join([]string{
		"",
		"  ! server died: speak-api/speak-api · 2 minutes ago",
		"    speak-api/speak-api   l2",
		"                            at loadConfig (src/config.ts:12)",
		"                          Error: SPEAK_DB_URL is not set",
		"                          … 1 more lines — f hands Claude all of it",
		"",
		"    f fix with Claude   v verify",
		"",
		"  Launch",
	}, "\n")
	if !strings.Contains(got, want) {
		t.Errorf("page =\n%s\nwant to contain\n%s", got, want)
	}
}

func TestAgo(t *testing.T) {
	now := time.Now()
	tests := map[time.Duration]string{
		10 * time.Second: "just now",
		2 * time.Minute:  "2 minutes ago",
		90 * time.Minute: "1 hours ago",
		25 * time.Hour:   "1 days ago",
		72 * time.Hour:   "3 days ago",
	}
	for d, want := range tests {
		if got := ago(now.Add(-d)); got != want {
			t.Errorf("ago(-%s) = %q, want %q", d, got, want)
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

	// The verdict lands as a status or an error, and the page reloads.
	v.loading = true
	m, cmd := v.Update(verifiedMsg{results: []SmokeResult{{Project: "a", Server: "a", Alive: true}}})
	v = m.(WorktreeView)
	if v.loading || v.statusMsg != "Checks out — health cleared" || cmd == nil {
		t.Errorf("pass: loading=%v status=%q", v.loading, v.statusMsg)
	}
	m, _ = v.Update(verifiedMsg{results: []SmokeResult{{Project: "a", Server: "a"}}})
	v = m.(WorktreeView)
	if v.err == nil || !strings.Contains(v.err.Error(), "1 server(s) died — recorded; f opens Claude on it") {
		t.Errorf("death: err=%v", v.err)
	}

	// f with a recorded failure produces the exec command.
	v.page.Health = &Health{Stage: StageSmoke, Issues: []Issue{{Project: "a", Server: "a", Detail: "x"}}}
	_, cmd = press(v, "f")
	if cmd == nil {
		t.Error("f with health should run the fix")
	}
	if !strings.Contains(stripANSI(v.View()), "f fix  esc back") {
		t.Error("help line should offer f when health is set")
	}
}
