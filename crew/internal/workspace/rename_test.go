package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

func gitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := exec.RunGitCommand(dir, args...)
	if err != nil {
		t.Fatalf("git %v in %s: %v", args, dir, err)
	}
	return strings.TrimSpace(out)
}

// A rename moves the directory, the checkout's crew branch and every
// slug-keyed file, and the record follows with its overrides, ports and
// health; nothing of the old name is left.
func TestRenameWorktree(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	from := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	to := Ref{Workspace: "ws", Worktree: "dev"}
	repo := project.Get("api").Path
	if err := SetOverride(from, "X", "1"); err != nil {
		t.Fatal(err)
	}
	if err := SavePorts(from, map[string]int{"api/api": 4123}); err != nil {
		t.Fatal(err)
	}
	health := &Health{Issues: []Issue{{Stage: StageInstall, Project: "api", Detail: "old"}}}
	if err := RecordHealth(from, health); err != nil {
		t.Fatal(err)
	}
	steps := stepsOf(t, from)
	runnerLog, err := SetupLogs(from, "api", 50)
	if err != nil || runnerLog == "" {
		t.Fatalf("fixture runner log: %q, %v", runnerLog, err)
	}
	os.MkdirAll(dev.LogDir(from.Slug()), 0o755)
	os.WriteFile(dev.LogFile(from.Slug(), "api"), []byte("hello\n"), 0o644)
	os.WriteFile(CodeWorkspaceFilePath(from), []byte("{}"), 0o644)
	if _, err := GeneratePrompt(mustResolveT(t, from)); err != nil {
		t.Fatal(err)
	}

	got, warnings, err := RenameWorktree(Ref{Workspace: "ws", Worktree: DefaultWorktree}, "dev")
	if err != nil || got != to {
		t.Fatalf("RenameWorktree = %v, %v", got, err)
	}
	newPath := WorktreePath(to, "api")
	if _, err := os.Stat(newPath); err != nil {
		t.Fatal("the checkout should be at the new path")
	}
	if _, err := os.Stat(WorktreeDir(from)); !os.IsNotExist(err) {
		t.Error("the old directory should be gone")
	}
	gitOut(t, newPath, "status", "--porcelain")
	if list := gitOut(t, repo, "worktree", "list"); !strings.Contains(list, newPath) {
		t.Errorf("git's worktree list should name the new path:\n%s", list)
	}
	if old := gitOut(t, repo, "branch", "--list", BranchName(from, "api")); old != "" {
		t.Errorf("the old branch should be gone: %q", old)
	}
	if head := gitOut(t, newPath, "rev-parse", "--abbrev-ref", "HEAD"); head != BranchName(to, "api") {
		t.Errorf("HEAD = %s", head)
	}
	res := mustResolveT(t, to)
	if res.Overrides["X"] != "1" || res.Ports["api/api"] != 4123 || res.Health == nil || res.Health.Issues[0].Detail != "old" {
		t.Errorf("the record did not travel: overrides=%v ports=%v health=%+v", res.Overrides, res.Ports, res.Health)
	}
	if _, err := Resolve(from); err == nil {
		t.Error("the old ref should not resolve")
	}
	if got := stepsOf(t, to); strings.Join(got, ",") != strings.Join(steps, ",") {
		t.Errorf("setup table = %v, want %v", got, steps)
	}
	if got, err := SetupLogs(to, "api", 50); err != nil || got != runnerLog {
		t.Errorf("crew setup logs on the new ref = %q, %v", got, err)
	}
	if bare, err := Resolve(Ref{Workspace: "ws"}); err != nil || bare.Ref != to {
		t.Errorf("the bare ref should resolve to the renamed only worktree: %v %v", bare, err)
	}
	if _, err := os.Stat(SetupDir(from.Slug())); !os.IsNotExist(err) {
		t.Error("the old setup dir should be gone")
	}
	if data, _ := os.ReadFile(dev.LogFile(to.Slug(), "api")); string(data) != "hello\n" {
		t.Errorf("dev log at the new slug = %q", data)
	}
	if _, err := os.Stat(dev.LogDir(from.Slug())); !os.IsNotExist(err) {
		t.Error("the old log dir should be gone")
	}
	prompt, err := os.ReadFile(PromptFilePath(to))
	if err != nil || !strings.Contains(string(prompt), "ws/dev") || !strings.Contains(string(prompt), newPath) || strings.Contains(string(prompt), "ws/main") {
		t.Errorf("prompt at the new ref:\n%s", prompt)
	}
	if _, err := os.Stat(PromptFilePath(from)); !os.IsNotExist(err) {
		t.Error("the old prompt should be gone")
	}
	if _, err := os.Stat(CodeWorkspaceFilePath(from)); !os.IsNotExist(err) {
		t.Error("the old .code-workspace should be gone")
	}
	if _, err := os.Stat(CodeWorkspaceFilePath(to)); !os.IsNotExist(err) {
		t.Error("the .code-workspace is regenerated at launch, not copied")
	}
	if len(warnings) != 0 {
		t.Errorf("a checkout on its crew branch warns of nothing: %v", warnings)
	}
}

func mustResolveT(t *testing.T, ref Ref) *Resolved {
	t.Helper()
	res, err := Resolve(ref)
	if err != nil {
		t.Fatalf("Resolve %s: %v", ref, err)
	}
	return res
}

// Every refusal leaves the worktree where it was.
func TestRenameWorktree_Refusals(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	from := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	if err := AddWorktree("ws", "wrk2", CheckoutOptions{}); err != nil {
		t.Fatal(err)
	}
	repo := project.Get("api").Path
	gitOut(t, repo, "branch", "crew/ws/taken/api")
	Save(&Workspace{Name: "old", Projects: []WorkspaceProject{{Name: "api"}}})
	os.WriteFile(dev.RoutesFilePath(Ref{Workspace: "ws", Worktree: "wrk2"}.Slug()), []byte(`[{"project":"api","server_name":"api","internal_port":3999}]`), 0o644)

	for name, tt := range map[string]struct {
		ws, old, new string
		want         string
	}{
		"invalid name":       {"ws", "main", "Bad Name", "invalid"},
		"same name":          {"ws", "main", "main", "already the worktree's name"},
		"existing name":      {"ws", "main", "wrk2", "already has a worktree 'wrk2'"},
		"unknown worktree":   {"ws", "nope", "x", "no worktree 'nope'"},
		"bare ref, several":  {"ws", "", "x", "say which"},
		"flat workspace":     {"old", "", "x", "crew migrate"},
		"check target":       {CheckWorkspace, "api", "x", "not renamable"},
		"destination branch": {"ws", "main", "taken", "branch crew/ws/taken/api already exists"},
		"servers running":    {"ws", "wrk2", "x", "crew dev stop ws/wrk2"},
	} {
		_, _, err := RenameWorktree(Ref{Workspace: tt.ws, Worktree: tt.old}, tt.new)
		if err == nil || !strings.Contains(err.Error(), tt.want) {
			t.Errorf("%s: err = %v, want %q", name, err, tt.want)
		}
		if name == "servers running" && !errors.Is(err, ErrServersRunning) {
			t.Errorf("servers running should be ErrServersRunning: %v", err)
		}
	}
	// D3: something else under the new directory refuses; a member at both
	// places refuses; an empty directory is fine.
	os.MkdirAll(WorktreeDir(Ref{Workspace: "ws", Worktree: "taken2"}), 0o755)
	os.WriteFile(filepath.Join(WorktreeDir(Ref{Workspace: "ws", Worktree: "taken2"}), "notes.txt"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(WorktreeDir(from), "notes.txt"), []byte("x"), 0o644)
	if _, _, err := RenameWorktree(Ref{Workspace: "ws", Worktree: "main"}, "taken2"); err == nil || !strings.Contains(err.Error(), "already holds notes.txt") {
		t.Errorf("an entry under the new dir with a counterpart under the old: %v", err)
	}
	os.MkdirAll(WorktreePath(Ref{Workspace: "ws", Worktree: "both"}, "api"), 0o755)
	if _, _, err := RenameWorktree(Ref{Workspace: "ws", Worktree: "main"}, "both"); err == nil || !strings.Contains(err.Error(), "already holds api") {
		t.Errorf("a member at both places: %v", err)
	}
	if _, err := Resolve(from); err != nil {
		t.Error("nothing should have moved")
	}
	if _, err := os.Stat(WorktreePath(from, "api")); err != nil {
		t.Error("the checkout should still be at the old path")
	}
	if _, err := os.Stat(dev.RoutesFilePath(Ref{Workspace: "ws", Worktree: "wrk2"}.Slug())); err != nil {
		t.Error("a refusal leaves the routes file alone")
	}
	if _, err := Resolve(Ref{Workspace: "ws", Worktree: "wrk2"}); err != nil {
		t.Error("nothing should have moved")
	}
}

// A runner still installing holds the paths: refused with ErrSetupRunning.
func TestRenameWorktree_RefusedWhileRunnerAlive(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	project.SetSetup("api", "sleep 2")
	backgroundRunners(t)
	ref := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	if err := Setup(ref, CheckoutOptions{Install: true}, nil); err != nil {
		t.Fatal(err)
	}
	_, _, err := RenameWorktree(Ref{Workspace: "ws", Worktree: DefaultWorktree}, "dev")
	if !errors.Is(err, ErrSetupRunning) {
		t.Errorf("err = %v, want ErrSetupRunning", err)
	}
	if _, err := Resolve(ref); err != nil {
		t.Error("nothing should have moved")
	}
}

// Edges: an empty routes file does not block and is gone after; a
// checkout on its own branch keeps HEAD and its crew branch is renamed in
// the repo; leftovers under the new slug are replaced, not merged; a
// direct member's canonical checkout is untouched.
func TestRenameWorktree_Edges(t *testing.T) {
	tmp := setupTestConfig(t)
	for _, name := range []string{"api", "ops"} {
		repo := filepath.Join(tmp, "repos", name)
		os.MkdirAll(repo, 0o755)
		initRepo(t, repo)
		project.Add(project.Project{Name: name, Path: repo})
	}
	Create("ws")
	if _, err := AddProjects("ws", []ProjectSpec{{Name: "api"}, {Name: "ops", Mode: ModeDirect}}, CheckoutOptions{}); err != nil {
		t.Fatal(err)
	}
	from := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	to := Ref{Workspace: "ws", Worktree: "dev"}
	repo := project.Get("api").Path
	checkout := WorktreePath(from, "api")
	gitOut(t, checkout, "checkout", "-q", "-b", "feature/x")
	os.WriteFile(dev.RoutesFilePath(from.Slug()), []byte(`[]`), 0o644)
	os.MkdirAll(SetupDir(to.Slug()), 0o755)
	os.WriteFile(filepath.Join(SetupDir(to.Slug()), "ghost.json"), []byte("{}"), 0o644)
	os.MkdirAll(dev.LogDir(to.Slug()), 0o755)
	os.WriteFile(filepath.Join(dev.LogDir(to.Slug()), "stale.log"), []byte("old"), 0o644)
	os.MkdirAll(dev.LogDir(from.Slug()), 0o755)
	os.WriteFile(dev.LogFile(from.Slug(), "api"), []byte("mine\n"), 0o644)
	opsHead := gitOut(t, project.Get("ops").Path, "rev-parse", "HEAD")
	os.WriteFile(dev.RoutesFilePath(to.Slug()), []byte(`[{"project":"x","server_name":"x","internal_port":1}]`), 0o644)

	_, warnings, err := RenameWorktree(Ref{Workspace: "ws", Worktree: DefaultWorktree}, "dev")
	if err != nil {
		t.Fatal(err)
	}
	newPath := WorktreePath(to, "api")
	if head := gitOut(t, newPath, "rev-parse", "--abbrev-ref", "HEAD"); head != "feature/x" {
		t.Errorf("a feature branch is kept: HEAD = %s", head)
	}
	if gitOut(t, repo, "branch", "--list", BranchName(from, "api")) != "" || gitOut(t, repo, "branch", "--list", BranchName(to, "api")) == "" {
		t.Error("the crew branch should be renamed in the repo even when not checked out")
	}
	if len(warnings) != 1 || warnings[0] != "api kept — on feature/x" {
		t.Errorf("warnings = %v", warnings)
	}
	for _, slug := range []dev.Slug{from.Slug(), to.Slug()} {
		if _, err := os.Stat(dev.RoutesFilePath(slug)); !os.IsNotExist(err) {
			t.Errorf("routes file for %s should be gone", slug)
		}
	}
	if _, err := os.Stat(filepath.Join(SetupDir(to.Slug()), "ghost.json")); !os.IsNotExist(err) {
		t.Error("a leftover setup dir under the new slug is replaced, not merged")
	}
	if _, err := os.Stat(filepath.Join(SetupDir(to.Slug()), "api.json")); err != nil {
		t.Error("the moved setup table should be there")
	}
	if _, err := os.Stat(filepath.Join(dev.LogDir(to.Slug()), "stale.log")); !os.IsNotExist(err) {
		t.Error("a leftover log dir under the new slug is replaced, not merged")
	}
	if data, _ := os.ReadFile(dev.LogFile(to.Slug(), "api")); string(data) != "mine\n" {
		t.Errorf("the moved log should be there: %q", data)
	}
	res := mustResolveT(t, to)
	ops := project.Get("ops")
	for _, rp := range res.Projects {
		if rp.Name == "ops" && rp.Path != ops.Path {
			t.Errorf("the direct member still resolves to its canonical checkout: %s", rp.Path)
		}
	}
	if gitOut(t, ops.Path, "branch", "--list", BranchName(to, "ops")) != "" || gitOut(t, ops.Path, "rev-parse", "HEAD") != opsHead {
		t.Error("the canonical checkout was touched")
	}
}

// A member gone from the pool still travels: its directory moves with the
// loose entries, no git repair.
func TestRenameWorktree_GhostMember(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	from := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	to := Ref{Workspace: "ws", Worktree: "dev"}
	Update("ws", func(ws *Workspace) error {
		ws.Projects = append(ws.Projects, WorkspaceProject{Name: "ghost"})
		return nil
	})
	os.MkdirAll(WorktreePath(from, "ghost"), 0o755)
	os.WriteFile(filepath.Join(WorktreePath(from, "ghost"), "f"), []byte("x"), 0o644)
	if _, _, err := RenameWorktree(Ref{Workspace: "ws", Worktree: DefaultWorktree}, "dev"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(WorktreePath(to, "ghost"), "f")); err != nil {
		t.Error("the ghost's directory should have travelled")
	}
	gitOut(t, WorktreePath(to, "api"), "status", "--porcelain")
}

// A live dev session with no routes file — a crashed stop's shape — holds
// the paths too.
func TestRenameWorktree_RefusedUnderALiveSession(t *testing.T) {
	if !exec.HasTmux() {
		t.Skip("tmux not available")
	}
	// A workspace name of our own: the tmux server is shared with whatever
	// the user runs, and crew-dev-ws--main is a name they could have live.
	newRepoWorkspace(t, "renamews", "api")
	from := Ref{Workspace: "renamews", Worktree: DefaultWorktree}
	session := dev.SessionName(from.Slug())
	if err := exec.CreateTmuxSession(session, ""); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { exec.KillTmuxSession(session) })
	_, _, err := RenameWorktree(from, "dev")
	if !errors.Is(err, ErrServersRunning) {
		t.Errorf("err = %v, want ErrServersRunning", err)
	}
	if _, err := Resolve(from); err != nil {
		t.Error("nothing should have moved")
	}
}

func TestClassifyDirs(t *testing.T) {
	for _, tt := range []struct {
		from, to bool
		strays   []string
		expect   bool
		want     dirState
	}{
		{true, false, nil, true, dirFresh},
		{false, true, nil, true, dirResume},
		{true, true, nil, true, dirResume},
		{true, true, []string{"api"}, true, dirOccupied},
		{false, true, []string{"api"}, true, dirOccupied},
		{false, false, nil, true, dirLost},
		{false, false, nil, false, dirFresh},
		{true, true, []string{"notes"}, true, dirOccupied},
	} {
		if got := classifyDirs(tt.from, tt.to, tt.strays, tt.expect); got != tt.want {
			t.Errorf("classifyDirs(%v, %v, %v, %v) = %v, want %v", tt.from, tt.to, tt.strays, tt.expect, got, tt.want)
		}
	}
}

// Loose entries under the worktree dir travel, and a rename interrupted
// after they moved still finishes.
func TestRenameWorktree_LooseEntriesTravelAndResume(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	from := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	to := Ref{Workspace: "ws", Worktree: "dev"}
	os.MkdirAll(filepath.Join(WorktreeDir(from), "notes"), 0o755)
	os.WriteFile(filepath.Join(WorktreeDir(from), "notes", "a.md"), []byte("x"), 0o644)
	// The loose entry moved already; the checkout and the record did not.
	os.MkdirAll(WorktreeDir(to), 0o755)
	os.Rename(filepath.Join(WorktreeDir(from), "notes"), filepath.Join(WorktreeDir(to), "notes"))

	if _, _, err := RenameWorktree(from, "dev"); err != nil {
		t.Fatalf("resume with a loose entry moved: %v", err)
	}
	if _, err := os.Stat(filepath.Join(WorktreeDir(to), "notes", "a.md")); err != nil {
		t.Error("the loose entry should be under the new dir")
	}
	gitOut(t, WorktreePath(to, "api"), "status", "--porcelain")
}

// A bare ref names the only worktree, as everywhere else.
func TestRenameWorktree_BareRef(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	to, _, err := RenameWorktree(Ref{Workspace: "ws"}, "dev")
	if err != nil || to.Worktree != "dev" {
		t.Fatalf("bare ref: %v, %v", to, err)
	}
	if _, err := Resolve(Ref{Workspace: "ws", Worktree: "dev"}); err != nil {
		t.Error("renamed")
	}
}

// A rename interrupted after a checkout moved finishes on a rerun under
// the same new name; a different name refuses and explains.
func TestRenameWorktree_FinishesAHalfDoneMove(t *testing.T) {
	newRepoWorkspace(t, "ws", "api", "web")
	from := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	to := Ref{Workspace: "ws", Worktree: "dev"}
	repo := project.Get("api").Path
	os.MkdirAll(WorktreeDir(to), 0o755)
	if err := exec.MoveGitWorktree(repo, WorktreePath(from, "api"), WorktreePath(to, "api")); err != nil {
		t.Fatal(err)
	}
	exec.RenameGitBranch(WorktreePath(to, "api"), BranchName(from, "api"), BranchName(to, "api"))

	if _, _, err := RenameWorktree(Ref{Workspace: "ws", Worktree: DefaultWorktree}, "dev"); err != nil {
		t.Fatalf("rerun: %v", err)
	}
	for _, name := range []string{"api", "web"} {
		p := WorktreePath(to, name)
		gitOut(t, p, "status", "--porcelain")
		if head := gitOut(t, p, "rev-parse", "--abbrev-ref", "HEAD"); head != BranchName(to, name) {
			t.Errorf("%s HEAD = %s", name, head)
		}
	}
	if _, err := os.Stat(WorktreeDir(from)); !os.IsNotExist(err) {
		t.Error("the old directory should be gone")
	}
	if _, err := Resolve(from); err == nil {
		t.Error("the record should be renamed")
	}
	if _, _, err := RenameWorktree(Ref{Workspace: "ws", Worktree: DefaultWorktree}, "dev"); err == nil || !strings.Contains(err.Error(), "no worktree 'main'") {
		t.Errorf("a second rename: %v", err)
	}
}

// Files gone from both places under the record's name: a different target
// cannot be right — the resume rule refuses before any git call, so the
// fixture's plain rename (which leaves git's pointers stale) is enough.
func TestRenameWorktree_DifferentTargetAfterAMove(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	os.Rename(WorktreeDir(Ref{Workspace: "ws", Worktree: DefaultWorktree}), WorktreeDir(Ref{Workspace: "ws", Worktree: "moved"}))
	_, _, err := RenameWorktree(Ref{Workspace: "ws", Worktree: DefaultWorktree}, "other")
	if err == nil || !strings.Contains(err.Error(), "an earlier rename already moved it") {
		t.Errorf("different target after a move: %v", err)
	}
}

// Under the lock, a concurrent add worktree under the new name cannot
// leave the file holding the name twice.
func TestRenameWorktree_RacesAddWorktree(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	var wg sync.WaitGroup
	var renameErr, addErr error
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, _, renameErr = RenameWorktree(Ref{Workspace: "ws", Worktree: DefaultWorktree}, "dev")
	}()
	go func() { defer wg.Done(); addErr = AddWorktree("ws", "dev", CheckoutOptions{}) }()
	wg.Wait()
	if (renameErr == nil) == (addErr == nil) {
		t.Errorf("exactly one should win: rename=%v add=%v", renameErr, addErr)
	}
	for _, err := range []error{renameErr, addErr} {
		if err != nil && !strings.Contains(err.Error(), "already has a worktree 'dev'") {
			t.Errorf("the loser should say the name is taken: %v", err)
		}
	}
	gitOut(t, WorktreePath(Ref{Workspace: "ws", Worktree: "dev"}, "api"), "status", "--porcelain")
	ws, _ := Load("ws")
	n := 0
	for _, wt := range ws.Worktrees {
		if wt.Name == "dev" {
			n++
		}
	}
	if n != 1 {
		t.Errorf("worktrees = %+v, want dev once", ws.Worktrees)
	}
}
