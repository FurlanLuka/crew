package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

func TestPoolRemovalAllowed(t *testing.T) {
	p := project.Project{Name: "api", Path: "/home/me/api"}
	if err := PoolRemovalAllowed(p, []string{"store", "admin"}, false); err == nil || !strings.Contains(err.Error(), "workspace store, admin — crew rm workspace store api; crew rm workspace admin api first") {
		t.Errorf("members: %v", err)
	}
	if err := PoolRemovalAllowed(p, nil, true); err == nil || !strings.Contains(err.Error(), "rm worktree check/api") {
		t.Errorf("kept check: %v", err)
	}
	// An adopted path is removable: the guard is about what references
	// the entry, not whose clone it is.
	if err := PoolRemovalAllowed(p, nil, false); err != nil {
		t.Errorf("clean: %v", err)
	}
}

// A crew-owned clone goes to the trash, is kept on request, and a path the
// user adopted is never moved.
func TestRemoveFromPool(t *testing.T) {
	tmp := setupTestConfig(t)
	owned := filepath.Join(config.ProjectsDir, "signals")
	os.MkdirAll(owned, 0o755)
	adopted := filepath.Join(tmp, "code", "checkout-api")
	os.MkdirAll(adopted, 0o755)
	project.Add(project.Project{Name: "signals", Path: owned})
	project.Add(project.Project{Name: "keep-me", Path: filepath.Join(config.ProjectsDir, "keep-me")})
	os.MkdirAll(filepath.Join(config.ProjectsDir, "keep-me"), 0o755)
	project.Add(project.Project{Name: "checkout-api", Path: adopted})

	r, err := RemoveFromPool("signals", TrashClone)
	if err != nil || r.Clone != CloneTrashed || r.Path != owned {
		t.Fatalf("trash: %+v, %v", r, err)
	}
	if project.Get("signals") != nil || !trashHolds(t, "signals") {
		t.Error("the entry should be gone and the clone in the trash")
	}
	if _, err := os.Stat(owned); !os.IsNotExist(err) {
		t.Error("the clone should have left its path")
	}

	r, err = RemoveFromPool("keep-me", KeepClone)
	if err != nil || r.Clone != CloneKept {
		t.Fatalf("keep: %+v, %v", r, err)
	}
	if _, err := os.Stat(filepath.Join(config.ProjectsDir, "keep-me")); err != nil {
		t.Error("--keep-clone should leave the clone")
	}

	r, err = RemoveFromPool("checkout-api", TrashClone)
	if err != nil || r.Clone != CloneUntouched {
		t.Fatalf("adopted: %+v, %v", r, err)
	}
	if _, err := os.Stat(adopted); err != nil {
		t.Error("an adopted path is never moved")
	}
	if _, err := RemoveFromPool("nope", TrashClone); err == nil {
		t.Error("an unknown project is an error")
	}
}

// A member of a workspace stays in the pool, clone and all.
func TestRemoveFromPool_RefusedKeepsEverything(t *testing.T) {
	setupTestConfig(t)
	owned := filepath.Join(config.ProjectsDir, "api")
	os.MkdirAll(owned, 0o755)
	project.Add(project.Project{Name: "api", Path: owned})
	Save(&Workspace{Name: "ws", Projects: []WorkspaceProject{{Name: "api"}}, Worktrees: []Worktree{{Name: "main"}}})

	_, err := RemoveFromPool("api", TrashClone)
	if err == nil || !strings.Contains(err.Error(), "crew rm workspace ws api") {
		t.Fatalf("err = %v", err)
	}
	if project.Get("api") == nil {
		t.Error("the entry should still be in the pool")
	}
	if _, err := os.Stat(owned); err != nil {
		t.Error("the clone should be untouched")
	}
}

// The trash cannot take the clone: the entry is gone anyway, the clone
// stays, and the removal says both.
func TestRemoveFromPool_TrashFailureKeepsTheClone(t *testing.T) {
	tmp := setupTestConfig(t)
	owned := filepath.Join(config.ProjectsDir, "signals")
	os.MkdirAll(owned, 0o755)
	project.Add(project.Project{Name: "signals", Path: owned})
	// A file where the trash directory should be: nothing can be moved in.
	config.TrashDir = filepath.Join(tmp, "trash-file")
	os.WriteFile(config.TrashDir, []byte("x"), 0o644)

	r, err := RemoveFromPool("signals", TrashClone)
	if err == nil || !strings.Contains(err.Error(), "clone left at "+owned) {
		t.Fatalf("err = %v", err)
	}
	if r.Path != owned || r.Clone != CloneKept {
		t.Errorf("removal = %+v, want the clone kept", r)
	}
	if project.Get("signals") != nil {
		t.Error("the entry is gone")
	}
	if _, err := os.Stat(owned); err != nil {
		t.Error("the clone is still there")
	}
}

func TestPoolRemovalLine(t *testing.T) {
	for _, tt := range []struct {
		r    PoolRemoval
		want string
	}{
		{PoolRemoval{Path: "/x/signals", Clone: CloneTrashed}, "clone at /x/signals moved to the trash"},
		{PoolRemoval{Path: "/x/signals", Clone: CloneKept}, "clone kept at /x/signals"},
		{PoolRemoval{Path: "/code/api", Clone: CloneUntouched}, "your checkout at /code/api is left alone"},
	} {
		if got := PoolRemovalLine(tt.r); got != tt.want {
			t.Errorf("PoolRemovalLine(%+v) = %q, want %q", tt.r, got, tt.want)
		}
	}
}
