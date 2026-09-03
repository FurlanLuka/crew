package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/exec"
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
		if err := AddProject(wsName, name, "role", "", CheckoutOptions{}); err != nil {
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

	if err := AddWorktree("ws", "wrk2", CheckoutOptions{}); err != nil {
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

	if err := AddWorktree("ws", "wrk2", CheckoutOptions{}); err != nil {
		t.Fatalf("AddWorktree wrk2: %v", err)
	}
	if err := AddWorktree("ws", "wrk3", CheckoutOptions{}); err != nil {
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

	if err := AddWorktree("ws", DefaultWorktree, CheckoutOptions{}); err == nil {
		t.Error("duplicate worktree name should be rejected")
	}
	if err := AddWorktree("ws", "wrk--2", CheckoutOptions{}); err == nil {
		t.Error("'--' in a worktree name should be rejected")
	}
}

func TestRemoveWorktree(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	if err := AddWorktree("ws", "wrk2", CheckoutOptions{}); err != nil {
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
		if err := AddProject("ws", "api", "r", ModeDirect, CheckoutOptions{}); err != nil {
			t.Fatalf("AddProject direct: %v", err)
		}

		err := AddWorktree("ws", "wrk2", CheckoutOptions{})
		if err == nil {
			t.Fatal("adding a worktree alongside a direct project should be refused")
		}
		if !strings.Contains(err.Error(), "direct mode") {
			t.Errorf("error = %q, should name the direct project", err)
		}
	})

	t.Run("direct project refused when worktrees exist", func(t *testing.T) {
		newRepoWorkspace(t, "ws", "api")
		if err := AddWorktree("ws", "wrk2", CheckoutOptions{}); err != nil {
			t.Fatalf("AddWorktree: %v", err)
		}

		repo := filepath.Join(t.TempDir(), "other")
		os.MkdirAll(repo, 0o755)
		initRepo(t, repo)
		project.Add(project.Project{Name: "other", Path: repo})

		err := AddProject("ws", "other", "r", ModeDirect, CheckoutOptions{})
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

	if err := DuplicateWorktree(src, "wrk2", CheckoutOptions{}); err != nil {
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

// A failed checkout rolls back what was made, so a retry starts clean.
func TestAddWorktree_CheckoutFailureRollsBack(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	// A second project whose pool entry is gone makes the second checkout fail.
	ws, _ := Load("ws")
	ws.Projects = append(ws.Projects, WorkspaceProject{Name: "ghost"})
	Save(ws)

	err := AddWorktree("ws", "wrk2", CheckoutOptions{})
	if err == nil {
		t.Fatal("expected the missing pool entry to fail the checkout")
	}

	ref := Ref{Workspace: "ws", Worktree: "wrk2"}
	if _, statErr := os.Stat(WorktreeDir(ref)); !os.IsNotExist(statErr) {
		t.Errorf("worktree dir left behind after a failed checkout")
	}
	ws, _ = Load("ws")
	for _, wt := range ws.Worktrees {
		if wt.Name == "wrk2" {
			t.Error("failed worktree was recorded")
		}
	}
	// The api checkout was made before ghost failed; git must not still know it.
	if list, _ := exec.RunGitCommand(project.Get("api").Path, "worktree", "list"); strings.Contains(list, "wrk2") {
		t.Errorf("rolled-back checkout still registered:\n%s", list)
	}
}

// A failed install keeps the worktree and the checkouts that installed fine;
// Setup re-runs it.
func TestAddWorktree_InstallFailureKeepsWorktree(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	project.SetSetup("api", "exit 7")

	var reported []string
	err := AddWorktree("ws", "wrk2", CheckoutOptions{
		Install: true,
		Progress: func(proj string, r exec.SetupResult) {
			reported = append(reported, proj+":"+r.Step.Name)
		},
	})

	var setupErr *SetupError
	if !errors.As(err, &setupErr) {
		t.Fatalf("err = %v, want a SetupError", err)
	}
	if len(reported) != 1 || reported[0] != "api:exit 7" {
		t.Errorf("reported %v", reported)
	}
	if _, err := Resolve(Ref{Workspace: "ws", Worktree: "wrk2"}); err != nil {
		t.Errorf("worktree should exist and resolve after an install failure: %v", err)
	}

	project.SetSetup("api", "true")
	if err := Setup(Ref{Workspace: "ws", Worktree: "wrk2"}, CheckoutOptions{Install: true}); err != nil {
		t.Errorf("Setup after fixing the command: %v", err)
	}
}

// The canonical repo often has no .env — it was only ever written inside a
// checkout. A new worktree takes it from a sibling rather than starting bare.
func TestAddWorktree_CopiesEnvFromSiblingWhenCanonicalHasNone(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	os.WriteFile(filepath.Join(WorktreePath(Ref{Workspace: "ws", Worktree: DefaultWorktree}, "api"), ".env"), []byte("SECRET=1\n"), 0o644)

	if err := AddWorktree("ws", "wrk2", CheckoutOptions{}); err != nil {
		t.Fatalf("AddWorktree: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(WorktreePath(Ref{Workspace: "ws", Worktree: "wrk2"}, "api"), ".env"))
	if err != nil {
		t.Fatalf(".env not copied from the sibling worktree: %v", err)
	}
	if string(data) != "SECRET=1\n" {
		t.Errorf(".env = %q", data)
	}
}

func TestTailLog_StripsPromptNoise(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.log")
	os.WriteFile(path, []byte(strings.Join([]string{
		"\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m          \x1b]7;file://Mac/x\x07➜  ai-tutor-api eexport SPEAK_API_URL='x'; PORT=1 make start",
		"export SPEAK_API_URL='http://localhost:1'; PORT=1 make start_uvicorn",
		"\x1b[31merror: No environment file found at: `.env`\x1b[0m",
		"make: *** [start_uvicorn] Error 2",
		"➜  ai-tutor-api git:(crew/x)",
		"",
	}, "\n")), 0o644)

	got := tailLog(path, 4)
	want := "error: No environment file found at: `.env`\nmake: *** [start_uvicorn] Error 2"
	if got != want {
		t.Errorf("tailLog =\n%q\nwant\n%q", got, want)
	}
}
