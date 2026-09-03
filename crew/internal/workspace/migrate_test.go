package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

func TestSplitWorkspaceName(t *testing.T) {
	tests := []struct {
		input string
		ws    string
		wt    string
	}{
		{"phone-speak-wrk1", "phone-speak", "wrk1"},
		{"phone-speak-wrk2", "phone-speak", "wrk2"},
		{"speak-partner-wrk1", "speak-partner", "wrk1"},
		{"x-wrk10", "x", "wrk10"},
		{"mumbo", "mumbo", DefaultWorktree},
		{"flat", "flat", DefaultWorktree},

		// "wrk1" alone is a workspace name, not a suffix — there is nothing in
		// front of the separator to be the workspace.
		{"wrk1", "wrk1", DefaultWorktree},
		// Only a digit suffix is the convention; -wrkfoo is just a name.
		{"thing-wrkfoo", "thing-wrkfoo", DefaultWorktree},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			ws, wt := SplitWorkspaceName(tt.input)
			if ws != tt.ws || wt != tt.wt {
				t.Errorf("SplitWorkspaceName(%q) = (%q, %q), want (%q, %q)", tt.input, ws, wt, tt.ws, tt.wt)
			}
		})
	}
}

// saveLegacy writes a workspace in the pre-worktree shape: no worktrees key.
func saveLegacy(t *testing.T, name string, projects ...WorkspaceProject) {
	t.Helper()
	if err := Save(&Workspace{Name: name, Projects: projects}); err != nil {
		t.Fatalf("Save %s: %v", name, err)
	}
}

func TestPlanMigration_MergesByConvention(t *testing.T) {
	setupTestConfig(t)
	saveLegacy(t, "phone-speak-wrk1", WorkspaceProject{Name: "api", Role: "backend"})
	saveLegacy(t, "phone-speak-wrk2", WorkspaceProject{Name: "api", Role: "backend"}, WorkspaceProject{Name: "web"})
	saveLegacy(t, "mumbo", WorkspaceProject{Name: "mumbo"})

	plan, err := PlanMigration()
	if err != nil {
		t.Fatalf("PlanMigration: %v", err)
	}

	if len(plan.Moves) != 3 {
		t.Fatalf("planned %d moves, want 3", len(plan.Moves))
	}
	if got := plan.Merges["phone-speak"]; len(got) != 2 {
		t.Errorf("phone-speak folds %v, want both wrk workspaces", got)
	}
	if len(plan.Conflicts) != 0 {
		t.Errorf("conflicts = %v, want none", plan.Conflicts)
	}

	byOld := map[string]Ref{}
	for _, m := range plan.Moves {
		byOld[m.OldWorkspace] = m.Ref
	}
	if got := byOld["phone-speak-wrk2"]; got.Workspace != "phone-speak" || got.Worktree != "wrk2" {
		t.Errorf("phone-speak-wrk2 → %s, want phone-speak/wrk2", got)
	}
	if got := byOld["mumbo"]; got.Worktree != DefaultWorktree {
		t.Errorf("mumbo → %s, want the default worktree", got)
	}
}

func TestPlanMigration_SkipsAlreadyMigrated(t *testing.T) {
	setupTestConfig(t)
	Save(&Workspace{Name: "done", Worktrees: []Worktree{{Name: "main"}}})

	plan, err := PlanMigration()
	if err != nil {
		t.Fatalf("PlanMigration: %v", err)
	}
	if len(plan.Moves) != 0 {
		t.Errorf("planned %d moves for already-migrated state, want 0", len(plan.Moves))
	}
	if NeedsMigration() {
		t.Error("NeedsMigration should be false once every workspace has worktrees")
	}
}

// Merging a project held direct in one old workspace and as a worktree in
// another would produce a direct project alongside several worktrees, which the
// pin forbids. Refuse rather than silently write it.
func TestPlanMigration_RefusesMixedDirectMerge(t *testing.T) {
	setupTestConfig(t)
	saveLegacy(t, "ws-wrk1", WorkspaceProject{Name: "api", Mode: ModeDirect})
	saveLegacy(t, "ws-wrk2", WorkspaceProject{Name: "api"})

	plan, err := PlanMigration()
	if err != nil {
		t.Fatalf("PlanMigration: %v", err)
	}
	if len(plan.Conflicts) == 0 {
		t.Fatal("mixing direct and worktree for one project should conflict")
	}
	if !strings.Contains(strings.Join(plan.Conflicts, "\n"), "api") {
		t.Errorf("conflicts %v should name the project", plan.Conflicts)
	}
}

// assertNoOtherDirect is per-project, so two old workspaces holding different
// direct projects is legal today — and unmergeable.
func TestPlanMigration_RefusesTwoDirectProjectsInOneWorkspace(t *testing.T) {
	setupTestConfig(t)
	saveLegacy(t, "ws-wrk1", WorkspaceProject{Name: "api", Mode: ModeDirect})
	saveLegacy(t, "ws-wrk2", WorkspaceProject{Name: "web", Mode: ModeDirect})

	plan, err := PlanMigration()
	if err != nil {
		t.Fatalf("PlanMigration: %v", err)
	}
	if len(plan.Conflicts) == 0 {
		t.Fatal("two direct projects folding into one workspace should conflict")
	}
}

func TestApplyMigration_RefusesAPlanWithConflicts(t *testing.T) {
	setupTestConfig(t)
	plan := &MigrationPlan{
		Moves:     []MigrationMove{{OldWorkspace: "a", Ref: Ref{Workspace: "a", Worktree: "main"}}},
		Conflicts: []string{"something"},
	}

	if err := ApplyMigration(plan, t.TempDir()); err == nil {
		t.Fatal("ApplyMigration should refuse a conflicted plan")
	}
}

// legacyWorkspaceWithCheckout builds a pre-worktree workspace whose project is
// a real git worktree at the flat path, which is what migration has to move.
func legacyWorkspaceWithCheckout(t *testing.T, wsName, projName string) string {
	t.Helper()
	tmp := config.ConfigDir

	repo := filepath.Join(tmp, "repos", projName)
	os.MkdirAll(repo, 0o755)
	initRepo(t, repo)
	project.Add(project.Project{Name: projName, Path: repo})

	old := Ref{Workspace: wsName}
	os.MkdirAll(WorktreeDir(old), 0o755)
	if err := exec.CreateGitWorktree(repo, WorktreePath(old, projName), BranchName(old, projName), "HEAD"); err != nil {
		t.Fatalf("CreateGitWorktree: %v", err)
	}
	saveLegacy(t, wsName, WorkspaceProject{Name: projName, Role: "r"})
	return repo
}

func TestApplyMigration_MovesCheckoutsAndRenamesBranches(t *testing.T) {
	setupTestConfig(t)
	repo := legacyWorkspaceWithCheckout(t, "phone-speak-wrk1", "api")

	plan, err := PlanMigration()
	if err != nil {
		t.Fatalf("PlanMigration: %v", err)
	}
	if err := ApplyMigration(plan, filepath.Join(t.TempDir(), "backup")); err != nil {
		t.Fatalf("ApplyMigration: %v", err)
	}

	newRef := Ref{Workspace: "phone-speak", Worktree: "wrk1"}
	newPath := WorktreePath(newRef, "api")
	if _, err := os.Stat(newPath); err != nil {
		t.Fatalf("checkout not at %s: %v", newPath, err)
	}
	if _, err := os.Stat(WorktreePath(Ref{Workspace: "phone-speak-wrk1"}, "api")); !os.IsNotExist(err) {
		t.Error("old checkout path should be gone")
	}

	// git's gitdir pointer has to survive the move, or the worktree is a
	// directory of files that git no longer knows about.
	if _, err := exec.RunGitCommand(newPath, "status", "--porcelain"); err != nil {
		t.Errorf("git does not recognise the moved worktree: %v", err)
	}

	branch, _ := exec.RunGitCommand(newPath, "rev-parse", "--abbrev-ref", "HEAD")
	if want := BranchName(newRef, "api"); strings.TrimSpace(branch) != want {
		t.Errorf("branch = %q, want %q", strings.TrimSpace(branch), want)
	}

	list, _ := exec.RunGitCommand(repo, "worktree", "list")
	if !strings.Contains(list, newPath) {
		t.Errorf("git worktree list does not mention %s:\n%s", newPath, list)
	}

	ws, err := Load("phone-speak")
	if err != nil {
		t.Fatalf("Load migrated workspace: %v", err)
	}
	if len(ws.Worktrees) != 1 || ws.Worktrees[0].Name != "wrk1" {
		t.Errorf("worktrees = %+v, want one named wrk1", ws.Worktrees)
	}
	if _, err := Load("phone-speak-wrk1"); err == nil {
		t.Error("old workspace JSON should be gone")
	}
}

// mumbo → mumbo/main moves a checkout into a new child of the very directory
// being iterated.
func TestApplyMigration_SelfNesting(t *testing.T) {
	setupTestConfig(t)
	legacyWorkspaceWithCheckout(t, "mumbo", "mumbo")

	plan, _ := PlanMigration()
	if err := ApplyMigration(plan, filepath.Join(t.TempDir(), "backup")); err != nil {
		t.Fatalf("ApplyMigration: %v", err)
	}

	want := WorktreePath(Ref{Workspace: "mumbo", Worktree: DefaultWorktree}, "mumbo")
	if _, err := os.Stat(want); err != nil {
		t.Fatalf("checkout not at %s: %v", want, err)
	}
	if _, err := os.Stat(filepath.Join(want, "mumbo")); err == nil {
		t.Error("checkout nested one level too deep")
	}
}

// `git worktree move` onto an existing directory nests inside it and exits 0,
// which on a one-shot migration is worse than failing.
func TestApplyMigration_RefusesWhenDestinationExists(t *testing.T) {
	setupTestConfig(t)
	legacyWorkspaceWithCheckout(t, "ws-wrk1", "api")

	occupied := WorktreePath(Ref{Workspace: "ws", Worktree: "wrk1"}, "api")
	os.MkdirAll(occupied, 0o755)

	plan, _ := PlanMigration()
	err := ApplyMigration(plan, filepath.Join(t.TempDir(), "backup"))
	if err == nil {
		t.Fatal("migration should refuse to move onto an existing path")
	}
	if !strings.Contains(err.Error(), "already exists") {
		t.Errorf("error = %q, want it to name the collision", err)
	}

	// A refused migration must leave the previous state loadable.
	if _, err := Load("ws-wrk1"); err != nil {
		t.Errorf("old workspace should survive a failed migration: %v", err)
	}
}

func TestApplyMigration_RerunIsANoOp(t *testing.T) {
	setupTestConfig(t)
	legacyWorkspaceWithCheckout(t, "ws-wrk1", "api")

	plan, _ := PlanMigration()
	if err := ApplyMigration(plan, filepath.Join(t.TempDir(), "backup")); err != nil {
		t.Fatalf("first ApplyMigration: %v", err)
	}

	second, err := PlanMigration()
	if err != nil {
		t.Fatalf("second PlanMigration: %v", err)
	}
	if len(second.Moves) != 0 {
		t.Errorf("second run planned %d moves, want 0", len(second.Moves))
	}
	if err := ApplyMigration(second, filepath.Join(t.TempDir(), "backup2")); err != nil {
		t.Errorf("re-running migration should be a no-op: %v", err)
	}
}

func TestApplyMigration_RenamesArtifacts(t *testing.T) {
	setupTestConfig(t)
	legacyWorkspaceWithCheckout(t, "ws-wrk1", "api")

	oldRef := Ref{Workspace: "ws-wrk1"}
	os.WriteFile(PromptFilePath(oldRef), []byte("old prompt"), 0o644)
	os.WriteFile(CodeWorkspaceFilePath(oldRef), []byte("{}"), 0o644)

	plan, _ := PlanMigration()
	if err := ApplyMigration(plan, filepath.Join(t.TempDir(), "backup")); err != nil {
		t.Fatalf("ApplyMigration: %v", err)
	}

	// The old slug's artifacts are stale the moment the paths inside them
	// change, so they must not be left behind to be picked up later.
	for _, path := range []string{PromptFilePath(oldRef), CodeWorkspaceFilePath(oldRef)} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("%s should have been removed", path)
		}
	}
}

func TestApplyMigration_BacksUpBeforeMoving(t *testing.T) {
	setupTestConfig(t)
	legacyWorkspaceWithCheckout(t, "ws-wrk1", "api")

	backup := filepath.Join(t.TempDir(), "backup")
	plan, _ := PlanMigration()
	if err := ApplyMigration(plan, backup); err != nil {
		t.Fatalf("ApplyMigration: %v", err)
	}

	if _, err := os.Stat(filepath.Join(backup, "ws-wrk1.json")); err != nil {
		t.Errorf("pre-migration workspace JSON not backed up: %v", err)
	}
	if _, err := os.Stat(filepath.Join(backup, "projects.json")); err != nil {
		t.Errorf("project pool not backed up: %v", err)
	}
}

func TestBackupDir(t *testing.T) {
	setupTestConfig(t)
	got := BackupDir(time.Date(2026, 9, 3, 10, 30, 0, 0, time.UTC))
	if want := filepath.Join(config.ConfigDir, "backup-20260903-103000"); got != want {
		t.Errorf("BackupDir = %q, want %q", got, want)
	}
}

func TestMigratedPaths(t *testing.T) {
	plan := &MigrationPlan{Moves: []MigrationMove{{
		OldWorkspace: "phone-speak-wrk1",
		Ref:          Ref{Workspace: "phone-speak", Worktree: "wrk1"},
		Projects:     []WorkspaceProject{{Name: "api"}, {Name: "direct", Mode: ModeDirect}},
	}}}

	pairs := MigratedPaths(plan)
	if len(pairs) != 1 {
		t.Fatalf("got %d pairs, want 1 — direct projects do not move", len(pairs))
	}
	if !strings.HasSuffix(pairs[0][1], filepath.Join("phone-speak", "wrk1", "api")) {
		t.Errorf("new path = %q, want it under phone-speak/wrk1", pairs[0][1])
	}
}
