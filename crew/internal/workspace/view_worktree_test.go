package workspace

import (
	"strings"
	"testing"

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
