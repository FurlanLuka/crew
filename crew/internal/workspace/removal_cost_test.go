package workspace

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// A dry run counts what a removal would take and removes nothing: the
// uncommitted files, the commits only the crew branch has, the size.
func TestRemovalCost(t *testing.T) {
	newRepoWorkspace(t, "ws", "api", "web")
	ref := Ref{Workspace: "ws", Worktree: DefaultWorktree}
	dir := WorktreePath(ref, "api")
	os.WriteFile(filepath.Join(dir, "draft.txt"), []byte("wip"), 0o644)
	os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("wip"), 0o644)
	if _, err := exec.RunGitCommand(dir, "-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "on the branch"); err != nil {
		t.Fatal(err)
	}
	os.RemoveAll(WorktreePath(ref, "web"))
	// A direct member: the canonical checkout, which a removal never takes.
	signals := filepath.Join(config.ConfigDir, "repos", "signals")
	os.MkdirAll(signals, 0o755)
	initRepo(t, signals)
	os.WriteFile(filepath.Join(signals, "local.txt"), []byte("mine"), 0o644)
	project.Add(project.Project{Name: "signals", Path: signals})
	if err := addProject("ws", "signals", ModeDirect, CheckoutOptions{}); err != nil {
		t.Fatal(err)
	}

	cost, err := WorktreeRemovalCost(ref)
	if err != nil {
		t.Fatal(err)
	}
	if !cost.Last || len(cost.Checkouts) != 3 {
		t.Fatalf("cost = %+v", cost)
	}
	api, web, direct := cost.Checkouts[0], cost.Checkouts[1], cost.Checkouts[2]
	if !direct.Direct || direct.Path != signals || direct.SizeBytes != 0 || direct.Uncommitted != 0 || direct.Commits != 0 || direct.Missing {
		t.Errorf("direct = %+v", direct)
	}
	if _, err := os.Stat(filepath.Join(signals, "local.txt")); err != nil {
		t.Error("a dry run touched the direct checkout")
	}
	if entries, _ := os.ReadDir(config.TrashDir); len(entries) != 0 {
		t.Errorf("a dry run trashed %d entries", len(entries))
	}
	if api.Ref != "ws/main" || api.Project != "api" || api.Uncommitted != 2 || api.Commits != 1 || api.SizeBytes == 0 || api.Missing {
		t.Errorf("api = %+v", api)
	}
	if !web.Missing || web.Uncommitted != 0 {
		t.Errorf("web = %+v", web)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Error("a dry run removed the checkout")
	}

	byProject, err := ProjectRemovalCost("ws", "api")
	if err != nil || len(byProject.Checkouts) != 1 || byProject.Checkouts[0].Uncommitted != 2 || byProject.Last {
		t.Errorf("project cost = %+v, %v", byProject, err)
	}
	if _, err := ProjectRemovalCost("ws", "nope"); err == nil {
		t.Error("a project not in the workspace has no cost to show")
	}
}

func TestCountLines(t *testing.T) {
	if got := countLines(" M a.go\n?? b.go\n\n"); got != 2 {
		t.Errorf("countLines = %d", got)
	}
	if got := countLines(""); got != 0 {
		t.Errorf("empty = %d", got)
	}
}
