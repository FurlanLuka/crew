package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

func TestCreateWith(t *testing.T) {
	tmp := setupTestConfig(t)
	for _, name := range []string{"api", "web"} {
		repo := filepath.Join(tmp, "repos", name)
		os.MkdirAll(repo, 0o755)
		initRepo(t, repo)
		project.Add(project.Project{Name: name, Path: repo})
	}

	ref, started, err := CreateWith("ws", []ProjectSpec{{Name: "api"}, {Name: "web", Mode: ModeDirect}}, CheckoutOptions{})
	if err != nil || !started || ref != (Ref{Workspace: "ws", Worktree: DefaultWorktree}) {
		t.Fatalf("CreateWith = %v, %v, %v", ref, started, err)
	}
	ws, _ := Load("ws")
	if len(ws.Projects) != 2 || IsDirect(ws.Projects[0]) || !IsDirect(ws.Projects[1]) {
		t.Errorf("members = %+v", ws.Projects)
	}
	if _, err := os.Stat(WorktreePath(ref, "api")); err != nil {
		t.Error("api should be checked out")
	}

	// The name is taken now.
	if _, _, err := CreateWith("ws", nil, CheckoutOptions{}); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("exists: %v", err)
	}
	// An empty member list makes the workspace and starts nothing.
	if _, started, err := CreateWith("empty", nil, CheckoutOptions{}); err != nil || started {
		t.Errorf("empty: %v, %v", started, err)
	}
}

// A spec that fails pre-flight leaves nothing behind: the name is free to
// try again.
func TestCreateWith_PreflightFailureTakesTheWorkspaceBack(t *testing.T) {
	setupTestConfig(t)
	_, _, err := CreateWith("ws", []ProjectSpec{{Name: "ghost"}}, CheckoutOptions{})
	if err == nil || !strings.Contains(err.Error(), "not found in pool") {
		t.Fatalf("err = %v", err)
	}
	if Exists("ws") {
		t.Error("the empty workspace should have been taken back")
	}
	if _, err := os.Stat(WorkspaceDir("ws")); !os.IsNotExist(err) {
		t.Error("its directory too")
	}
	if _, err := os.Stat(config.WorkspaceFile("ws")); !os.IsNotExist(err) {
		t.Error("and its file")
	}
}

func TestNameAvailable(t *testing.T) {
	setupTestConfig(t)
	Create("taken")
	for name, want := range map[string]string{
		"Bad Name": "invalid",
		"check":    "reserved",
		"taken":    "already exists",
		"free":     "",
	} {
		err := NameAvailable(name)
		switch {
		case want == "" && err != nil:
			t.Errorf("%s: %v", name, err)
		case want != "" && (err == nil || !strings.Contains(err.Error(), want)):
			t.Errorf("%s: %v, want %q", name, err, want)
		}
	}
}
