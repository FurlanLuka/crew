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

	s := summaries[0]
	if s.Name != "sum-ws" {
		t.Errorf("Name = %q, want %q", s.Name, "sum-ws")
	}
	if s.ProjectCount != 2 {
		t.Errorf("ProjectCount = %d, want 2", s.ProjectCount)
	}
	if s.Path != WorkspaceDir("sum-ws") {
		t.Errorf("Path = %q, want %q", s.Path, WorkspaceDir("sum-ws"))
	}
}

// TestSummaryJSONKeys locks the snake_case wire format used by `crew ls workspaces --json`.
func TestSummaryJSONKeys(t *testing.T) {
	data, err := json.Marshal(Summary{
		Name:         "ws",
		Path:         "/p",
		ProjectCount: 3,
		DevRunning:   true,
	})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	want := `{"name":"ws","path":"/p","project_count":3,"dev_running":true}`
	if string(data) != want {
		t.Errorf("Summary JSON = %s, want %s", data, want)
	}
}

func TestProjectPath(t *testing.T) {
	tmp := t.TempDir()
	config.WorkspacesDir = filepath.Join(tmp, "workspaces")

	got := ProjectPath("wrk1", "api")
	want := filepath.Join(config.WorkspacesDir, "wrk1", "api")
	if got != want {
		t.Errorf("ProjectPath = %q, want %q", got, want)
	}
}

func TestWorktreePath(t *testing.T) {
	tmp := t.TempDir()
	config.WorkspacesDir = filepath.Join(tmp, "workspaces")

	got := WorktreePath("wrk1", "api")
	want := filepath.Join(config.WorkspacesDir, "wrk1", "api")
	if got != want {
		t.Errorf("WorktreePath = %q, want %q", got, want)
	}
}

func TestResolvePath(t *testing.T) {
	setupTestConfig(t)

	project.Add(project.Project{Name: "api", Path: "/canonical/api"})

	worktreeWp := WorkspaceProject{Name: "api", Role: "r"}
	got := ResolvePath("ws", worktreeWp)
	want := WorktreePath("ws", "api")
	if got != want {
		t.Errorf("ResolvePath worktree = %q, want %q", got, want)
	}

	directWp := WorkspaceProject{Name: "api", Role: "r", Mode: ModeDirect}
	got = ResolvePath("ws", directWp)
	want = "/canonical/api"
	if got != want {
		t.Errorf("ResolvePath direct = %q, want %q", got, want)
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

	ws := &Workspace{
		Name: "prompt-test",
		Projects: []WorkspaceProject{
			{Name: "api", Role: "backend service"},
			{Name: "web", Role: "frontend app"},
		},
	}

	text, err := GeneratePrompt(ws)
	if err != nil {
		t.Fatalf("GeneratePrompt: %v", err)
	}

	if !containsAll(text, "api", "web", "backend service") {
		t.Error("prompt should contain project names and roles")
	}
	if !containsAll(text, "worktree") {
		t.Error("prompt should mention worktree (all workspace projects are worktrees now)")
	}
}

func TestGeneratePrompt_WritesFile(t *testing.T) {
	setupTestConfig(t)

	ws := &Workspace{
		Name:     "file-test",
		Projects: []WorkspaceProject{{Name: "p", Role: "r"}},
	}

	GeneratePrompt(ws)

	path := PromptFilePath("file-test")
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

	wsProjects := []WorkspaceProject{
		{Name: "api", Role: "backend"},
		{Name: "web", Role: "frontend"},
	}

	result := BuildDevProjects("test-ws", wsProjects)
	if len(result) != 1 {
		t.Fatalf("BuildDevProjects returned %d projects, want 1 (web has no dev servers)", len(result))
	}
	expectedPath := ProjectPath("test-ws", "api")
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

	got := PromptFilePath("myws")
	want := filepath.Join(tmp, "prompt-myws.md")
	if got != want {
		t.Errorf("PromptFilePath = %q, want %q", got, want)
	}
}

func TestCodeWorkspaceFilePath(t *testing.T) {
	tmp := t.TempDir()
	config.ConfigDir = tmp

	got := CodeWorkspaceFilePath("myws")
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

func TestBuildDevProjects_MissingProject(t *testing.T) {
	setupTestConfig(t)

	wsProjects := []WorkspaceProject{{Name: "ghost", Role: "phantom"}}
	result := BuildDevProjects("ws", wsProjects)
	if len(result) != 0 {
		t.Errorf("BuildDevProjects returned %d projects, want 0 for missing pool project", len(result))
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
	if err := AddProject("ws", "api", "backend", ModeDirect); err != nil {
		t.Fatalf("AddProject direct: %v", err)
	}

	// No worktree should have been created under the workspaces tree.
	wt := WorktreePath("ws", "api")
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
	if err := AddProject("ws", "api", "backend", ModeDirect); err != nil {
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
	if err := AddProject("ws", "api", "backend", ModeDirect); err != nil {
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
	if err := AddProject("ws-a", "api", "owner", ModeDirect); err != nil {
		t.Fatalf("first direct add: %v", err)
	}
	err := AddProject("ws-b", "api", "owner", ModeDirect)
	if err == nil {
		t.Fatal("second direct add should have been refused")
	}
	if !strings.Contains(err.Error(), "ws-a") {
		t.Errorf("error should mention conflicting workspace 'ws-a', got: %v", err)
	}
}

func TestDuplicate_RefusesDirectCollision(t *testing.T) {
	tmp := setupTestConfig(t)

	repo := filepath.Join(tmp, "repo")
	os.MkdirAll(repo, 0o755)
	initRepo(t, repo)
	project.Add(project.Project{Name: "api", Path: repo})

	if err := Create("ws-src"); err != nil {
		t.Fatal(err)
	}
	if err := AddProject("ws-src", "api", "owner", ModeDirect); err != nil {
		t.Fatalf("AddProject direct: %v", err)
	}

	err := Duplicate("ws-src", "ws-dst")
	if err == nil {
		t.Fatal("duplicating a workspace with a direct entry should refuse (collision with source)")
	}
}

func TestGeneratePrompt_DirectModeFraming(t *testing.T) {
	tmp := setupTestConfig(t)

	repo := filepath.Join(tmp, "repo")
	os.MkdirAll(repo, 0o755)
	initRepo(t, repo)
	project.Add(project.Project{Name: "api", Path: repo})

	ws := &Workspace{
		Name: "ws",
		Projects: []WorkspaceProject{
			{Name: "api", Role: "backend", Mode: ModeDirect},
		},
	}
	text, err := GeneratePrompt(ws)
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

	ws := &Workspace{
		Name: "ws",
		Projects: []WorkspaceProject{
			{Name: "api", Role: "backend", Mode: ModeDirect},
			{Name: "web", Role: "frontend"},
		},
	}
	text, err := GeneratePrompt(ws)
	if err != nil {
		t.Fatalf("GeneratePrompt: %v", err)
	}
	if !containsAll(text, "[direct]", "[worktree]", "CAUTION", "IMPORTANT") {
		t.Errorf("mixed-mode prompt missing both framings:\n%s", text)
	}
}

func TestGenerateNoTeamsPrompt(t *testing.T) {
	setupTestConfig(t)

	ws := &Workspace{
		Name: "flat-ws",
		Projects: []WorkspaceProject{
			{Name: "api", Role: "backend service"},
			{Name: "web", Role: "frontend app"},
		},
	}

	text, err := GenerateNoTeamsPrompt(ws)
	if err != nil {
		t.Fatalf("GenerateNoTeamsPrompt: %v", err)
	}

	if strings.Contains(text, "agent team") {
		t.Errorf("no-teams prompt must not instruct agent-team creation, got:\n%s", text)
	}
	if !containsAll(text, "api", "web", "backend service", "frontend app", "flat-ws") {
		t.Errorf("no-teams prompt missing expected content:\n%s", text)
	}

	if _, err := os.Stat(NoTeamsPromptFilePath("flat-ws")); err != nil {
		t.Errorf("no-teams prompt file should be written: %v", err)
	}
	// Regular team prompt file should NOT be created by GenerateNoTeamsPrompt.
	if _, err := os.Stat(PromptFilePath("flat-ws")); !os.IsNotExist(err) {
		t.Error("GenerateNoTeamsPrompt should not write the agent-team prompt file")
	}
}

func TestRemove_DeletesBothPromptFiles(t *testing.T) {
	setupTestConfig(t)

	if err := Create("two-prompts"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	ws, _ := Load("two-prompts")
	ws.Projects = []WorkspaceProject{{Name: "p", Role: "r"}}
	Save(ws)

	GeneratePrompt(ws)
	GenerateNoTeamsPrompt(ws)

	for _, path := range []string{PromptFilePath("two-prompts"), NoTeamsPromptFilePath("two-prompts")} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("expected %s to exist before Remove", path)
		}
	}

	if err := Remove("two-prompts"); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	for _, path := range []string{PromptFilePath("two-prompts"), NoTeamsPromptFilePath("two-prompts")} {
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
