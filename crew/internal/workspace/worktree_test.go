package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
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
		if err := addProject(wsName, name, "", CheckoutOptions{}); err != nil {
			t.Fatalf("AddProject %s: %v", name, err)
		}
	}
	// A checkout failure is recorded, not returned: a fixture must not be
	// half-made under every assertion that follows.
	if h := recorded(t, Ref{Workspace: wsName, Worktree: DefaultWorktree}); h != nil {
		t.Fatalf("fixture checkout failed: %+v", h)
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
	// A passing workspace status is not a check verdict: nothing under
	// ~/.crew/checks is touched.
	if st, _ := SetupStatus(res.Ref); !st.Passed() {
		t.Fatalf("%+v", st)
	}
	if _, err := os.Stat(ChecksDir()); !os.IsNotExist(err) {
		t.Error("a workspace status must never reach the checks dir")
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
	// Git forgot it — the worktree and its branch — and the checkout sits
	// in the trash for the sweep.
	if list, _ := exec.RunGitCommand(project.Get("api").Path, "worktree", "list"); strings.Contains(list, "wrk2") {
		t.Errorf("removed checkout still registered:\n%s", list)
	}
	if branches, _ := exec.RunGitCommand(project.Get("api").Path, "branch", "--list", BranchName(ref, "api")); strings.TrimSpace(branches) != "" {
		t.Errorf("the worktree's branch should be deleted: %q", branches)
	}
	if !trashHolds(t, "api") {
		t.Error("checkout should be in the trash")
	}
}

// checkoutInTrash plants a trash entry, as a removal would.
func checkoutInTrash(t *testing.T, base string) {
	t.Helper()
	dir := filepath.Join(config.TrashDir, "1-"+base)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
}

// trashHolds reports whether a trash entry named after base exists.
func trashHolds(t *testing.T, base string) bool {
	t.Helper()
	entries, _ := os.ReadDir(config.TrashDir)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), "-"+base) {
			return true
		}
	}
	return false
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
		if err := addProject("ws", "api", ModeDirect, CheckoutOptions{}); err != nil {
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

		err := addProject("ws", "other", ModeDirect, CheckoutOptions{})
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

	if err := SetOverride(ref, "STORE_API_URL", "https://dev"); err != nil {
		t.Fatalf("SetOverride: %v", err)
	}
	res, _ := Resolve(ref)
	if res.Overrides["STORE_API_URL"] != "https://dev" {
		t.Errorf("overrides = %+v, want the value set", res.Overrides)
	}

	if err := ClearOverride(ref, "STORE_API_URL"); err != nil {
		t.Fatalf("ClearOverride: %v", err)
	}
	res, _ = Resolve(ref)
	if _, ok := res.Overrides["STORE_API_URL"]; ok {
		t.Errorf("overrides = %+v, want it cleared", res.Overrides)
	}
}

func TestDuplicateWorktree_CarriesOverrides(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	src := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	if err := SetOverride(src, "STORE_API_URL", "https://dev"); err != nil {
		t.Fatalf("SetOverride: %v", err)
	}

	if err := DuplicateWorktree(src, "wrk2", CheckoutOptions{}); err != nil {
		t.Fatalf("DuplicateWorktree: %v", err)
	}

	res, err := Resolve(Ref{Workspace: "ws", Worktree: "wrk2"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if res.Overrides["STORE_API_URL"] != "https://dev" {
		t.Errorf("overrides = %+v, want the source's override copied", res.Overrides)
	}
	if _, err := os.Stat(res.Projects[0].Path); err != nil {
		t.Errorf("duplicate has no checkout: %v", err)
	}
	if res.Health != nil {
		t.Errorf("clean duplicate recorded %+v", res.Health)
	}
}

// A failed install keeps the worktree and the checkouts that installed fine;
// Setup re-runs it. The runner stops at the failed step — a smoke of an
// install that did not finish would only add noise to the evidence.
func TestAddWorktree_InstallFailureKeepsWorktree(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	project.SetSetup("api", "exit 7")
	project.AddDevServer("api", project.DevServer{Name: "api", Port: 3000, Command: "sleep 30"})
	ref := Ref{Workspace: "ws", Worktree: "wrk2"}

	if err := AddWorktree("ws", "wrk2", CheckoutOptions{Install: true, Smoke: true}); err != nil {
		t.Fatalf("err = %v, want none: the failure is recorded, not returned", err)
	}
	if h := recorded(t, ref); h == nil || h.Summary() != "install failed: api" {
		t.Errorf("Health = %+v", h)
	}
	if got := strings.Join(stepsOf(t, ref), ","); got != "api:checkout,api:exit 7" {
		t.Errorf("steps = %s, want the install's failure to end the run", got)
	}
	if _, err := Resolve(ref); err != nil {
		t.Errorf("worktree should exist and resolve after an install failure: %v", err)
	}

	project.SetSetup("api", "true")
	if err := Setup(ref, CheckoutOptions{Install: true}, nil); err != nil {
		t.Fatalf("Setup after fixing the command: %v", err)
	}
	if h := recorded(t, ref); h != nil {
		t.Errorf("a passing install should clear, got %+v", h)
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
		"\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m          \x1b]7;file://Mac/x\x07➜  checkout-api eexport STORE_API_URL='x'; PORT=1 make start",
		"export STORE_API_URL='http://localhost:1'; PORT=1 make start_uvicorn",
		"\x1b[31merror: No environment file found at: `.env`\x1b[0m",
		"make: *** [start_uvicorn] Error 2",
		"➜  checkout-api git:(crew/x)",
		"",
	}, "\n")), 0o644)

	got := tailLog(path, 4)
	want := "error: No environment file found at: `.env`\nmake: *** [start_uvicorn] Error 2"
	if got != want {
		t.Errorf("tailLog =\n%q\nwant\n%q", got, want)
	}
}
