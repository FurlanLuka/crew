package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/homebrew-tap/crew/internal/config"
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

func TestNormalizeName(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"feature/x", "feature-x"},
		{"plain", "plain"},
		{"a/b/c", "a-b-c"},
		{"no-slash", "no-slash"},
		{"", ""},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := NormalizeName(tt.input)
			if got != tt.want {
				t.Errorf("NormalizeName(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestWorktreeWorkspaceName(t *testing.T) {
	tests := []struct {
		base string
		wt   string
		want string
	}{
		{"myws", "feature", "myws--feature"},
		{"base", "fix-bug", "base--fix-bug"},
	}

	for _, tt := range tests {
		t.Run(tt.base+"_"+tt.wt, func(t *testing.T) {
			got := WorktreeWorkspaceName(tt.base, tt.wt)
			if got != tt.want {
				t.Errorf("WorktreeWorkspaceName(%q, %q) = %q, want %q", tt.base, tt.wt, got, tt.want)
			}
		})
	}
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

	ws.Projects = append(ws.Projects, Project{Name: "api", Path: "/tmp/api", Role: "backend"})
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

func TestRemove(t *testing.T) {
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
	// Create a worktree workspace — should be excluded
	ws := &Workspace{Name: "alpha--wt1", Worktree: &WorktreeInfo{BaseWorkspace: "alpha", Name: "wt1"}, Projects: []Project{}}
	if err := Save(ws); err != nil {
		t.Fatalf("Save: %v", err)
	}

	names, err := List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(names) != 2 {
		t.Fatalf("List returned %d names, want 2", len(names))
	}
	for _, n := range names {
		if strings.Contains(n, "--") {
			t.Errorf("List should exclude worktree names, got %q", n)
		}
	}
}

func TestListWorktrees(t *testing.T) {
	setupTestConfig(t)

	if err := Create("base"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := Save(&Workspace{Name: "base--wt1", Worktree: &WorktreeInfo{BaseWorkspace: "base", Name: "wt1"}, Projects: []Project{}}); err != nil {
		t.Fatalf("Save wt1: %v", err)
	}
	if err := Save(&Workspace{Name: "base--wt2", Worktree: &WorktreeInfo{BaseWorkspace: "base", Name: "wt2"}, Projects: []Project{}}); err != nil {
		t.Fatalf("Save wt2: %v", err)
	}
	if err := Save(&Workspace{Name: "other--wt3", Worktree: &WorktreeInfo{BaseWorkspace: "other", Name: "wt3"}, Projects: []Project{}}); err != nil {
		t.Fatalf("Save wt3: %v", err)
	}

	wts, err := ListWorktrees("base")
	if err != nil {
		t.Fatalf("ListWorktrees: %v", err)
	}
	if len(wts) != 2 {
		t.Fatalf("ListWorktrees returned %d, want 2", len(wts))
	}

	// Should not include "other" worktrees
	for _, wt := range wts {
		if wt == "wt3" {
			t.Error("ListWorktrees should not include worktrees from other bases")
		}
	}
}

func TestCountWorktrees(t *testing.T) {
	setupTestConfig(t)

	if err := Create("count-base"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := Save(&Workspace{Name: "count-base--a", Projects: []Project{}}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := Save(&Workspace{Name: "count-base--b", Projects: []Project{}}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	got := CountWorktrees("count-base")
	if got != 2 {
		t.Errorf("CountWorktrees = %d, want 2", got)
	}
}

func TestAddProject(t *testing.T) {
	setupTestConfig(t)

	if err := Create("add-proj"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	proj := Project{Name: "frontend", Path: "/tmp/frontend", Role: "ui"}
	if err := AddProject("add-proj", proj); err != nil {
		t.Fatalf("AddProject: %v", err)
	}

	ws, _ := Load("add-proj")
	if len(ws.Projects) != 1 {
		t.Fatalf("Projects = %d, want 1", len(ws.Projects))
	}
	if ws.Projects[0].Name != "frontend" {
		t.Errorf("Project name = %q, want %q", ws.Projects[0].Name, "frontend")
	}
}

func TestRemoveProject(t *testing.T) {
	setupTestConfig(t)

	if err := Create("rm-proj"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := AddProject("rm-proj", Project{Name: "a", Path: "/a", Role: "x"}); err != nil {
		t.Fatalf("AddProject a: %v", err)
	}
	if err := AddProject("rm-proj", Project{Name: "b", Path: "/b", Role: "y"}); err != nil {
		t.Fatalf("AddProject b: %v", err)
	}

	if err := RemoveProject("rm-proj", "a"); err != nil {
		t.Fatalf("RemoveProject: %v", err)
	}

	ws, _ := Load("rm-proj")
	if len(ws.Projects) != 1 {
		t.Fatalf("Projects = %d, want 1", len(ws.Projects))
	}
	if ws.Projects[0].Name != "b" {
		t.Errorf("Remaining project = %q, want %q", ws.Projects[0].Name, "b")
	}
}

func TestGeneratePrompt(t *testing.T) {
	setupTestConfig(t)

	ws := &Workspace{
		Name: "prompt-test",
		Projects: []Project{
			{Name: "api", Path: "/tmp/api", Role: "backend service"},
			{Name: "web", Path: "/tmp/web", Role: "frontend app"},
		},
	}

	text, err := GeneratePrompt(ws)
	if err != nil {
		t.Fatalf("GeneratePrompt: %v", err)
	}

	if !strings.Contains(text, "api") || !strings.Contains(text, "web") {
		t.Error("prompt should contain project names")
	}
	if !strings.Contains(text, "backend service") {
		t.Error("prompt should contain project roles")
	}
	if strings.Contains(text, "worktree") {
		t.Error("prompt should not mention worktree when Worktree is nil")
	}
}

func TestGeneratePrompt_WithWorktree(t *testing.T) {
	setupTestConfig(t)

	ws := &Workspace{
		Name:     "wt-prompt",
		Worktree: &WorktreeInfo{BaseWorkspace: "base", Name: "feature"},
		Projects: []Project{
			{Name: "api", Path: "/tmp/api", Role: "backend"},
		},
	}

	text, err := GeneratePrompt(ws)
	if err != nil {
		t.Fatalf("GeneratePrompt: %v", err)
	}
	if !strings.Contains(text, "worktree") {
		t.Error("prompt should mention worktree when Worktree is set")
	}
}

func TestGeneratePrompt_WithDevServers(t *testing.T) {
	setupTestConfig(t)

	ws := &Workspace{
		Name: "dev-prompt",
		Projects: []Project{
			{
				Name: "api",
				Path: "/tmp/api",
				Role: "backend",
				DevServers: []DevServer{
					{Name: "server", Port: 3000, Command: "npm start"},
				},
			},
		},
	}

	text, err := GeneratePrompt(ws)
	if err != nil {
		t.Fatalf("GeneratePrompt: %v", err)
	}
	if !strings.Contains(text, "Dev servers") {
		t.Error("prompt should mention dev servers when configured")
	}
	if !strings.Contains(text, "port 3000") {
		t.Error("prompt should contain dev server port")
	}
}

func TestGeneratePrompt_WritesFile(t *testing.T) {
	setupTestConfig(t)

	ws := &Workspace{
		Name:     "file-test",
		Projects: []Project{{Name: "p", Path: "/tmp/p", Role: "r"}},
	}

	GeneratePrompt(ws)

	path := PromptFilePath("file-test")
	if _, err := os.Stat(path); err != nil {
		t.Errorf("prompt file not created at %s", path)
	}
}

func TestBuildDevProjects(t *testing.T) {
	baseWs := &Workspace{
		Name: "base",
		Projects: []Project{
			{
				Name: "api",
				Path: "/base/api",
				Role: "backend",
				DevServers: []DevServer{
					{Name: "server", Port: 3000, Command: "npm start"},
				},
			},
			{
				Name: "web",
				Path: "/base/web",
				Role: "frontend",
			},
		},
	}

	srcProjects := []Project{
		{Name: "api", Path: "/wt/api", Role: "backend"},
		{Name: "web", Path: "/wt/web", Role: "frontend"},
	}

	result := BuildDevProjects(baseWs, srcProjects)
	if len(result) != 1 {
		t.Fatalf("BuildDevProjects returned %d projects, want 1 (web has no dev servers)", len(result))
	}
	if result[0].Path != "/wt/api" {
		t.Errorf("Path = %q, want /wt/api (should use srcProject path)", result[0].Path)
	}
	if len(result[0].DevServers) != 1 {
		t.Errorf("DevServers = %d, want 1", len(result[0].DevServers))
	}
}

func TestBuildDevProjects_NoMatch(t *testing.T) {
	baseWs := &Workspace{
		Name: "base",
		Projects: []Project{
			{Name: "api", Path: "/base/api", Role: "backend"},
		},
	}
	srcProjects := []Project{
		{Name: "unknown", Path: "/wt/unknown", Role: "x"},
	}

	result := BuildDevProjects(baseWs, srcProjects)
	if len(result) != 0 {
		t.Errorf("BuildDevProjects returned %d, want 0 for non-matching project", len(result))
	}
}

func TestListSummaries(t *testing.T) {
	setupTestConfig(t)

	if err := Create("sum-ws"); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := AddProject("sum-ws", Project{Name: "p1", Path: "/p1", Role: "r1"}); err != nil {
		t.Fatalf("AddProject p1: %v", err)
	}
	if err := AddProject("sum-ws", Project{Name: "p2", Path: "/p2", Role: "r2"}); err != nil {
		t.Fatalf("AddProject p2: %v", err)
	}
	if err := Save(&Workspace{Name: "sum-ws--wt1", Projects: []Project{}}); err != nil {
		t.Fatalf("Save: %v", err)
	}

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
	if s.WorktreeCount != 1 {
		t.Errorf("WorktreeCount = %d, want 1", s.WorktreeCount)
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

