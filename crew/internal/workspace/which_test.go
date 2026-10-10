package workspace

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

func TestRefForPath(t *testing.T) {
	wrk1 := Ref{Workspace: "store", Worktree: "wrk1"}
	wrk10 := Ref{Workspace: "store", Worktree: "wrk10"}
	owners := []PathOwner{
		{Ref: wrk1, Dir: "/w/store/wrk1"},
		{Ref: wrk1, Project: "store-api", Dir: "/w/store/wrk1/store-api"},
		{Ref: wrk10, Dir: "/w/store/wrk10"},
		{Ref: wrk10, Project: "infra-ops", Dir: "/repos/infra-ops"},
	}
	cases := []struct {
		path    string
		want    Ref
		project string
		ok      bool
	}{
		{"/w/store/wrk1", wrk1, "", true},
		{"/w/store/wrk1/.claude", wrk1, "", true},
		{"/w/store/wrk1/store-api", wrk1, "store-api", true},
		{"/w/store/wrk1/store-api/src/deep", wrk1, "store-api", true},
		{"/w/store/wrk10/store-api", wrk10, "", true},
		{"/repos/infra-ops/terraform", wrk10, "infra-ops", true},
		{"/repos/infra-ops-old", Ref{}, "", false},
		{"/w/store", Ref{}, "", false},
		{"/elsewhere", Ref{}, "", false},
	}
	for _, c := range cases {
		got, ok := RefForPath(c.path, owners)
		if ok != c.ok || got.Ref != c.want || got.Project != c.project {
			t.Errorf("%s = %+v %v, want %v/%q %v", c.path, got, ok, c.want, c.project, c.ok)
		}
	}
}

// One read answers for worktree checkouts, a direct project's own path, a
// check, and a pre-2.0 flat workspace — and a canonical clone of a
// worktree-mode project belongs to no worktree.
func TestWhichPath(t *testing.T) {
	setupTestConfig(t)
	direct := filepath.Join(t.TempDir(), "infra-ops")
	clone := filepath.Join(t.TempDir(), "store-api")
	os.MkdirAll(direct, 0o755)
	os.MkdirAll(clone, 0o755)
	project.Add(project.Project{Name: "store-api", Path: clone})
	project.Add(project.Project{Name: "infra-ops", Path: direct})

	if err := Save(&Workspace{
		Name:      "store",
		Projects:  []WorkspaceProject{{Name: "store-api"}, {Name: "infra-ops", Mode: ModeDirect}},
		Worktrees: []Worktree{{Name: "main"}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := Save(&Workspace{Name: "legacy", Projects: []WorkspaceProject{{Name: "store-api"}}}); err != nil {
		t.Fatal(err)
	}
	if err := saveCheck(&Check{Project: "admin", At: time.Now()}); err != nil {
		t.Fatal(err)
	}

	main := Ref{Workspace: "store", Worktree: "main"}
	checkout := filepath.Join(WorktreeDir(main), "store-api", "src")
	os.MkdirAll(checkout, 0o755)

	cases := []struct {
		path    string
		ref     Ref
		project string
		ok      bool
	}{
		{checkout, main, "store-api", true},
		{WorktreeDir(main) + "/", main, "", true},
		{filepath.Join(direct, "modules"), main, "infra-ops", true},
		{clone, Ref{}, "", false},
		{filepath.Join(config.WorkspacesDir, "legacy", "store-api"), Ref{Workspace: "legacy"}, "store-api", true},
		{filepath.Join(config.WorkspacesDir, "check", "admin", "admin"), CheckRef("admin"), "admin", true},
	}
	for _, c := range cases {
		got, ok, err := WhichPath(c.path)
		if err != nil || ok != c.ok || got.Ref != c.ref || got.Project != c.project {
			t.Errorf("%s = %+v %v %v, want %v/%q %v", c.path, got, ok, err, c.ref, c.project, c.ok)
		}
	}
}

// t.TempDir() on macOS sits under /var, a symlink to /private/var: a
// session's cwd can come either way and must still match.
func TestWhichPath_ThroughASymlink(t *testing.T) {
	setupTestConfig(t)
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(config.WorkspacesDir, link); err != nil {
		t.Skip(err)
	}
	Save(&Workspace{Name: "store", Projects: []WorkspaceProject{{Name: "store-api"}}, Worktrees: []Worktree{{Name: "main"}}})
	os.MkdirAll(filepath.Join(config.WorkspacesDir, "store", "main", "store-api"), 0o755)

	got, ok, err := WhichPath(filepath.Join(link, "store", "main", "store-api"))
	if err != nil || !ok || got.Ref != (Ref{Workspace: "store", Worktree: "main"}) || got.Project != "store-api" {
		t.Errorf("through a symlink = %+v %v %v", got, ok, err)
	}
}
