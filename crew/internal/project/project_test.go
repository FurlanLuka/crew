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

func TestAdd_Duplicate(t *testing.T) {
	setupTestConfig(t)

	if err := Add(Project{Name: "dup", Path: "/dup"}); err != nil {
		t.Fatalf("Add: %v", err)
	}
	err := Add(Project{Name: "dup", Path: "/other"})
	if err == nil {
		t.Fatal("Add should fail for duplicate project name")
	}
}

func TestUpdate(t *testing.T) {
	setupTestConfig(t)

	Add(Project{Name: "upd", Path: "/old"})
	if err := Update(Project{Name: "upd", Path: "/new"}); err != nil {
		t.Fatalf("Update: %v", err)
	}

	p := Get("upd")
	if p == nil {
		t.Fatal("project should exist after update")
	}
	if p.Path != "/new" {
		t.Errorf("Path = %q, want %q", p.Path, "/new")
	}
}

func TestUpdate_NotFound(t *testing.T) {
	setupTestConfig(t)

	err := Update(Project{Name: "ghost", Path: "/ghost"})
	if err == nil {
		t.Fatal("Update should fail for non-existent project")
	}
}

func TestAddDevServer(t *testing.T) {
	setupTestConfig(t)

	Add(Project{Name: "api", Path: "/api"})
	if err := AddDevServer("api", DevServer{Name: "web", Port: 3000, Command: "npm start"}); err != nil {
		t.Fatalf("AddDevServer: %v", err)
	}

	p := Get("api")
	if len(p.DevServers) != 1 {
		t.Fatalf("DevServers = %d, want 1", len(p.DevServers))
	}
	if p.DevServers[0].Name != "web" || p.DevServers[0].Port != 3000 {
		t.Errorf("DevServer = %+v, want {web 3000}", p.DevServers[0])
	}
}

func TestAddDevServer_ReplacesExisting(t *testing.T) {
	setupTestConfig(t)

	Add(Project{Name: "api", Path: "/api"})
	AddDevServer("api", DevServer{Name: "web", Port: 3000, Command: "npm start"})
	AddDevServer("api", DevServer{Name: "web", Port: 4000, Command: "npm run dev"})

	p := Get("api")
	if len(p.DevServers) != 1 {
		t.Fatalf("DevServers = %d, want 1 (should replace, not append)", len(p.DevServers))
	}
	if p.DevServers[0].Port != 4000 {
		t.Errorf("Port = %d, want 4000", p.DevServers[0].Port)
	}
}

func TestRemoveDevServer(t *testing.T) {
	setupTestConfig(t)

	Add(Project{Name: "api", Path: "/api"})
	AddDevServer("api", DevServer{Name: "web", Port: 3000, Command: "npm start"})
	AddDevServer("api", DevServer{Name: "api", Port: 8080, Command: "go run ."})

	if err := RemoveDevServer("api", "web"); err != nil {
		t.Fatalf("RemoveDevServer: %v", err)
	}

	p := Get("api")
	if len(p.DevServers) != 1 {
		t.Fatalf("DevServers = %d, want 1", len(p.DevServers))
	}
	if p.DevServers[0].Name != "api" {
		t.Errorf("remaining server = %q, want %q", p.DevServers[0].Name, "api")
	}
}
