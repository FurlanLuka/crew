package project

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

func setupTestConfig(t *testing.T) {
	t.Helper()
	tmp := t.TempDir()
	config.ConfigDir = tmp
	config.WorkspacesDir = filepath.Join(tmp, "workspaces")
	config.ClaudeConfigDir = filepath.Join(tmp, "claude")
	os.MkdirAll(config.WorkspacesDir, 0o755)
	os.MkdirAll(config.ClaudeConfigDir, 0o755)
}

func TestList_Empty(t *testing.T) {
	setupTestConfig(t)

	projects, err := List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if projects != nil {
		t.Errorf("List on missing file = %v, want nil", projects)
	}
}

func TestAddAndList(t *testing.T) {
	setupTestConfig(t)

	if err := Add(Project{Name: "api", Path: "/tmp/api"}); err != nil {
		t.Fatalf("Add api: %v", err)
	}
	if err := Add(Project{Name: "web", Path: "/tmp/web"}); err != nil {
		t.Fatalf("Add web: %v", err)
	}

	projects, err := List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(projects) != 2 {
		t.Fatalf("List returned %d, want 2", len(projects))
	}
	if projects[0].Name != "api" {
		t.Errorf("projects[0].Name = %q, want %q", projects[0].Name, "api")
	}
	if projects[1].Name != "web" {
		t.Errorf("projects[1].Name = %q, want %q", projects[1].Name, "web")
	}
}

func TestRemove(t *testing.T) {
	setupTestConfig(t)

	if err := Add(Project{Name: "a", Path: "/a"}); err != nil {
		t.Fatalf("Add a: %v", err)
	}
	if err := Add(Project{Name: "b", Path: "/b"}); err != nil {
		t.Fatalf("Add b: %v", err)
	}

	if err := Remove("a"); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	projects, _ := List()
	if len(projects) != 1 {
		t.Fatalf("After remove: %d projects, want 1", len(projects))
	}
	if projects[0].Name != "b" {
		t.Errorf("Remaining = %q, want %q", projects[0].Name, "b")
	}
}

func TestGet_Found(t *testing.T) {
	setupTestConfig(t)

	if err := Add(Project{Name: "target", Path: "/target"}); err != nil {
		t.Fatalf("Add: %v", err)
	}

	p := Get("target")
	if p == nil {
		t.Fatal("Get returned nil for existing project")
	}
	if p.Name != "target" || p.Path != "/target" {
		t.Errorf("Get = %+v, want {target /target}", p)
	}
}

func TestGet_NotFound(t *testing.T) {
	setupTestConfig(t)

	p := Get("nonexistent")
	if p != nil {
		t.Errorf("Get for non-existent = %+v, want nil", p)
	}
}
