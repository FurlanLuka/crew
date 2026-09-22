package housekeeping

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
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
	os.MkdirAll(config.WorkspacesDir, 0o755)
	trash.DisableSweepForTest(t)
	return tmp
}

func paths(actions []Action, kind Kind) []string {
	var out []string
	for _, a := range actions {
		if a.Kind == kind {
			out = append(out, a.Path)
		}
	}
	return out
}

// The decision, case by case, over facts alone.
func TestPlan(t *testing.T) {
	setupTestConfig(t)
	now := time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)
	keep := 7 * 24 * time.Hour
	old := now.Add(-8 * 24 * time.Hour)
	fresh := now.Add(-time.Hour)
	live := dev.Slug("ws--wrk1")
	gone := dev.Slug("ws--wrk9")
	s := State{
		Checks: []CheckState{
			{Project: "old-fail", At: old, Failed: true},
			{Project: "fresh-fail", At: fresh, Failed: true},
			{Project: "passed", At: old, Passed: true},
			{Project: "running", At: old, Running: true},
			{Project: "pending", At: old}, // started, no result yet
		},
		LiveSlugs: map[dev.Slug]bool{live: true, "check--fresh-fail": true, "check--passed": true},
		SetupDirs: []dev.Slug{live, gone, "check--fresh-fail", "check--passed"},
		LogDirs:   []dev.Slug{live, gone},
		Routes:    []dev.Slug{live, gone},
		Locks: []Lock{
			{Path: "/l/with-json.json.lock", Orphan: false, Modified: old},
			{Path: "/l/fresh.json.lock", Orphan: true, Modified: now.Add(-time.Minute)},
			{Path: "/l/stale.json.lock", Orphan: true, Modified: now.Add(-2 * time.Hour)},
		},
		Trash: 2,
		Repos: []string{"/r/b", "/r/a"},
	}
	got := plan(s, now, keep)
	want := map[Kind][]string{
		KindCheck:  {workspace.WorktreeDir(workspace.CheckRef("old-fail")), workspace.WorktreeDir(workspace.CheckRef("passed"))},
		KindSetup:  {workspace.SetupDir(gone)},
		KindLogs:   {dev.LogDir(gone)},
		KindRoutes: {dev.RoutesFilePath(gone)},
		KindLock:   {"/l/stale.json.lock"},
		KindTrash:  {config.TrashDir},
		KindPrune:  {"/r/a", "/r/b"},
	}
	for kind, w := range want {
		if g := paths(got, kind); strings.Join(g, "\n") != strings.Join(w, "\n") {
			t.Errorf("%s:\n got %v\nwant %v", kind, g, w)
		}
	}
	if n := len(got); n != 9 {
		t.Errorf("%d actions, want 9: %+v", n, got)
	}
	if got := plan(State{}, now, keep); len(got) != 0 {
		t.Errorf("empty state plans %+v", got)
	}
}

func TestPlan_OrderIsDeterministic(t *testing.T) {
	setupTestConfig(t)
	s := State{Repos: []string{"/r/b", "/r/a"}, Trash: 1, Locks: []Lock{{Path: "/z.json.lock", Orphan: true}, {Path: "/a.json.lock", Orphan: true}}}
	got := plan(s, time.Now(), KeepChecks)
	var kinds []string
	for _, a := range got {
		kinds = append(kinds, string(a.Kind)+":"+a.Path)
	}
	if want := "lock:/a.json.lock,lock:/z.json.lock,prune:/r/a,prune:/r/b,trash:" + config.TrashDir; strings.Join(kinds, ",") != want {
		t.Errorf("order = %v", kinds)
	}
}

// A fixture with one live worktree and one gone: the sweep removes exactly
// the gone one's leftovers, a dry run removes nothing, and a report says
// which.
func TestSweep_RemovesOnlyOrphans(t *testing.T) {
	tmp := setupTestConfig(t)
	repo := filepath.Join(tmp, "repo")
	os.MkdirAll(repo, 0o755)
	project.Add(project.Project{Name: "api", Path: repo})
	if err := workspace.Create("ws"); err != nil {
		t.Fatal(err)
	}
	// Create records no worktree; write one so its slug is live.
	if err := workspace.Update("ws", func(ws *workspace.Workspace) error {
		ws.Worktrees = []workspace.Worktree{{Name: "wrk1"}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	live, gone := dev.Slug("ws--wrk1"), dev.Slug("ws--wrk9")
	for _, slug := range []dev.Slug{live, gone} {
		os.MkdirAll(workspace.SetupDir(slug), 0o755)
		os.MkdirAll(dev.LogDir(slug), 0o755)
		os.WriteFile(dev.RoutesFilePath(slug), []byte("[]"), 0o644)
	}
	staleLock := filepath.Join(config.WorkspacesDir, "old.json.lock")
	os.WriteFile(staleLock, nil, 0o644)
	os.Chtimes(staleLock, time.Now().Add(-2*time.Hour), time.Now().Add(-2*time.Hour))
	freshLock := filepath.Join(config.WorkspacesDir, "new.json.lock")
	os.WriteFile(freshLock, nil, 0o644)
	os.WriteFile(filepath.Join(config.WorkspacesDir, "ws.json.lock"), nil, 0o644)
	// The checks dir has the same three shapes: a pass leaves its lock
	// behind every time.
	os.MkdirAll(workspace.ChecksDir(), 0o755)
	staleCheckLock := filepath.Join(workspace.ChecksDir(), "gone.json.lock")
	os.WriteFile(staleCheckLock, nil, 0o644)
	os.Chtimes(staleCheckLock, time.Now().Add(-2*time.Hour), time.Now().Add(-2*time.Hour))
	freshCheckLock := filepath.Join(workspace.ChecksDir(), "new.json.lock")
	os.WriteFile(freshCheckLock, nil, 0o644)
	os.WriteFile(filepath.Join(workspace.ChecksDir(), "api.json"), []byte(`{"project":"api","at":"2026-01-01T00:00:00Z","worktree":{"name":"api"}}`), 0o644)
	os.MkdirAll(workspace.SetupDir("check--api"), 0o755)
	keptCheckLock := filepath.Join(workspace.ChecksDir(), "api.json.lock")
	os.WriteFile(keptCheckLock, nil, 0o644)
	os.Chtimes(keptCheckLock, time.Now().Add(-2*time.Hour), time.Now().Add(-2*time.Hour))

	dry := Sweep(Options{DryRun: true})
	for _, a := range dry {
		if a.Removed || a.Err != "" {
			t.Errorf("dry run touched %+v", a)
		}
	}
	for _, p := range []string{workspace.SetupDir(gone), dev.LogDir(gone), dev.RoutesFilePath(gone), staleLock, staleCheckLock} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("dry run removed %s", p)
		}
	}
	report := RenderReport(dry, true)
	if !strings.Contains(report, "setup\t"+workspace.SetupDir(gone)+"\twould remove\n") || strings.Contains(report, "removed\n") {
		t.Errorf("dry report:\n%s", report)
	}

	got := Sweep(Options{})
	if len(got) != len(dry) {
		t.Errorf("the real sweep should apply the dry plan: %+v vs %+v", got, dry)
	}
	for _, a := range got {
		if !a.Removed {
			t.Errorf("not removed: %+v", a)
		}
	}
	for _, p := range []string{workspace.SetupDir(gone), dev.LogDir(gone), dev.RoutesFilePath(gone), staleLock, staleCheckLock} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s should be gone", p)
		}
	}
	for _, p := range []string{workspace.SetupDir(live), dev.LogDir(live), dev.RoutesFilePath(live), freshLock, filepath.Join(config.WorkspacesDir, "ws.json.lock"), config.WorkspaceFile("ws"), freshCheckLock, keptCheckLock, workspace.SetupDir("check--api")} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("%s should stay", p)
		}
	}
	if len(Sweep(Options{})) != 0 {
		t.Error("a second sweep finds nothing")
	}
	if RenderReport(nil, false) != "nothing to clean\n" {
		t.Error("empty report")
	}
}

// A kept failed check ages out; a fresh one stays.
func TestSweep_FailedCheckAgesOut(t *testing.T) {
	tmp := setupTestConfig(t)
	repo := filepath.Join(tmp, "repo")
	os.MkdirAll(repo, 0o755)
	project.Add(project.Project{Name: "api", Path: repo})
	ref := workspace.CheckRef("api")
	rec := filepath.Join(workspace.ChecksDir(), "api.json")
	os.MkdirAll(workspace.ChecksDir(), 0o755)
	data, _ := json.Marshal(map[string]any{"project": "api", "at": time.Now().Add(-2 * time.Hour), "worktree": map[string]any{"name": "api", "health": map[string]any{"at": time.Now(), "issues": []any{map[string]any{"stage": "install", "project": "api", "detail": "x"}}}}})
	os.WriteFile(rec, data, 0o644)
	os.MkdirAll(workspace.SetupDir(ref.Slug()), 0o755)

	got := Sweep(Options{Keep: 24 * time.Hour})
	if len(paths(got, KindCheck)) != 0 || len(paths(got, KindSetup)) != 0 {
		t.Errorf("a fresh failed check stays, with its setup dir: %+v", got)
	}
	got = Sweep(Options{Keep: time.Hour})
	if p := paths(got, KindCheck); len(p) != 1 || p[0] != workspace.WorktreeDir(ref) || !got[0].Removed {
		t.Errorf("the aged check goes: %+v", got)
	}
	if _, err := os.Stat(rec); !os.IsNotExist(err) {
		t.Error("record should be gone")
	}
	if _, err := os.Stat(workspace.SetupDir(ref.Slug())); !os.IsNotExist(err) {
		t.Error("its setup dir goes with it")
	}
}

func TestApply_RefusesOutsideConfigDir(t *testing.T) {
	setupTestConfig(t)
	outside := t.TempDir()
	a := Action{Kind: KindLogs, Path: outside}
	apply(&a, false)
	if a.Removed || !strings.Contains(a.Err, "refused") {
		t.Errorf("%+v", a)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Error("the path must be untouched")
	}
	if !strings.Contains(RenderReport([]Action{a}, false), "failed: outside") {
		t.Error("the report names the refusal")
	}
}

// The stamp is the record of a full sweep; a start within the hour, or a
// command that must not sweep, leaves it alone; uninstall touches nothing.
// (The trash sweep those paths still run is stubbed here.)
func TestSweepOnStart_OncePerHour(t *testing.T) {
	setupTestConfig(t)
	stamp := filepath.Join(config.ConfigDir, "housekeeping.json")
	stampAt := func() time.Time {
		info, err := os.Stat(stamp)
		if err != nil {
			t.Fatal("no stamp after a sweep")
		}
		return info.ModTime()
	}
	SweepOnStart([]string{"ls"})
	first := stampAt()
	old := time.Now().Add(-2 * time.Hour)
	os.Chtimes(stamp, old, old)
	SweepOnStart([]string{"_setup", "ws/wrk1", "api"})
	if !stampAt().Equal(old) {
		t.Error("a runner start must not sweep")
	}
	SweepOnStart([]string{"ls"})
	if !stampAt().After(first) {
		t.Error("an old stamp sweeps again")
	}
	second := stampAt()
	SweepOnStart([]string{"ls"})
	if !stampAt().Equal(second) {
		t.Error("a second start within the hour does not sweep")
	}
	os.Remove(stamp)
	SweepOnStart([]string{"uninstall", "--yes"})
	if _, err := os.Stat(stamp); !os.IsNotExist(err) {
		t.Error("uninstall sweeps nothing")
	}
}

func TestShouldSweepOnStart(t *testing.T) {
	for _, tt := range []struct {
		args []string
		want bool
	}{
		{nil, true},
		{[]string{"ls", "worktrees"}, true},
		{[]string{"dev", "start", "ws"}, true},
		{[]string{"dev", "_proxy"}, false},
		{[]string{"_setup", "ws/wrk1", "api"}, false},
		{[]string{"uninstall", "--yes"}, false},
		{[]string{"clean"}, false},
		{[]string{"update"}, false},
	} {
		if got := shouldSweepOnStart(tt.args); got != tt.want {
			t.Errorf("%v → %v", tt.args, got)
		}
	}
}

func TestRenderReport_Outcomes(t *testing.T) {
	actions := []Action{
		{Kind: KindPrune, Path: "/r"},
		{Kind: KindLogs, Path: "/l"},
	}
	if got := RenderReport(actions, true); got != "prune\t/r\twould prune\nlogs\t/l\twould remove\n" {
		t.Errorf("dry:\n%s", got)
	}
	actions[0].Removed, actions[1].Removed = true, true
	if got := RenderReport(actions, false); got != "prune\t/r\tpruned\nlogs\t/l\tremoved\n" {
		t.Errorf("real:\n%s", got)
	}
}

// A check's state is read off its record and result file: passed and never
// looked at → removed now; started with no result → left; running → left;
// a runner that vanished without a verdict → failed, aged out with the rest.
func TestSweep_CheckStates(t *testing.T) {
	tmp := setupTestConfig(t)
	repo := filepath.Join(tmp, "repo")
	os.MkdirAll(repo, 0o755)
	project.Add(project.Project{Name: "api", Path: repo})
	ref := workspace.CheckRef("api")
	rec := filepath.Join(workspace.ChecksDir(), "api.json")
	os.MkdirAll(workspace.ChecksDir(), 0o755)
	record := func(at time.Time) {
		data, _ := json.Marshal(map[string]any{"project": "api", "at": at, "worktree": map[string]any{"name": "api"}})
		os.WriteFile(rec, data, 0o644)
	}
	result := func(r map[string]any) {
		os.MkdirAll(workspace.SetupDir(ref.Slug()), 0o755)
		data, _ := json.Marshal(r)
		os.WriteFile(filepath.Join(workspace.SetupDir(ref.Slug()), "api.json"), data, 0o644)
	}
	old := time.Now().Add(-2 * time.Hour)

	record(old) // started, no result yet
	if got := Sweep(Options{Keep: time.Hour}); len(got) != 0 {
		t.Errorf("a check with no result is left: %+v", got)
	}

	result(map[string]any{"pid": os.Getpid(), "started_at": time.Now(), "done": false})
	if got := Sweep(Options{Keep: time.Hour}); len(got) != 0 {
		t.Errorf("a running check is left: %+v", got)
	}

	result(map[string]any{"pid": 0, "started_at": old, "done": false})
	if got := paths(Sweep(Options{Keep: 24 * time.Hour}), KindCheck); len(got) != 0 {
		t.Errorf("a vanished runner is a failure, kept for the keep time: %+v", got)
	}
	if got := paths(Sweep(Options{Keep: time.Hour}), KindCheck); len(got) != 1 {
		t.Errorf("…then aged out: %+v", got)
	}

	record(time.Now())
	result(map[string]any{"pid": os.Getpid(), "started_at": time.Now(), "done": true, "issues": []any{}})
	got := Sweep(Options{})
	if p := paths(got, KindCheck); len(p) != 1 || !got[0].Removed {
		t.Fatalf("a passed check nobody looked at is removed now: %+v", got)
	}
	if _, err := os.Stat(rec); !os.IsNotExist(err) {
		t.Error("record gone")
	}
	if _, err := os.Stat(workspace.SetupDir(ref.Slug())); !os.IsNotExist(err) {
		t.Error("setup dir gone with it")
	}
}

// A slug the records do not know but whose dev or setup session is alive
// is live — its files stay until the session is gone.
func TestCollect_TmuxSessionKeepsSlugLive(t *testing.T) {
	if !exec.HasTmux() {
		t.Skip("tmux not available")
	}
	setupTestConfig(t)
	for _, tt := range []struct {
		name    string
		session func(dev.Slug) string
	}{
		{"setup", dev.SetupSessionName},
		{"dev", dev.SessionName},
	} {
		slug := dev.Slug(fmt.Sprintf("hk%d%s--wrk", os.Getpid(), tt.name))
		os.MkdirAll(workspace.SetupDir(slug), 0o755)
		os.WriteFile(dev.RoutesFilePath(slug), []byte("[]"), 0o644)
		session := tt.session(slug)
		if err := exec.CreateTmuxSession(session, ""); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { exec.KillTmuxSession(session) })
		if got := Sweep(Options{DryRun: true}); len(paths(got, KindSetup)) != 0 || len(paths(got, KindRoutes)) != 0 {
			t.Errorf("%s session alive: files must stay: %+v", tt.name, got)
		}
		exec.KillTmuxSession(session)
		if got := Sweep(Options{DryRun: true}); len(paths(got, KindSetup)) != 1 || len(paths(got, KindRoutes)) != 1 {
			t.Errorf("%s session gone: files are leftovers: %+v", tt.name, got)
		}
		os.RemoveAll(workspace.SetupDir(slug))
		os.Remove(dev.RoutesFilePath(slug))
	}
}

// Prune is crew clean's alone: one git worktree prune per pool repo that
// is a git repo, and a stale registration is what it clears.
func TestSweep_Prune(t *testing.T) {
	tmp := setupTestConfig(t)
	repo := filepath.Join(tmp, "repo")
	os.MkdirAll(repo, 0o755)
	for _, args := range [][]string{{"init", "-q", "--initial-branch=main"}, {"-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"}} {
		if _, err := exec.RunGitCommand(repo, args...); err != nil {
			t.Fatal(err)
		}
	}
	plain := filepath.Join(tmp, "plain")
	os.MkdirAll(plain, 0o755)
	project.Add(project.Project{Name: "api", Path: repo})
	project.Add(project.Project{Name: "docs", Path: plain})
	stale := filepath.Join(tmp, "stale-wt")
	if _, err := exec.RunGitCommand(repo, "worktree", "add", "-q", stale); err != nil {
		t.Fatal(err)
	}
	os.RemoveAll(stale)

	if got := paths(Sweep(Options{}), KindPrune); len(got) != 0 {
		t.Errorf("the start sweep never prunes: %v", got)
	}
	dry := Sweep(Options{DryRun: true, Prune: true})
	if got := paths(dry, KindPrune); len(got) != 1 || got[0] != repo {
		t.Fatalf("one prune, the git repo: %v", got)
	}
	if out, _ := exec.RunGitCommand(repo, "worktree", "list"); !strings.Contains(out, "stale-wt") {
		t.Error("a dry run prunes nothing")
	}
	got := Sweep(Options{Prune: true})
	var pruned *Action
	for i := range got {
		if got[i].Kind == KindPrune {
			pruned = &got[i]
		}
	}
	if pruned == nil || !pruned.Removed || len(paths(got, KindPrune)) != 1 {
		t.Errorf("%+v", got)
	}
	if out, _ := exec.RunGitCommand(repo, "worktree", "list"); strings.Contains(out, "stale-wt") {
		t.Error("the stale registration should be pruned")
	}
}
