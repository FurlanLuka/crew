package workspace

import (
	"encoding/json"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

func setupTestConfig(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	config.ConfigDir = tmp
	config.WorkspacesDir = filepath.Join(tmp, "workspaces")
	config.ClaudeConfigDir = filepath.Join(tmp, "claude")
	os.MkdirAll(config.WorkspacesDir, 0o755)
	os.MkdirAll(config.ClaudeConfigDir, 0o755)
	return tmp
}

func TestCreateLoadSave(t *testing.T) {
	setupTestConfig(t)

	if err := Create("test-ws"); err != nil {
		t.Fatalf("Create: %v", err)
	}

	ws, err := Load("test-ws")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if ws.Name != "test-ws" {
		t.Errorf("Name = %q, want %q", ws.Name, "test-ws")
	}
	if len(ws.Projects) != 0 {
		t.Errorf("Projects = %d, want 0", len(ws.Projects))
	}

	ws.Projects = append(ws.Projects, WorkspaceProject{Name: "api", Role: "backend"})
	if err := Save(ws); err != nil {
		t.Fatalf("Save: %v", err)
	}

	ws2, err := Load("test-ws")
	if err != nil {
		t.Fatalf("Load after save: %v", err)
	}
	if len(ws2.Projects) != 1 {
		t.Errorf("Projects after save = %d, want 1", len(ws2.Projects))
	}
	if ws2.Projects[0].Name != "api" {
		t.Errorf("Project name = %q, want %q", ws2.Projects[0].Name, "api")
	}
}

func TestExists(t *testing.T) {
	setupTestConfig(t)

	if Exists("nope") {
		t.Error("Exists should be false for non-existent workspace")
	}

	if err := Create("exists-test"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if !Exists("exists-test") {
		t.Error("Exists should be true after Create")
	}
}

func TestCreateDuplicate(t *testing.T) {
	setupTestConfig(t)

	if err := Create("dup-test"); err != nil {
		t.Fatalf("Create: %v", err)
	}

	err := Create("dup-test")
	if err == nil {
		t.Error("Create should fail for duplicate workspace")
	}
}

func TestRemoveWorkspace(t *testing.T) {
	setupTestConfig(t)

	if err := Create("rm-test"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if !Exists("rm-test") {
		t.Fatal("workspace should exist after create")
	}

	if err := Remove("rm-test"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if Exists("rm-test") {
		t.Error("workspace should not exist after remove")
	}
}

func TestList(t *testing.T) {
	setupTestConfig(t)

	if err := Create("alpha"); err != nil {
		t.Fatalf("Create alpha: %v", err)
	}
	if err := Create("beta"); err != nil {
		t.Fatalf("Create beta: %v", err)
	}

	names, err := List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(names) != 2 {
		t.Fatalf("List returned %d names, want 2", len(names))
	}
}

func TestListSummaries(t *testing.T) {
	setupTestConfig(t)

	if err := Create("sum-ws"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	ws, _ := Load("sum-ws")
	ws.Projects = append(ws.Projects,
		WorkspaceProject{Name: "p1", Role: "r1"},
		WorkspaceProject{Name: "p2", Role: "r2"},
	)
	Save(ws)

	summaries, err := ListSummaries()
	if err != nil {
		t.Fatalf("ListSummaries: %v", err)
	}
	if len(summaries) != 1 {
		t.Fatalf("ListSummaries returned %d, want 1", len(summaries))
	}

	// One row per worktree: a fresh workspace has exactly its default one.
	s := summaries[0]
	if s.Name != "sum-ws/"+DefaultWorktree {
		t.Errorf("Name = %q, want %q", s.Name, "sum-ws/"+DefaultWorktree)
	}
	if s.Workspace != "sum-ws" || s.Worktree != DefaultWorktree {
		t.Errorf("split = (%q, %q), want (sum-ws, %s)", s.Workspace, s.Worktree, DefaultWorktree)
	}
	if s.ProjectCount != 2 {
		t.Errorf("ProjectCount = %d, want 2", s.ProjectCount)
	}
	if want := WorktreeDir(Ref{Workspace: "sum-ws", Worktree: DefaultWorktree}); s.Path != want {
		t.Errorf("Path = %q, want %q", s.Path, want)
	}
}

func TestListSummaries_OneRowPerWorktree(t *testing.T) {
	setupTestConfig(t)
	Save(&Workspace{Name: "multi", Worktrees: []Worktree{{Name: "wrk1"}, {Name: "wrk2"}}})

	summaries, err := ListSummaries()
	if err != nil {
		t.Fatalf("ListSummaries: %v", err)
	}
	if len(summaries) != 2 {
		t.Fatalf("got %d rows, want one per worktree", len(summaries))
	}
	if summaries[0].Name != "multi/wrk1" || summaries[1].Name != "multi/wrk2" {
		t.Errorf("rows = %q, %q", summaries[0].Name, summaries[1].Name)
	}
}

// TestSummaryJSONKeys locks the snake_case wire format used by `crew ls workspaces --json`.
func TestSummaryJSONKeys(t *testing.T) {
	data, err := json.Marshal(Summary{
		Name:         "ws/wt",
		Workspace:    "ws",
		Worktree:     "wt",
		Path:         "/p",
		ProjectCount: 3,
		DevRunning:   true,
	})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	want := `{"name":"ws/wt","workspace":"ws","worktree":"wt","path":"/p","project_count":3,"dev_running":true}`
	if string(data) != want {
		t.Errorf("Summary JSON = %s, want %s", data, want)
	}
}

func TestWorktreePath(t *testing.T) {
	tmp := t.TempDir()
	config.WorkspacesDir = filepath.Join(tmp, "workspaces")

	got := WorktreePath(Ref{Workspace: "wrk1"}, "api")
	want := filepath.Join(config.WorkspacesDir, "wrk1", "api")
	if got != want {
		t.Errorf("WorktreePath = %q, want %q", got, want)
	}
}

func TestResolvePathsPerMode(t *testing.T) {
	setupTestConfig(t)

	project.Add(project.Project{Name: "api", Path: "/canonical/api"})
	project.Add(project.Project{Name: "web", Path: "/canonical/web"})
	Save(&Workspace{Name: "ws", Projects: []WorkspaceProject{
		{Name: "api", Role: "r"},
		{Name: "web", Role: "r", Mode: ModeDirect},
	}})

	res, err := Resolve(Ref{Workspace: "ws"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if want := WorktreePath(Ref{Workspace: "ws"}, "api"); res.Projects[0].Path != want {
		t.Errorf("worktree path = %q, want %q", res.Projects[0].Path, want)
	}
	if res.Projects[1].Path != "/canonical/web" {
		t.Errorf("direct path = %q, want %q", res.Projects[1].Path, "/canonical/web")
	}
}

func TestIsDirect(t *testing.T) {
	cases := []struct {
		mode string
		want bool
	}{
		{"", false},
		{"worktree", false},
		{"direct", true},
		{"weird", false},
	}
	for _, c := range cases {
		got := IsDirect(WorkspaceProject{Mode: c.mode})
		if got != c.want {
			t.Errorf("IsDirect(%q) = %v, want %v", c.mode, got, c.want)
		}
	}
}

func TestWorkspaceProjectJSON_RoundTrip(t *testing.T) {
	// Empty mode round-trips through "" (omitempty keeps JSON tidy).
	worktree := WorkspaceProject{Name: "api", Role: "backend"}
	data, err := json.Marshal(worktree)
	if err != nil {
		t.Fatalf("marshal worktree: %v", err)
	}
	if strings.Contains(string(data), "\"mode\"") {
		t.Errorf("worktree JSON should omit mode field, got %s", data)
	}
	var decoded WorkspaceProject
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if IsDirect(decoded) {
		t.Error("decoded worktree should not be direct")
	}

	// Direct mode round-trips faithfully.
	direct := WorkspaceProject{Name: "api", Role: "backend", Mode: ModeDirect}
	data, err = json.Marshal(direct)
	if err != nil {
		t.Fatalf("marshal direct: %v", err)
	}
	if !strings.Contains(string(data), "\"mode\":\"direct\"") {
		t.Errorf("direct JSON missing mode field, got %s", data)
	}
	var decoded2 WorkspaceProject
	if err := json.Unmarshal(data, &decoded2); err != nil {
		t.Fatalf("unmarshal direct: %v", err)
	}
	if !IsDirect(decoded2) {
		t.Error("decoded direct should be direct")
	}

	// Old JSONs without mode decode as worktree.
	var legacy WorkspaceProject
	if err := json.Unmarshal([]byte(`{"name":"api","role":"r"}`), &legacy); err != nil {
		t.Fatalf("unmarshal legacy: %v", err)
	}
	if IsDirect(legacy) {
		t.Error("legacy entry without mode should not be direct")
	}
}

func TestWorkspaceDir(t *testing.T) {
	tmp := t.TempDir()
	config.WorkspacesDir = filepath.Join(tmp, "workspaces")

	got := WorkspaceDir("wrk1")
	want := filepath.Join(config.WorkspacesDir, "wrk1")
	if got != want {
		t.Errorf("WorkspaceDir = %q, want %q", got, want)
	}
}

func TestGeneratePrompt(t *testing.T) {
	setupTestConfig(t)

	res := newTestWorkspace(t, "prompt-test", []WorkspaceProject{
		{Name: "api", Role: "backend service"},
		{Name: "web", Role: "frontend app"},
	})

	text, err := GeneratePrompt(res)
	if err != nil {
		t.Fatalf("GeneratePrompt: %v", err)
	}

	if !containsAll(text, "api", "web", "backend service") {
		t.Error("prompt should contain project names and roles")
	}
	if !containsAll(text, "worktree") {
		t.Error("prompt should mention worktree (all workspace projects are worktrees now)")
	}
	if strings.Contains(text, "agent team") {
		t.Errorf("prompt must not instruct agent-team creation, got:\n%s", text)
	}
}

func TestGeneratePrompt_WritesFile(t *testing.T) {
	setupTestConfig(t)

	res := newTestWorkspace(t, "file-test", []WorkspaceProject{{Name: "p", Role: "r"}})

	GeneratePrompt(res)

	path := PromptFilePath(Ref{Workspace: "file-test"})
	if _, err := os.Stat(path); err != nil {
		t.Errorf("prompt file not created at %s", path)
	}
}

func TestBuildDevProjects(t *testing.T) {
	setupTestConfig(t)

	project.Add(project.Project{
		Name: "api",
		Path: "/base/api",
		DevServers: []project.DevServer{
			{Name: "server", Port: 3000, Command: "npm start"},
		},
	})
	project.Add(project.Project{
		Name: "web",
		Path: "/base/web",
	})

	Save(&Workspace{Name: "test-ws", Projects: []WorkspaceProject{
		{Name: "api", Role: "backend"},
		{Name: "web", Role: "frontend"},
	}})

	res, err := Resolve(Ref{Workspace: "test-ws"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	result := res.DevProjects()
	if len(result) != 1 {
		t.Fatalf("DevProjects returned %d projects, want 1 (web has no dev servers)", len(result))
	}
	expectedPath := WorktreePath(Ref{Workspace: "test-ws"}, "api")
	if result[0].Path != expectedPath {
		t.Errorf("Path = %q, want %q", result[0].Path, expectedPath)
	}
	if len(result[0].DevServers) != 1 {
		t.Errorf("DevServers = %d, want 1", len(result[0].DevServers))
	}
}

func TestPromptFilePath(t *testing.T) {
	tmp := t.TempDir()
	config.ConfigDir = tmp

	got := PromptFilePath(Ref{Workspace: "myws"})
	want := filepath.Join(tmp, "prompt-myws.md")
	if got != want {
		t.Errorf("PromptFilePath = %q, want %q", got, want)
	}
}

func TestCodeWorkspaceFilePath(t *testing.T) {
	tmp := t.TempDir()
	config.ConfigDir = tmp

	got := CodeWorkspaceFilePath(Ref{Workspace: "myws"})
	want := filepath.Join(tmp, "myws.code-workspace")
	if got != want {
		t.Errorf("CodeWorkspaceFilePath = %q, want %q", got, want)
	}
}

func TestRemove_CleansUpDirectory(t *testing.T) {
	setupTestConfig(t)

	if err := Create("cleanup-test"); err != nil {
		t.Fatalf("Create: %v", err)
	}

	dir := WorkspaceDir("cleanup-test")
	if _, err := os.Stat(dir); err != nil {
		t.Fatal("workspace directory should exist after create")
	}

	if err := Remove("cleanup-test"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Error("workspace directory should not exist after remove")
	}
	if Exists("cleanup-test") {
		t.Error("workspace JSON should not exist after remove")
	}
}

func TestDevProjects_MissingProject(t *testing.T) {
	setupTestConfig(t)

	Save(&Workspace{Name: "ws", Projects: []WorkspaceProject{{Name: "ghost", Role: "phantom"}}})
	res, err := Resolve(Ref{Workspace: "ws"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if result := res.DevProjects(); len(result) != 0 {
		t.Errorf("DevProjects returned %d projects, want 0 for missing pool project", len(result))
	}
}

func TestDetectDefaultBranch_Fallback(t *testing.T) {
	dir := t.TempDir()
	branch := detectDefaultBranch(dir)
	if branch != "HEAD" {
		t.Errorf("detectDefaultBranch for non-git dir = %q, want %q", branch, "HEAD")
	}
}

func TestCreateCreatesDirectory(t *testing.T) {
	setupTestConfig(t)

	if err := Create("dir-test"); err != nil {
		t.Fatalf("Create: %v", err)
	}

	dir := WorkspaceDir("dir-test")
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("workspace directory not created: %v", err)
	}
	if !info.IsDir() {
		t.Error("workspace path should be a directory")
	}
}

// ── Direct mode ──

// initRepo turns dir into a tiny git repo with an initial commit, so it can be
// used as a project pool entry for direct-mode tests.
func initRepo(t *testing.T, dir string) {
	t.Helper()
	for _, args := range [][]string{
		{"init", "--initial-branch=main"},
		{"-c", "user.email=a@b", "-c", "user.name=test", "commit", "--allow-empty", "-m", "init"},
	} {
		cmd := osexec.Command("git", append([]string{"-C", dir}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
}

func TestAddProject_DirectMode_NoWorktreeCreated(t *testing.T) {
	tmp := setupTestConfig(t)

	repo := filepath.Join(tmp, "repo")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	initRepo(t, repo)
	project.Add(project.Project{Name: "api", Path: repo})

	if err := Create("ws"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := AddProject("ws", "api", "backend", ModeDirect, CheckoutOptions{}); err != nil {
		t.Fatalf("AddProject direct: %v", err)
	}

	// No worktree should have been created under the workspaces tree.
	wt := WorktreePath(Ref{Workspace: "ws"}, "api")
	if _, err := os.Stat(wt); !os.IsNotExist(err) {
		t.Errorf("worktree dir %s should not exist for direct mode", wt)
	}

	ws, err := Load("ws")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(ws.Projects) != 1 || !IsDirect(ws.Projects[0]) {
		t.Fatalf("expected 1 direct project, got %+v", ws.Projects)
	}
}

func TestRemoveProject_DirectMode_LeavesRepoIntact(t *testing.T) {
	tmp := setupTestConfig(t)

	repo := filepath.Join(tmp, "repo")
	os.MkdirAll(repo, 0o755)
	initRepo(t, repo)

	sentinel := filepath.Join(repo, "SENTINEL")
	if err := os.WriteFile(sentinel, []byte("keep me"), 0o644); err != nil {
		t.Fatal(err)
	}

	project.Add(project.Project{Name: "api", Path: repo})

	if err := Create("ws"); err != nil {
		t.Fatal(err)
	}
	if err := AddProject("ws", "api", "backend", ModeDirect, CheckoutOptions{}); err != nil {
		t.Fatalf("AddProject direct: %v", err)
	}

	if err := RemoveProject("ws", "api"); err != nil {
		t.Fatalf("RemoveProject: %v", err)
	}

	if _, err := os.Stat(sentinel); err != nil {
		t.Fatalf("canonical repo sentinel was destroyed by RemoveProject: %v", err)
	}
	if _, err := os.Stat(repo); err != nil {
		t.Fatalf("canonical repo dir was destroyed by RemoveProject: %v", err)
	}
}

func TestRemove_DirectMode_LeavesRepoIntact(t *testing.T) {
	tmp := setupTestConfig(t)

	repo := filepath.Join(tmp, "repo")
	os.MkdirAll(repo, 0o755)
	initRepo(t, repo)

	sentinel := filepath.Join(repo, "SENTINEL")
	os.WriteFile(sentinel, []byte("keep me"), 0o644)

	project.Add(project.Project{Name: "api", Path: repo})

	if err := Create("ws"); err != nil {
		t.Fatal(err)
	}
	if err := AddProject("ws", "api", "backend", ModeDirect, CheckoutOptions{}); err != nil {
		t.Fatal(err)
	}

	if err := Remove("ws"); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	if _, err := os.Stat(sentinel); err != nil {
		t.Fatalf("canonical repo sentinel was destroyed by Remove: %v", err)
	}
	if _, err := os.Stat(repo); err != nil {
		t.Fatalf("canonical repo dir was destroyed by Remove: %v", err)
	}
}

func TestAddProject_DirectMode_CollisionRefused(t *testing.T) {
	tmp := setupTestConfig(t)

	repo := filepath.Join(tmp, "repo")
	os.MkdirAll(repo, 0o755)
	initRepo(t, repo)
	project.Add(project.Project{Name: "api", Path: repo})

	if err := Create("ws-a"); err != nil {
		t.Fatal(err)
	}
	if err := Create("ws-b"); err != nil {
		t.Fatal(err)
	}
	if err := AddProject("ws-a", "api", "owner", ModeDirect, CheckoutOptions{}); err != nil {
		t.Fatalf("first direct add: %v", err)
	}
	err := AddProject("ws-b", "api", "owner", ModeDirect, CheckoutOptions{})
	if err == nil {
		t.Fatal("second direct add should have been refused")
	}
	if !strings.Contains(err.Error(), "ws-a") {
		t.Errorf("error should mention conflicting workspace 'ws-a', got: %v", err)
	}
}

func TestDuplicateWorktree_RefusesDirectCollision(t *testing.T) {
	tmp := setupTestConfig(t)

	repo := filepath.Join(tmp, "repo")
	os.MkdirAll(repo, 0o755)
	initRepo(t, repo)
	project.Add(project.Project{Name: "api", Path: repo})

	if err := Create("ws-src"); err != nil {
		t.Fatal(err)
	}
	if err := AddProject("ws-src", "api", "owner", ModeDirect, CheckoutOptions{}); err != nil {
		t.Fatalf("AddProject direct: %v", err)
	}

	// A duplicate is a second worktree, and a direct project pins the workspace
	// to one — the same invariant, reached through DuplicateWorktree.
	err := DuplicateWorktree(Ref{Workspace: "ws-src", Worktree: DefaultWorktree}, "wrk2", CheckoutOptions{})
	if err == nil {
		t.Fatal("duplicating a worktree alongside a direct project should refuse")
	}
}

func TestGeneratePrompt_DirectModeFraming(t *testing.T) {
	tmp := setupTestConfig(t)

	repo := filepath.Join(tmp, "repo")
	os.MkdirAll(repo, 0o755)
	initRepo(t, repo)
	project.Add(project.Project{Name: "api", Path: repo})

	Save(&Workspace{Name: "ws", Projects: []WorkspaceProject{
		{Name: "api", Role: "backend", Mode: ModeDirect},
	}})
	res, err := Resolve(Ref{Workspace: "ws"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	text, err := GeneratePrompt(res)
	if err != nil {
		t.Fatalf("GeneratePrompt: %v", err)
	}
	if !containsAll(text, "[direct]", "CAUTION", "NOT isolated") {
		t.Errorf("direct-mode prompt missing direct framing:\n%s", text)
	}
	if strings.Contains(text, "IMPORTANT: `[worktree]`") {
		t.Errorf("direct-only workspace should not include worktree framing:\n%s", text)
	}
}

func TestGeneratePrompt_MixedModes(t *testing.T) {
	tmp := setupTestConfig(t)

	repo := filepath.Join(tmp, "repo")
	os.MkdirAll(repo, 0o755)
	initRepo(t, repo)
	project.Add(project.Project{Name: "api", Path: repo})
	project.Add(project.Project{Name: "web", Path: filepath.Join(tmp, "web")})

	Save(&Workspace{Name: "ws", Projects: []WorkspaceProject{
		{Name: "api", Role: "backend", Mode: ModeDirect},
		{Name: "web", Role: "frontend"},
	}})
	res, err := Resolve(Ref{Workspace: "ws"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	text, err := GeneratePrompt(res)
	if err != nil {
		t.Fatalf("GeneratePrompt: %v", err)
	}
	if !containsAll(text, "[direct]", "[worktree]", "CAUTION", "IMPORTANT") {
		t.Errorf("mixed-mode prompt missing both framings:\n%s", text)
	}
}

func TestRemove_DeletesPromptFiles(t *testing.T) {
	setupTestConfig(t)

	if err := Create("two-prompts"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	ws, _ := Load("two-prompts")
	ws.Projects = []WorkspaceProject{{Name: "p", Role: "r"}}
	Save(ws)

	res, err := Resolve(Ref{Workspace: "two-prompts"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	GeneratePrompt(res)
	// Stand in for a file left behind by a version that still wrote the
	// separate no-teams prompt; Remove must still clean it up.
	legacy := legacyNoTeamsPromptFilePath("two-prompts")
	os.WriteFile(legacy, []byte("stale"), 0o644)

	// The prompt is keyed by the worktree's slug, so ask the resolved ref
	// rather than assuming the flat pre-worktree filename.
	for _, path := range []string{PromptFilePath(res.Ref), legacy} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("expected %s to exist before Remove", path)
		}
	}

	if err := Remove("two-prompts"); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	for _, path := range []string{PromptFilePath(res.Ref), legacy} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("Remove should delete %s", path)
		}
	}
}

func TestAssertNoOtherDirect_IgnoresWorktreeEntries(t *testing.T) {
	tmp := setupTestConfig(t)

	repo := filepath.Join(tmp, "repo")
	os.MkdirAll(repo, 0o755)
	initRepo(t, repo)
	project.Add(project.Project{Name: "api", Path: repo})

	if err := Create("ws-other"); err != nil {
		t.Fatal(err)
	}
	// Pre-seed ws-other with a worktree entry for "api" by hand (avoid worktree creation).
	ws, _ := Load("ws-other")
	ws.Projects = append(ws.Projects, WorkspaceProject{Name: "api", Role: "r"})
	if err := Save(ws); err != nil {
		t.Fatal(err)
	}

	// A direct add elsewhere should NOT be blocked by a worktree entry.
	if err := assertNoOtherDirect("api", "ws-new"); err != nil {
		t.Errorf("worktree entries must not block direct adds: %v", err)
	}
}

// helper
func containsAll(s string, substrs ...string) bool {
	for _, sub := range substrs {
		if !strings.Contains(s, sub) {
			return false
		}
	}
	return true
}
