package dev

import (
	"os"
	"path/filepath"
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

func TestRoutesFilePath(t *testing.T) {
	tmp := setupTestConfig(t)

	got := RoutesFilePath("myws")
	want := filepath.Join(tmp, "dev-routes-myws.json")
	if got != want {
		t.Errorf("RoutesFilePath = %q, want %q", got, want)
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	setupTestConfig(t)

	routes := []Route{
		{Subdomain: "main", ExternalPort: 5173, InternalPort: 49001},
		{Subdomain: "feature", ExternalPort: 5173, InternalPort: 49002},
	}

	if err := SaveRoutes("test-ws", routes); err != nil {
		t.Fatalf("SaveRoutes: %v", err)
	}

	loaded, err := LoadRoutes("test-ws")
	if err != nil {
		t.Fatalf("LoadRoutes: %v", err)
	}
	if len(loaded) != 2 {
		t.Fatalf("LoadRoutes returned %d routes, want 2", len(loaded))
	}
	if loaded[0].Subdomain != "main" || loaded[0].ExternalPort != 5173 || loaded[0].InternalPort != 49001 {
		t.Errorf("loaded[0] = %+v, want {main 5173 49001}", loaded[0])
	}
	if loaded[1].Subdomain != "feature" || loaded[1].InternalPort != 49002 {
		t.Errorf("loaded[1] = %+v", loaded[1])
	}
}

func TestLoadRoutes_Missing(t *testing.T) {
	setupTestConfig(t)

	routes, err := LoadRoutes("nonexistent")
	if err != nil {
		t.Fatalf("LoadRoutes: %v", err)
	}
	if routes != nil {
		t.Errorf("LoadRoutes for missing = %v, want nil", routes)
	}
}

func TestSaveRoutes_Empty(t *testing.T) {
	setupTestConfig(t)

	// First create a routes file
	if err := SaveRoutes("empty-test", []Route{{Subdomain: "x", ExternalPort: 1, InternalPort: 2}}); err != nil {
		t.Fatalf("SaveRoutes setup: %v", err)
	}
	if _, err := os.Stat(RoutesFilePath("empty-test")); err != nil {
		t.Fatal("routes file should exist after save")
	}

	// Saving empty slice should delete the file
	if err := SaveRoutes("empty-test", []Route{}); err != nil {
		t.Fatalf("SaveRoutes empty: %v", err)
	}
	if _, err := os.Stat(RoutesFilePath("empty-test")); !os.IsNotExist(err) {
		t.Error("routes file should be deleted when saving empty routes")
	}
}

func TestRemoveRoutesFile(t *testing.T) {
	setupTestConfig(t)

	if err := SaveRoutes("rm-test", []Route{{Subdomain: "x", ExternalPort: 1, InternalPort: 2}}); err != nil {
		t.Fatalf("SaveRoutes: %v", err)
	}
	RemoveRoutesFile("rm-test")

	if _, err := os.Stat(RoutesFilePath("rm-test")); !os.IsNotExist(err) {
		t.Error("routes file should be gone after RemoveRoutesFile")
	}
}

func TestListAllRoutes(t *testing.T) {
	setupTestConfig(t)

	if err := SaveRoutes("ws-a", []Route{
		{Subdomain: "main", ExternalPort: 5173, InternalPort: 49001},
	}); err != nil {
		t.Fatalf("SaveRoutes ws-a: %v", err)
	}
	if err := SaveRoutes("ws-b", []Route{
		{Subdomain: "feat", ExternalPort: 3000, InternalPort: 49002},
		{Subdomain: "main", ExternalPort: 3000, InternalPort: 49003},
	}); err != nil {
		t.Fatalf("SaveRoutes ws-b: %v", err)
	}

	result, err := ListAllRoutes()
	if err != nil {
		t.Fatalf("ListAllRoutes: %v", err)
	}
	if len(result) != 2 {
		t.Fatalf("ListAllRoutes returned %d, want 2", len(result))
	}

	totalRoutes := 0
	for _, wr := range result {
		totalRoutes += len(wr.Routes)
	}
	if totalRoutes != 3 {
		t.Errorf("total routes = %d, want 3", totalRoutes)
	}
}

func TestListAllRoutes_Empty(t *testing.T) {
	setupTestConfig(t)

	result, err := ListAllRoutes()
	if err != nil {
		t.Fatalf("ListAllRoutes: %v", err)
	}
	if len(result) != 0 {
		t.Errorf("ListAllRoutes on empty = %d, want 0", len(result))
	}
}
