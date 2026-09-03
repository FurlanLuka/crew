package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/project"
)

// newRepoWorkspace creates a workspace whose projects are real git repos, so
// worktree creation actually runs.
func newRepoWorkspace(t *testing.T, wsName string, projNames ...string) {
	t.Helper()
	tmp := setupTestConfig(t)

	for _, name := range projNames {
		repo := filepath.Join(tmp, "repos", name)
		os.MkdirAll(repo, 0o755)
		initRepo(t, repo)
		project.Add(project.Project{Name: name, Path: repo})
	}

	if err := Create(wsName); err != nil {
		t.Fatalf("Create: %v", err)
	}
	for _, name := range projNames {
		if err := AddProject(wsName, name, "role", ""); err != nil {
			t.Fatalf("AddProject %s: %v", name, err)
		}
	}
}

func TestCreate_SeedsDefaultWorktree(t *testing.T) {
	setupTestConfig(t)
	if err := Create("ws"); err != nil {
		t.Fatalf("Create: %v", err)
	}

	ws, err := Load("ws")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(ws.Worktrees) != 1 || ws.Worktrees[0].Name != DefaultWorktree {
		t.Fatalf("worktrees = %+v, want one named %q", ws.Worktrees, DefaultWorktree)
	}

	// A bare ref has to resolve for every command that takes a workspace name.
	if _, err := Resolve(Ref{Workspace: "ws"}); err != nil {
		t.Errorf("bare ref should resolve for a fresh workspace: %v", err)
	}
}

func TestAddWorktree_ChecksOutEveryProject(t *testing.T) {
	newRepoWorkspace(t, "ws", "api", "web")

	if err := AddWorktree("ws", "wrk2"); err != nil {
		t.Fatalf("AddWorktree: %v", err)
	}

	res, err := Resolve(Ref{Workspace: "ws", Worktree: "wrk2"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(res.Projects) != 2 {
		t.Fatalf("resolved %d projects, want 2", len(res.Projects))
	}
	for _, p := range res.Projects {
		if _, err := os.Stat(p.Path); err != nil {
			t.Errorf("%s not checked out at %s", p.Name, p.Path)
		}
	}
}

// The regression this whole branch-naming change exists for: without the
// worktree in the branch name, the second worktree tries to recreate a branch
// git already has checked out, and fails.
func TestAddWorktree_SecondWorktreeDoesNotCollideOnBranch(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")

	if err := AddWorktree("ws", "wrk2"); err != nil {
		t.Fatalf("AddWorktree wrk2: %v", err)
	}
	if err := AddWorktree("ws", "wrk3"); err != nil {
		t.Fatalf("AddWorktree wrk3: %v", err)
	}

	for _, wt := range []string{DefaultWorktree, "wrk2", "wrk3"} {
		ref := Ref{Workspace: "ws", Worktree: wt}
		if _, err := os.Stat(WorktreePath(ref, "api")); err != nil {
			t.Errorf("%s has no checkout: %v", ref, err)
		}
	}
}

func TestAddWorktree_RejectsDuplicateAndBadNames(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")

	if err := AddWorktree("ws", DefaultWorktree); err == nil {
		t.Error("duplicate worktree name should be rejected")
	}
	if err := AddWorktree("ws", "wrk--2"); err == nil {
		t.Error("'--' in a worktree name should be rejected")
	}
}

func TestRemoveWorktree(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	if err := AddWorktree("ws", "wrk2"); err != nil {
		t.Fatalf("AddWorktree: %v", err)
	}

	ref := Ref{Workspace: "ws", Worktree: "wrk2"}
	if err := RemoveWorktree("ws", "wrk2"); err != nil {
		t.Fatalf("RemoveWorktree: %v", err)
	}

	if _, err := os.Stat(WorktreeDir(ref)); !os.IsNotExist(err) {
		t.Errorf("worktree directory should be gone")
	}
	ws, _ := Load("ws")
	if len(ws.Worktrees) != 1 {
		t.Errorf("worktrees = %+v, want just the default left", ws.Worktrees)
	}
}

func TestRemoveWorktree_RefusesTheLastOne(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")

	err := RemoveWorktree("ws", DefaultWorktree)
	if err == nil {
		t.Fatal("removing the last worktree should be refused")
	}
	if !strings.Contains(err.Error(), "remove the workspace instead") {
		t.Errorf("error = %q, should point at removing the workspace", err)
	}
}

// A direct project has one canonical checkout, so two worktrees would share it
// — the clobbering assertNoOtherDirect prevents between workspaces. The pin is
// enforced from both directions, since either order reaches the same state.
func TestDirectModePin_BothDirections(t *testing.T) {
	t.Run("worktree refused when a direct project exists", func(t *testing.T) {
		tmp := setupTestConfig(t)
		repo := filepath.Join(tmp, "repo")
		os.MkdirAll(repo, 0o755)
		initRepo(t, repo)
		project.Add(project.Project{Name: "api", Path: repo})

		Create("ws")
		if err := AddProject("ws", "api", "r", ModeDirect); err != nil {
			t.Fatalf("AddProject direct: %v", err)
		}

		err := AddWorktree("ws", "wrk2")
		if err == nil {
			t.Fatal("adding a worktree alongside a direct project should be refused")
		}
		if !strings.Contains(err.Error(), "direct mode") {
			t.Errorf("error = %q, should name the direct project", err)
		}
	})

	t.Run("direct project refused when worktrees exist", func(t *testing.T) {
		newRepoWorkspace(t, "ws", "api")
		if err := AddWorktree("ws", "wrk2"); err != nil {
			t.Fatalf("AddWorktree: %v", err)
		}

		repo := filepath.Join(t.TempDir(), "other")
		os.MkdirAll(repo, 0o755)
		initRepo(t, repo)
		project.Add(project.Project{Name: "other", Path: repo})

		err := AddProject("ws", "other", "r", ModeDirect)
		if err == nil {
			t.Fatal("adding a direct project to a multi-worktree workspace should be refused")
		}
		if !strings.Contains(err.Error(), "worktrees") {
			t.Errorf("error = %q, should explain the worktree count", err)
		}
	})
}

func TestSetAndClearOverride(t *testing.T) {
	setupTestConfig(t)
	Create("ws")
	ref := Ref{Workspace: "ws", Worktree: DefaultWorktree}

	if err := SetOverride(ref, "SPEAK_API_URL", "https://dev"); err != nil {
		t.Fatalf("SetOverride: %v", err)
	}
	res, _ := Resolve(ref)
	if res.Overrides["SPEAK_API_URL"] != "https://dev" {
		t.Errorf("overrides = %+v, want the value set", res.Overrides)
	}

	if err := ClearOverride(ref, "SPEAK_API_URL"); err != nil {
		t.Fatalf("ClearOverride: %v", err)
	}
	res, _ = Resolve(ref)
	if _, ok := res.Overrides["SPEAK_API_URL"]; ok {
		t.Errorf("overrides = %+v, want it cleared", res.Overrides)
	}
}

func TestDuplicateWorktree_CarriesOverrides(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	src := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	if err := SetOverride(src, "SPEAK_API_URL", "https://dev"); err != nil {
		t.Fatalf("SetOverride: %v", err)
	}

	if err := DuplicateWorktree(src, "wrk2"); err != nil {
		t.Fatalf("DuplicateWorktree: %v", err)
	}

	res, err := Resolve(Ref{Workspace: "ws", Worktree: "wrk2"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if res.Overrides["SPEAK_API_URL"] != "https://dev" {
		t.Errorf("overrides = %+v, want the source's override copied", res.Overrides)
	}
	if _, err := os.Stat(res.Projects[0].Path); err != nil {
		t.Errorf("duplicate has no checkout: %v", err)
	}
}
