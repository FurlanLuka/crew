package workspace

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// Two bindings-bearing projects across two worktrees, with an override on the
// second. Real repos so StartDev's direct-mode check and dev.Start can run.
func bindingWorkspace(t *testing.T) {
	t.Helper()
	newRepoWorkspace(t, "ws", "api", "tutor")

	project.AddDevServer("api", project.DevServer{Name: "api", Port: 3000, Command: "sleep 30"})
	project.AddBinding("tutor", project.Binding{Var: "API_URL", Value: "{{url:api}}"})
	project.AddBinding("tutor", project.Binding{Var: "AGENT", Value: "{{worktree}}"})

	if err := AddWorktree("ws", "wrk2"); err != nil {
		t.Fatalf("AddWorktree: %v", err)
	}
	if err := SetOverride(Ref{Workspace: "ws", Worktree: "wrk2"}, "API_URL", "https://deployed"); err != nil {
		t.Fatalf("SetOverride: %v", err)
	}
}

func devResult(t *testing.T, r dev.StartResult, name string) dev.Resolution {
	t.Helper()
	for _, res := range r.Resolutions {
		if res.Var == name {
			return res
		}
	}
	t.Fatalf("no resolution for %s in %+v", name, r.Resolutions)
	return dev.Resolution{}
}

// The seam that let bindings vanish once: everything Resolved knows has to
// reach dev.StartParams — projects with their bindings, the identity tokens,
// and the overrides.
func TestStartDev_PassesOverridesAndIdentityThrough(t *testing.T) {
	if !exec.HasTmux() {
		t.Skip("tmux not available")
	}
	bindingWorkspace(t)
	t.Cleanup(func() {
		dev.StopAll("ws--main")
		dev.StopAll("ws--wrk2")
	})

	res, err := Resolve(Ref{Workspace: "ws", Worktree: "wrk2"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	result, err := StartDev(res, true, false)
	if err != nil {
		t.Fatalf("StartDev: %v", err)
	}

	if got := devResult(t, result, "API_URL"); got.Source != dev.SourceOverride || got.Value != "https://deployed" {
		t.Errorf("API_URL = %+v, want the wrk2 override", got)
	}
	if got := devResult(t, result, "AGENT"); got.Value != "wrk2" {
		t.Errorf("AGENT = %q, want the selected worktree — this is the LiveKit agent-name collision", got.Value)
	}
}

func TestStartDev_ResolvesAgainstTheSelectedWorktree(t *testing.T) {
	if !exec.HasTmux() {
		t.Skip("tmux not available")
	}
	bindingWorkspace(t)
	t.Cleanup(func() {
		dev.StopAll("ws--main")
		dev.StopAll("ws--wrk2")
	})

	res, err := Resolve(Ref{Workspace: "ws", Worktree: DefaultWorktree})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	result, err := StartDev(res, true, false)
	if err != nil {
		t.Fatalf("StartDev: %v", err)
	}

	// main has no override, so the binding resolves to api's port.
	if got := devResult(t, result, "API_URL"); got.Source != dev.SourceBinding || got.Value != "http://localhost:3000" {
		t.Errorf("API_URL = %+v, want the binding resolved on main", got)
	}
	if got := devResult(t, result, "AGENT"); got.Value != DefaultWorktree {
		t.Errorf("AGENT = %q, want %s", got.Value, DefaultWorktree)
	}
}

// crew run / crew env resolve against the route file; with nothing running
// every reference binding is left alone, and the identity tokens still work.
func TestResolveEnv_NothingRunning(t *testing.T) {
	bindingWorkspace(t)

	res, err := Resolve(Ref{Workspace: "ws", Worktree: DefaultWorktree})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	by := dev.GroupResolutions(res.ResolveEnv())["tutor"]

	var apiURL, agent dev.Resolution
	for _, r := range by {
		switch r.Var {
		case "API_URL":
			apiURL = r
		case "AGENT":
			agent = r
		}
	}
	if apiURL.Source != dev.SourceUnresolved {
		t.Errorf("API_URL = %+v, want left alone with no servers running", apiURL)
	}
	if agent.Value != DefaultWorktree {
		t.Errorf("AGENT = %+v, want the worktree name regardless of servers", agent)
	}
}

// AddProject has to check the new project out into every worktree.
func TestAddProject_FansOutToEveryWorktree(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	AddWorktree("ws", "wrk2")
	AddWorktree("ws", "wrk3")

	repo := filepath.Join(t.TempDir(), "web")
	os.MkdirAll(repo, 0o755)
	initRepo(t, repo)
	project.Add(project.Project{Name: "web", Path: repo})

	if err := AddProject("ws", "web", "frontend", ""); err != nil {
		t.Fatalf("AddProject: %v", err)
	}

	seen := map[string]bool{}
	for _, wt := range []string{DefaultWorktree, "wrk2", "wrk3"} {
		ref := Ref{Workspace: "ws", Worktree: wt}
		path := WorktreePath(ref, "web")
		if _, err := os.Stat(path); err != nil {
			t.Errorf("%s has no checkout of web: %v", ref, err)
			continue
		}
		branch, _ := exec.RunGitCommand(path, "rev-parse", "--abbrev-ref", "HEAD")
		if seen[branch] {
			t.Errorf("branch %q checked out twice", branch)
		}
		seen[branch] = true
	}
}

// Remove has to tear down every worktree's artifacts, not one flat set.
func TestRemove_TearsDownEveryWorktreesArtifacts(t *testing.T) {
	newRepoWorkspace(t, "ws", "api")
	AddWorktree("ws", "wrk2")

	var paths []string
	for _, wt := range []string{DefaultWorktree, "wrk2"} {
		ref := Ref{Workspace: "ws", Worktree: wt}
		os.WriteFile(PromptFilePath(ref), []byte("p"), 0o644)
		os.WriteFile(CodeWorkspaceFilePath(ref), []byte("{}"), 0o644)
		os.MkdirAll(dev.LogDir(ref.Slug()), 0o755)
		paths = append(paths, PromptFilePath(ref), CodeWorkspaceFilePath(ref), dev.LogDir(ref.Slug()), WorktreeDir(ref))
	}

	if err := Remove("ws"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	for _, path := range paths {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("%s survived Remove", path)
		}
	}
}
