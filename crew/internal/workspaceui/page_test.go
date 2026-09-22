package workspaceui

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/projectui"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

func pressP(t *testing.T, p Page, k string) (Page, []tea.Msg) {
	t.Helper()
	m, nav := settle(t, p, keyOf(k))
	return m.(Page), nav
}

// settlePage runs a page's Init and feeds every message back.
func settlePage(t *testing.T, p Page) Page {
	t.Helper()
	m := tea.Model(p)
	for _, msg := range runCmd(p.Init(), nil) {
		m, _ = settle(t, m, msg)
	}
	return m.(Page)
}

// pageFixture is a workspace of one repo project on main, with a second
// project in the pool.
func pageFixture(t *testing.T) string {
	t.Helper()
	tmp := twoRepos(t)
	if _, _, err := workspace.CreateWith("ws", []workspace.ProjectSpec{{Name: "store-api"}}, workspace.CheckoutOptions{}); err != nil {
		t.Fatal(err)
	}
	return tmp
}

func TestPageRows(t *testing.T) {
	f := pageFacts{
		ws:        &workspace.Workspace{Name: "ws", Projects: []workspace.WorkspaceProject{{Name: "a"}, {Name: "b"}}},
		summaries: []workspace.Summary{{Ref: workspace.Ref{Workspace: "ws", Worktree: "main"}}, {Ref: workspace.Ref{Workspace: "ws", Worktree: "wrk2"}}},
	}
	rows := pageRows(f)
	keys := []string{}
	for _, r := range rows {
		keys = append(keys, r.Key)
	}
	if got := strings.Join(keys, " "); got != "a b ws/main ws/wrk2 new" {
		t.Errorf("rows = %s", got)
	}
	if landOn(rows, rowWorktree) != 2 || findRow(rows, rowWorktree, "ws/wrk2") != 3 || findRow(rows, rowProject, "zzz") != -1 {
		t.Error("the cursor helpers")
	}
	empty := pageRows(pageFacts{})
	if len(empty) != 2 || empty[0].Kind != rowNoProjects || empty[1].Kind != rowNewWorktree || landOn(empty, rowWorktree) != 1 {
		t.Errorf("empty = %+v", empty)
	}
}

func TestPageKeysAndCLI(t *testing.T) {
	rows := pageRows(pageFacts{
		ws:        &workspace.Workspace{Name: "ws", Projects: []workspace.WorkspaceProject{{Name: "api"}}},
		summaries: []workspace.Summary{{Ref: workspace.Ref{Workspace: "ws", Worktree: "main"}}},
	})
	for i, want := range []string{
		"enter open  a add project  d remove  esc back",
		"enter open  u duplicate  n new  d remove  esc back",
		"enter create  esc back",
	} {
		if got := strings.Join(pageKeys(rows, i, openNone, false, false), "  "); got != want {
			t.Errorf("keys[%d] = %q, want %q", i, got, want)
		}
	}
	if got := strings.Join(pageKeys(rows, 1, openNone, true, false), "  "); got != "enter open  d remove  esc back" {
		t.Errorf("flat keys = %q", got)
	}
	if got := strings.Join(pageKeys(rows, 0, openPicker, false, false), "  "); got != "space tick  m mode  a add a project  enter add  esc back" {
		t.Errorf("picker keys = %q", got)
	}
	if got := strings.Join(pageKeys(rows, 0, openNewWorktree, false, true), "  "); got != "enter create  ctrl+p pull first  esc back" {
		t.Errorf("new keys with a stale base = %q", got)
	}
	if got := strings.Join(pageKeys(rows, 0, openNewWorktree, false, false), "  "); got != "enter create  esc back" {
		t.Errorf("new keys up to date = %q", got)
	}
	if got := pageCLI(rows, 0, "ws"); got != "crew rm workspace ws api · crew add workspace ws <project> [--direct]" {
		t.Errorf("project cli = %q", got)
	}
	if got := pageCLI(rows, 1, "ws"); got != "crew ws/main · crew duplicate ws/main <name> · crew rm worktree ws/main" {
		t.Errorf("worktree cli = %q", got)
	}
	if got := pageCLI(rows, 2, "ws"); got != "crew add worktree ws/<name> [--pull]" {
		t.Errorf("new cli = %q", got)
	}
	flat := pageRows(pageFacts{summaries: []workspace.Summary{{Ref: workspace.Ref{Workspace: "old"}}}})
	if got := pageCLI(flat, 1, "old"); !strings.HasPrefix(got, "crew migrate") {
		t.Errorf("flat worktree cli = %q", got)
	}
	if got := pageCLI(flat, 2, "old"); !strings.HasPrefix(got, "crew migrate first") {
		t.Errorf("flat new cli = %q", got)
	}
	if got := memberRemovePrompt("ws", workspace.WorkspaceProject{Name: "api"}); got != "Remove api from ws? Its checkout in every worktree goes to the trash. (y/n)" {
		t.Errorf("member prompt = %q", got)
	}
	if got := memberRemovePrompt("ws", workspace.WorkspaceProject{Name: "api", Mode: workspace.ModeDirect}); got != "Remove api from ws? The canonical repo is left alone. (y/n)" {
		t.Errorf("direct member prompt = %q", got)
	}
}

func TestPage_OpensPages(t *testing.T) {
	pageFixture(t)
	p := settlePage(t, NewPage("ws"))
	if p.rows[p.cursor].Kind != rowWorktree || p.rows[p.cursor].Key != "ws/main" {
		t.Fatalf("the cursor lands on the first worktree: %+v", p.rows[p.cursor])
	}
	got := plain(p.View())
	for _, want := range []string{"1 project · 1 worktree", "store-api   worktree   ", "> main", "+ new worktree", "crew ws/main · crew duplicate ws/main <name>"} {
		if !strings.Contains(got, want) {
			t.Errorf("page lacks %q:\n%s", want, got)
		}
	}
	_, nav := pressP(t, p, "enter")
	if page, ok := pushedPage(nav).(workspace.WorktreeView); !ok || page.Ref().String() != "ws/main" {
		t.Errorf("enter on a worktree pushes its page: %+v", pushedPage(nav))
	}
	p, _ = pressP(t, p, "up")
	_, nav = pressP(t, p, "enter")
	if _, ok := pushedPage(nav).(projectui.Page); !ok {
		t.Errorf("enter on a member pushes the project page: %+v", pushedPage(nav))
	}
	if !quits(p, "q") {
		t.Error("q quits")
	}
	_, nav = pressP(t, p, "esc")
	if _, ok := popped(nav); !ok {
		t.Error("esc pops")
	}
}

// a opens the picker with the members left out; enter records the pick
// and says where its runners are.
func TestPage_AddsMemberThroughPicker(t *testing.T) {
	pageFixture(t)
	p := settlePage(t, NewPage("ws"))
	p, _ = pressP(t, p, "a")
	if p.open != openPicker || len(p.picker.rows) != 1 || p.picker.rows[0].Name != "store-front" {
		t.Fatalf("picker rows = %+v", p.picker.rows)
	}
	if got := plain(p.View()); !strings.Contains(got, "○ store-front") || !strings.Contains(got, "space tick  m mode  a add a project  enter add  esc back") || strings.Contains(got, "> main") {
		t.Errorf("picker open — the picker has the cursor, the page row does not:\n%s", got)
	}
	// Letters go to the picker, not the page.
	p, _ = pressP(t, p, "enter")
	if p.err == nil || !strings.Contains(p.err.Error(), "nothing ticked") {
		t.Errorf("enter with nothing ticked: %v", p.err)
	}
	p, _ = pressP(t, p, " ")
	p, _ = pressP(t, p, "enter")
	if p.open != openNone || p.status != "Added store-front — installing on ws/main (its page shows the runners)" {
		t.Fatalf("after add: open=%v status=%q err=%v", p.open, p.status, p.err)
	}
	ws, _ := workspace.Load("ws")
	if len(ws.Projects) != 2 || ws.Projects[1].Name != "store-front" {
		t.Errorf("members = %+v", ws.Projects)
	}
	if p.rows[p.cursor].Kind != rowProject || p.rows[p.cursor].Key != "store-front" {
		t.Errorf("the cursor lands on the new member: %+v", p.rows[p.cursor])
	}
	// esc closes the picker without adding.
	p, _ = pressP(t, p, "a")
	p, _ = pressP(t, p, "esc")
	if p.open != openNone {
		t.Error("esc closes the form")
	}
}

func TestPage_RemovesMember(t *testing.T) {
	pageFixture(t)
	p := settlePage(t, NewPage("ws"))
	p, _ = pressP(t, p, "up")
	p, _ = pressP(t, p, "d")
	if p.confirm == nil || p.confirm.prompt != "Remove store-api from ws? Its checkout in every worktree goes to the trash. (y/n)" {
		t.Fatalf("confirm = %+v", p.confirm)
	}
	p, _ = pressP(t, p, "n")
	if p.confirm != nil {
		t.Error("n walks back")
	}
	p, _ = pressP(t, p, "d")
	p, _ = pressP(t, p, "y")
	ws, _ := workspace.Load("ws")
	if len(ws.Projects) != 0 || p.status != "Removed 'store-api'" || p.busy != "" {
		t.Errorf("after remove: members=%+v status=%q busy=%q err=%v", ws.Projects, p.status, p.busy, p.err)
	}
	if p.rows[0].Kind != rowNoProjects || p.cursor != 0 {
		t.Errorf("the placeholder takes the section and the cursor: %+v cursor=%d", p.rows, p.cursor)
	}
	if got := plain(p.View()); !strings.Contains(got, "no projects yet — a adds one") {
		t.Errorf("empty section:\n%s", got)
	}
}

// + new worktree: the base table, a name, and the page pushed with the
// created status; the new ref's size is walked fresh.
func TestPage_NewWorktreePushesThePage(t *testing.T) {
	pageFixture(t)
	p := settlePage(t, NewPage("ws"))
	p, _ = pressP(t, p, "n")
	if p.open != openNewWorktree || !p.bases.ready() {
		t.Fatalf("form: open=%v phase=%v", p.open, p.bases.phase)
	}
	if got := plain(p.View()); !strings.Contains(got, "Branching from") || !strings.Contains(got, "New worktree: ws/") {
		t.Errorf("form:\n%s", got)
	}
	for _, r := range "wrk2" {
		p, _ = pressP(t, p, string(r))
	}
	p, nav := pressP(t, p, "enter")
	page, ok := pushedPage(nav).(workspace.WorktreeView)
	if !ok || page.Status() != "Created ws/wrk2 — installing" {
		t.Fatalf("pushed: %+v err=%v", pushedPage(nav), p.err)
	}
	if p.open != openNone || p.rows[p.cursor].Key != "ws/wrk2" {
		t.Errorf("the page resets and lands on the new worktree: open=%v row=%+v", p.open, p.rows[p.cursor])
	}
	if _, ok := p.facts.sizes["ws/wrk2"]; !ok {
		t.Error("the new worktree's size was walked")
	}
	// Duplicate goes the same way.
	p, _ = pressP(t, p, "u")
	if p.open != openDuplicate || p.dupSource.String() != "ws/wrk2" {
		t.Fatalf("u: open=%v src=%v", p.open, p.dupSource)
	}
	for _, r := range "wrk3" {
		p, _ = pressP(t, p, string(r))
	}
	_, nav = pressP(t, p, "enter")
	if page, ok := pushedPage(nav).(workspace.WorktreeView); !ok || page.Status() != "Duplicated ws/wrk2 → ws/wrk3 — installing" {
		t.Errorf("duplicate pushed: %+v", pushedPage(nav))
	}
}

func TestPage_RemovesWorktrees(t *testing.T) {
	pageFixture(t)
	config.TrashDir = filepath.Join(t.TempDir(), "trash")
	if err := workspace.AddWorktree("ws", "wrk2", workspace.CheckoutOptions{}); err != nil {
		t.Fatal(err)
	}
	p := settlePage(t, NewPage("ws"))
	p, _ = pressP(t, p, "down") // wrk2
	p, _ = pressP(t, p, "d")
	if p.confirm == nil || p.confirm.prompt != "Remove worktree 'ws/wrk2'? Its checkouts will be deleted; the workspace stays. (y/n)" {
		t.Fatalf("confirm = %+v", p.confirm)
	}
	p, _ = pressP(t, p, "y")
	if ws, _ := workspace.Load("ws"); len(ws.Worktrees) != 1 || p.status != "Removed worktree 'ws/wrk2' — clearing in background" {
		t.Errorf("after remove: worktrees=%+v status=%q err=%v", ws.Worktrees, p.status, p.err)
	}
	// A removal in flight takes no keys — a second d would start another.
	busy := p
	busy.busy = "removing…"
	if m, _ := busy.Update(keyOf("d")); m.(Page).confirm != nil {
		t.Error("d while busy is ignored")
	}
	// The last worktree is the workspace: d removes it and pops with the
	// status.
	p, _ = pressP(t, p, "d")
	if p.confirm == nil || p.confirm.kind != confirmWorkspace || !strings.HasPrefix(p.confirm.prompt, "Remove workspace 'ws'?") {
		t.Fatalf("confirm = %+v", p.confirm)
	}
	_, nav := pressP(t, p, "y")
	if pop, ok := popped(nav); !ok || pop.Status != "Removed workspace 'ws'" {
		t.Errorf("pop = %+v", nav)
	}
	if workspace.Exists("ws") {
		t.Error("the workspace should be gone")
	}
}

// Moved with the list: sizes right-align in one column, a worktree still
// being walked shows the spinner, the trash notice shows when the trash
// holds something.
func TestPage_SizeColumnAndTrashNotice(t *testing.T) {
	setupTestConfig(t)
	config.TrashDir = filepath.Join(t.TempDir(), "trash")
	p := NewPage("store-front")
	p.facts.ws = &workspace.Workspace{Name: "store-front"}
	p.facts.summaries = []workspace.Summary{
		{Ref: workspace.Ref{Workspace: "store-front", Worktree: "wrk1"}, Workspace: "store-front", Worktree: "wrk1", DevRunning: true},
		{Ref: workspace.Ref{Workspace: "store-front", Worktree: "wrk10"}, Workspace: "store-front", Worktree: "wrk10", Health: "server died: api/api", Installing: true},
	}
	p.facts.sizes["store-front/wrk1"] = 161 << 30
	p.loaded = true
	p.rerow()
	got := plain(p.View())
	if !strings.Contains(got, "> wrk1    161 GB  [dev]") {
		t.Errorf("wrk1 row:\n%s", got)
	}
	if !strings.Contains(got, "  wrk10        ") || strings.Contains(got, "wrk10  161") {
		t.Errorf("wrk10 row should show no size yet:\n%s", got)
	}
	if !strings.Contains(got, "installing…  ! server died: api/api") {
		t.Errorf("the live signals show on the row:\n%s", got)
	}
	if strings.Contains(got, "trash:") {
		t.Errorf("no trash notice when the trash is empty:\n%s", got)
	}
	// The notice comes in with the facts, not per frame.
	checkoutInTrash(t, "x")
	p.facts.trash = workspace.TrashNotice()
	if got := plain(p.View()); !strings.Contains(got, "trash: 1 removed checkout still clearing in background") {
		t.Errorf("trash notice missing:\n%s", got)
	}
}

// One walk per worktree without a size; nothing already known is walked
// again; a flat workspace has nothing to walk.
func TestPage_LoadMissingSizes(t *testing.T) {
	tmp := setupTestConfig(t)
	a := filepath.Join(tmp, "a")
	b := filepath.Join(tmp, "b")
	os.MkdirAll(a, 0o755)
	os.MkdirAll(b, 0o755)
	os.WriteFile(filepath.Join(a, "f"), []byte("12345"), 0o644)
	os.WriteFile(filepath.Join(b, "f"), []byte("123"), 0o644)
	p := NewPage("ws")
	p.facts.summaries = []workspace.Summary{
		{Ref: workspace.Ref{Workspace: "ws", Worktree: "a"}, Worktree: "a", Path: a},
		{Ref: workspace.Ref{Workspace: "ws", Worktree: "b"}, Worktree: "b", Path: b},
	}
	p.facts.sizes["ws/a"] = 99
	if !p.sizesLoading() {
		t.Error("b is still to walk")
	}
	var msgs []worktreeSizesMsg
	for _, msg := range runCmd(p.loadMissingSizes(), nil) {
		if m, ok := msg.(worktreeSizesMsg); ok {
			msgs = append(msgs, m)
		}
	}
	if len(msgs) != 1 || msgs[0].sizes["ws/b"] != 3 {
		t.Errorf("walks = %+v, want b alone", msgs)
	}
	m, _ := p.Update(msgs[0])
	if p = m.(Page); p.facts.sizes["ws/a"] != 99 || p.facts.sizes["ws/b"] != 3 || p.sizesLoading() {
		t.Errorf("sizes = %+v", p.facts.sizes)
	}
	flat := NewPage("old")
	flat.facts.summaries = []workspace.Summary{{Ref: workspace.Ref{Workspace: "old"}, Path: a}}
	if flat.loadMissingSizes() != nil || flat.sizesLoading() {
		t.Error("a flat workspace has no size to walk")
	}
}

func TestAddedStatus(t *testing.T) {
	if got := addedStatus([]string{"api", "web"}, nil); got != "Added api, web" {
		t.Errorf("flat workspace → %q", got)
	}
	one := []workspace.Ref{{Workspace: "ws", Worktree: "main"}}
	if got := addedStatus([]string{"api", "web"}, one); got != "Added api, web — installing on ws/main (its page shows the runners)" {
		t.Errorf("one worktree → %q", got)
	}
	two := append(one, workspace.Ref{Workspace: "ws", Worktree: "wrk2"})
	if got := addedStatus([]string{"web"}, two); got != "Added web — installing on 2 worktrees (each page shows its runners)" {
		t.Errorf("two worktrees → %q", got)
	}
}

// The page takes a popped status, and a project gone from the pool still
// renders its row.
func TestPage_StatusAndMissingPool(t *testing.T) {
	setupTestConfig(t)
	p := NewPage("ws")
	m, _ := p.Update(app.StatusMsg{Status: "Removed worktree"})
	if p = m.(Page); p.status != "Removed worktree" {
		t.Errorf("status = %q", p.status)
	}
	p.facts.ws = &workspace.Workspace{Name: "ws", Projects: []workspace.WorkspaceProject{{Name: "ghost"}}}
	p.loaded = true
	p.rerow()
	if got := plain(p.View()); !strings.Contains(got, "ghost   worktree   not in the pool") {
		t.Errorf("ghost row:\n%s", got)
	}
}

// A member whose runner is still installing cannot be removed: the
// refusal lands on the error line, the member stays, and the page is not
// left busy.
func TestPage_RemoveMemberRefusedWhileRunnerAlive(t *testing.T) {
	tmp := setupTestConfig(t)
	repo := filepath.Join(tmp, "repos", "store-api")
	initRepo(t, repo)
	project.Add(project.Project{Name: "store-api", Path: repo, Setup: "sleep 2"})
	backgroundRunners(t)
	if _, _, err := workspace.CreateWith("ws", []workspace.ProjectSpec{{Name: "store-api"}}, workspace.CheckoutOptions{Install: true}); err != nil {
		t.Fatal(err)
	}
	p := settlePage(t, NewPage("ws"))
	p, _ = pressP(t, p, "up")
	p, _ = pressP(t, p, "d")
	p, _ = pressP(t, p, "y")
	if p.err == nil || !strings.Contains(p.err.Error(), "crew setup status ws/main") {
		t.Errorf("err = %v", p.err)
	}
	if ws, _ := workspace.Load("ws"); len(ws.Projects) != 1 {
		t.Error("the member survives")
	}
	if p.busy != "" {
		t.Error("the page must not stay busy after a refusal")
	}
}

// The page's picker carries the direct refusals of this workspace: with
// two worktrees, m stays worktree and says why.
func TestPage_PickerCarriesDirectRefusals(t *testing.T) {
	pageFixture(t)
	if err := workspace.AddWorktree("ws", "wrk2", workspace.CheckoutOptions{}); err != nil {
		t.Fatal(err)
	}
	p := settlePage(t, NewPage("ws"))
	p, _ = pressP(t, p, "a")
	if len(p.picker.rows) != 1 || !strings.Contains(p.picker.rows[0].Refusal, "has 2 worktrees") {
		t.Fatalf("rows = %+v", p.picker.rows)
	}
	p, _ = pressP(t, p, "m")
	if p.picker.rows[0].Mode != workspace.ModeWorktree || p.err == nil || !strings.Contains(p.err.Error(), "has 2 worktrees") {
		t.Errorf("m on a refused row: mode=%s err=%v", p.picker.rows[0].Mode, p.err)
	}
}

// ctrl+p on the new-worktree form pulls; a failure lands on the error line.
func TestPage_NewWorktreePull(t *testing.T) {
	pageFixture(t)
	p := settlePage(t, NewPage("ws"))
	p, _ = pressP(t, p, "n")
	p.bases.statuses = []workspace.BaseStatus{{Project: "store-api", Base: "main", Behind: 2}}
	gen := p.bases.gen
	m, cmd := p.Update(keyOf("ctrl+p"))
	p = m.(Page)
	if cmd == nil || p.bases.phase != workspace.BasePulling || p.bases.gen == gen {
		t.Fatalf("ctrl+p: phase=%v gen=%d→%d", p.bases.phase, gen, p.bases.gen)
	}
	m, _ = p.Update(basesMsg{gen: p.bases.gen, statuses: p.bases.statuses, pulled: []error{errors.New("store-api: fast-forwarding main failed")}})
	p = m.(Page)
	if !p.bases.ready() || p.err == nil || !strings.Contains(p.err.Error(), "fast-forwarding main failed") {
		t.Errorf("after the pull: phase=%v err=%v", p.bases.phase, p.err)
	}
}
