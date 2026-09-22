package workspaceui

import (
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// The cards and the page render facts, so each at rest is a fixed
// string. One golden per shape.

func fixtureWizard(card wizardCard) wizard {
	w := newWizard()
	w.wsName = "feature-auth"
	w.card = card
	w.picker = newPicker("feature-auth")
	w.pool = pickerPool()
	w.picker.reload(pickerFacts{Pool: w.pool, Refusals: map[string]string{"infra-ops": "project 'infra-ops' is already attached to workspace 'ops' in direct mode"}})
	w.picker.rows[0].Ticked = true
	w.picker.rows[1].Ticked = true
	w.picker.cursor = 0
	return w
}

func TestRenderProjectsCard_Golden(t *testing.T) {
	w := fixtureWizard(cardProjects)
	got := plain(w.View())
	want := strings.Join([]string{
		"  Add workspace feature-auth · 2 of 3 · projects",
		"",
		"  Tick the projects. worktree = a fresh checkout on crew/feature-auth/main/<project>; direct = the",
		"  canonical checkout, not isolated — m switches a row.",
		"",
		"  > ✓ store-front   worktree   web :3000 next dev",
		"    ✓ store-api     worktree   api :4000 make dev, worker no port make worker",
		"    ○ signals       worktree   no servers",
		"    ○ infra-ops     worktree   no servers",
		"",
		"  bindings   STORE_API_URL  store-front → store-api      ✓ in this workspace",
		"             SIGNALS_URL    store-front → signals        ! signals is not ticked",
		"             SIGNALS_URL    store-api → signals          ! signals is not ticked",
		"             +1 more",
		"",
		"  space tick  m mode  a add a project  enter next  esc back",
		"  crew add workspace feature-auth store-front store-api",
		"",
	}, "\n")
	if got != want {
		t.Errorf("card 2:\n%s\nwant:\n%s", got, want)
	}
}

func TestRenderCreateCard_Golden(t *testing.T) {
	w := fixtureWizard(cardCreate)
	w.picker.rows[1].Mode = workspace.ModeDirect
	w.bases.phase = workspace.BaseReady
	w.bases.statuses = []workspace.BaseStatus{
		{Project: "store-front", Base: "main", Current: "main"},
		{Project: "store-api", Base: "(direct — shares the canonical checkout)", Current: "feature/x", Behind: -1},
	}
	got := plain(w.View())
	want := strings.Join([]string{
		"  Add workspace feature-auth · 3 of 3 · create",
		"",
		"  store-front   worktree      store-api   direct",
		"",
		"  Branching from",
		"  store-front  main        up to date",
		"  store-api    (direct — shares the canonical checkout)  up to date",
		"",
		"  y creates the main worktree the way crew add worktree does: checkouts, installs, a smoke start; what fails is recorded.",
		"",
		"  y create  esc back",
		"  crew add workspace feature-auth store-front store-api --wait",
		"",
	}, "\n")
	if got != want {
		t.Errorf("card 3:\n%s\nwant:\n%s", got, want)
	}
	w.bases.statuses[0].Behind = 2
	if got := plain(w.View()); !strings.Contains(got, "2 behind origin/main") || !strings.Contains(got, "y create  ctrl+p pull first  esc back") {
		t.Errorf("stale base offers ctrl+p:\n%s", got)
	}
	w.creating = true
	if got := plain(w.View()); !strings.Contains(got, "creating feature-auth — reserving ports") || strings.Contains(got, "y create") {
		t.Errorf("creating:\n%s", got)
	}
}

func TestRenderWorkspacePage_Golden(t *testing.T) {
	f := pageFacts{
		ws: &workspace.Workspace{Name: "feature-auth", Projects: []workspace.WorkspaceProject{{Name: "store-front"}, {Name: "store-api", Mode: workspace.ModeDirect}}},
		pool: map[string]project.Project{
			"store-front": {Name: "store-front", Path: "/repos/store-front"},
			"store-api":   {Name: "store-api", Path: "/code/store-api"},
		},
		summaries: []workspace.Summary{
			{Ref: workspace.Ref{Workspace: "feature-auth", Worktree: "main"}, Worktree: "main", DevRunning: true},
			{Ref: workspace.Ref{Workspace: "feature-auth", Worktree: "wrk2"}, Worktree: "wrk2", Installing: true, Health: "install failed: store-api"},
		},
		sizes:   map[string]int64{"feature-auth/main": 1200 << 20, "feature-auth/wrk2": 3400 << 20},
		spinner: "⠋",
	}
	rows := pageRows(f)
	body, cursorLine := renderWorkspacePage(f, rows, landOn(rows, rowWorktree), formBlock{})
	got := plain(body)
	want := strings.Join([]string{
		"  2 projects · 2 worktrees",
		"",
		"  Projects",
		"    store-front   worktree   /repos/store-front",
		"    store-api     direct     /code/store-api",
		"",
		"  Worktrees",
		"  > main   1.2 GB  [dev]",
		"    wrk2   3.3 GB  installing…  ! install failed: store-api",
		"    + new worktree",
		"",
	}, "\n")
	if got != want {
		t.Errorf("page:\n%s\nwant:\n%s", got, want)
	}
	if cursorLine != 7 {
		t.Errorf("cursor line = %d", cursorLine)
	}

	// A flat pre-2.0 workspace: one unnamed row, the migrate hint, no size.
	f.summaries = []workspace.Summary{{Ref: workspace.Ref{Workspace: "feature-auth"}}}
	rows = pageRows(f)
	body, _ = renderWorkspacePage(f, rows, landOn(rows, rowWorktree), formBlock{})
	if got := plain(body); !strings.Contains(got, "  > (flat)  run crew migrate to name it\n    + new worktree\n") {
		t.Errorf("flat page:\n%s", got)
	}
}

func TestWindow(t *testing.T) {
	lines := []string{"a", "b", "c", "d", "e"}
	if got := window(lines, 4, 3); strings.Join(got, "") != "cde" {
		t.Errorf("cursor at the end: %v", got)
	}
	if got := window(lines, 0, 3); strings.Join(got, "") != "abc" {
		t.Errorf("cursor at the top: %v", got)
	}
	if got := window(lines, 2, 0); len(got) != 5 {
		t.Errorf("no height keeps everything: %v", got)
	}
}
