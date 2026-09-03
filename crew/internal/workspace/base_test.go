package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// remoteAndClone makes a bare "origin" with a main branch and a clone of it
// registered as project name, so fetch and behind/ahead counts are real.
func remoteAndClone(t *testing.T, name string) (remote, clone string) {
	t.Helper()
	tmp := t.TempDir()
	seed := filepath.Join(tmp, "seed")
	os.MkdirAll(seed, 0o755)
	initRepo(t, seed)
	exec.RunGitCommand(seed, "branch", "-M", "main")

	remote = filepath.Join(tmp, "origin.git")
	if _, err := exec.RunGitCommand(tmp, "clone", "--bare", "-q", seed, remote); err != nil {
		t.Fatalf("bare clone: %v", err)
	}
	clone = filepath.Join(tmp, name)
	if _, err := exec.RunGitCommand(tmp, "clone", "-q", remote, clone); err != nil {
		t.Fatalf("clone: %v", err)
	}
	project.Add(project.Project{Name: name, Path: clone})
	return remote, clone
}

func commitOn(t *testing.T, repo, msg string) {
	t.Helper()
	if _, err := exec.RunGitCommand(repo, "commit", "-q", "--allow-empty", "-m", msg); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

func TestBaseStatuses_UpToDateAndBehind(t *testing.T) {
	setupTestConfig(t)
	remote, _ := remoteAndClone(t, "api")
	_, webClone := remoteAndClone(t, "web")

	// Move origin/main of api ahead via a second clone, so api's local main is behind.
	pusher := filepath.Join(t.TempDir(), "pusher")
	exec.RunGitCommand(filepath.Dir(pusher), "clone", "-q", remote, pusher)
	commitOn(t, pusher, "upstream change")
	commitOn(t, pusher, "another")
	if _, err := exec.RunGitCommand(pusher, "push", "-q", "origin", "main"); err != nil {
		t.Fatalf("push: %v", err)
	}

	// web's checkout sits on a feature branch; its main is current.
	exec.RunGitCommand(webClone, "checkout", "-q", "-b", "feature/x")

	statuses := BaseStatuses(&Workspace{Name: "ws", Projects: []WorkspaceProject{{Name: "api"}, {Name: "web"}}})
	if len(statuses) != 2 {
		t.Fatalf("got %d statuses", len(statuses))
	}

	api, web := statuses[0], statuses[1]
	if api.Base != "main" || api.Behind != 2 || api.Err != "" {
		t.Errorf("api = %+v, want main, 2 behind", api)
	}
	if web.Base != "main" || web.Behind != 0 || web.Current != "feature/x" {
		t.Errorf("web = %+v, want main up to date with the checkout on feature/x", web)
	}
	if !Stale(statuses) {
		t.Error("Stale should be true with api behind")
	}
}

func TestBaseStatuses_DirectAndMissing(t *testing.T) {
	setupTestConfig(t)
	_, clone := remoteAndClone(t, "api")
	_ = clone

	statuses := BaseStatuses(&Workspace{Name: "ws", Projects: []WorkspaceProject{
		{Name: "api", Mode: ModeDirect},
		{Name: "ghost"},
	}})

	if !strings.Contains(statuses[0].Base, "direct") || statuses[0].Behind != -1 {
		t.Errorf("direct = %+v, want a direct note and no fetch", statuses[0])
	}
	if statuses[1].Err != "not in project pool" {
		t.Errorf("ghost = %+v, want the pool error", statuses[1])
	}
}

func TestFormatBaseStatuses_Golden(t *testing.T) {
	got := FormatBaseStatuses([]BaseStatus{
		{Project: "speak-api", Base: "develop", Current: "feature/s4b-3071", Behind: 3, Ahead: 0},
		{Project: "ai-tutor-api", Base: "main", Current: "main", Behind: 0, Ahead: 1},
		{Project: "speak-app", Base: "develop", Current: "develop", Behind: 0},
		{Project: "gcp-infra", Base: "main", Current: "main", Behind: -1, Ahead: -1, Err: "fetch failed — remote state unknown"},
		{Project: "ghost", Behind: -1, Err: "not in project pool"},
	})

	want := strings.Join([]string{
		"  speak-api     develop     3 behind origin/develop   (checkout is on feature/s4b-3071)",
		"  ai-tutor-api  main        up to date, 1 ahead",
		"  speak-app     develop     up to date",
		"  gcp-infra     main        fetch failed — remote state unknown",
		"  ghost         not in project pool",
		"",
	}, "\n")
	if got != want {
		t.Errorf("FormatBaseStatuses =\n%s\nwant\n%s", got, want)
	}

	warn := StaleWarning([]BaseStatus{{Project: "speak-api", Behind: 3}, {Project: "web", Behind: 1}, {Project: "ok"}})
	if !strings.HasPrefix(warn, "! 2 of 3 projects behind origin") {
		t.Errorf("StaleWarning = %q", warn)
	}
	if StaleWarning([]BaseStatus{{Project: "ok"}}) != "" {
		t.Error("no warning when nothing is behind")
	}
	if one := StaleWarning([]BaseStatus{{Project: "api", Behind: 2}}); !strings.HasPrefix(one, "! api is behind") {
		t.Errorf("single-project warning = %q", one)
	}
}

// UpdateBase moves the local base ref without touching a feature branch the
// checkout sits on, and refuses when the base has local commits origin lacks.
func TestUpdateBase(t *testing.T) {
	setupTestConfig(t)
	remote, clone := remoteAndClone(t, "api")

	pusher := filepath.Join(t.TempDir(), "pusher")
	exec.RunGitCommand(filepath.Dir(pusher), "clone", "-q", remote, pusher)
	commitOn(t, pusher, "upstream")
	exec.RunGitCommand(pusher, "push", "-q", "origin", "main")

	t.Run("checkout on a feature branch: base ref moves, tree untouched", func(t *testing.T) {
		exec.RunGitCommand(clone, "checkout", "-q", "-b", "feature/x")
		if err := UpdateBase(*project.Get("api")); err != nil {
			t.Fatalf("UpdateBase: %v", err)
		}
		if st := baseStatus(*project.Get("api")); st.Behind != 0 {
			t.Errorf("still %d behind after update", st.Behind)
		}
		if cur := currentBranch(clone); cur != "feature/x" {
			t.Errorf("checkout moved to %q; must stay on the feature branch", cur)
		}
	})

	t.Run("base checked out and clean: fast-forwards", func(t *testing.T) {
		commitOn(t, pusher, "more upstream")
		exec.RunGitCommand(pusher, "push", "-q", "origin", "main")
		exec.RunGitCommand(clone, "checkout", "-q", "main")
		if err := UpdateBase(*project.Get("api")); err != nil {
			t.Fatalf("UpdateBase: %v", err)
		}
		if st := baseStatus(*project.Get("api")); st.Behind != 0 {
			t.Errorf("still %d behind", st.Behind)
		}
	})

	t.Run("base checked out and dirty: refuses", func(t *testing.T) {
		commitOn(t, pusher, "even more")
		exec.RunGitCommand(pusher, "push", "-q", "origin", "main")
		os.WriteFile(filepath.Join(clone, "dirty.txt"), []byte("x"), 0o644)
		err := UpdateBase(*project.Get("api"))
		if err == nil || !strings.Contains(err.Error(), "uncommitted") {
			t.Errorf("err = %v, want a refusal naming uncommitted changes", err)
		}
		os.Remove(filepath.Join(clone, "dirty.txt"))
	})

	t.Run("diverged base: refuses", func(t *testing.T) {
		exec.RunGitCommand(clone, "checkout", "-q", "-b", "feature/y")
		exec.RunGitCommand(clone, "checkout", "-q", "main")
		commitOn(t, clone, "local only")
		exec.RunGitCommand(clone, "checkout", "-q", "feature/y")
		commitOn(t, pusher, "upstream again")
		exec.RunGitCommand(pusher, "push", "-q", "origin", "main")

		err := UpdateBase(*project.Get("api"))
		if err == nil || !strings.Contains(err.Error(), "fast-forward") {
			t.Errorf("err = %v, want a fast-forward refusal", err)
		}
	})
}
