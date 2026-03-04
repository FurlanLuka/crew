package workspace

import (
	"os"
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

func TestGeneratePrompt_WithDevServers(t *testing.T) {
	setupTestConfig(t)

	project.Add(project.Project{
		Name: "api",
		Path: "/tmp/api",
		DevServers: []project.DevServer{
			{Name: "server", Port: 3000, Command: "npm start"},
		},
	})

	ws := &Workspace{
		Name: "dev-prompt",
		Projects: []WorkspaceProject{
			{Name: "api", Role: "backend"},
		},
	}

	text, err := GeneratePrompt(ws)
	if err != nil {
		t.Fatalf("GeneratePrompt: %v", err)
	}
	if !containsAll(text, "Dev servers", "port 3000") {
		t.Error("prompt should mention dev servers when configured")
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
	branch := DetectDefaultBranch(dir)
	if branch != "HEAD" {
		t.Errorf("DetectDefaultBranch for non-git dir = %q, want %q", branch, "HEAD")
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

// helper
func containsAll(s string, substrs ...string) bool {
	for _, sub := range substrs {
		if !strings.Contains(s, sub) {
			return false
		}
	}
	return true
}
