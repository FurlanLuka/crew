package transfer

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
	crewexec "github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/trash"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

func setupTestConfig(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	config.ConfigDir = tmp
	config.WorkspacesDir = filepath.Join(tmp, "workspaces")
	config.TrashDir = filepath.Join(tmp, "trash")
	config.ProjectsDir = filepath.Join(tmp, "projects")
	config.ClaudeConfigDir = filepath.Join(tmp, "claude")
	os.MkdirAll(config.WorkspacesDir, 0o755)
	trash.DisableSweepForTest(t)
	// Runners in-process, one after another: under go test the crew
	// binary is the test binary, and an import here wants its worktree
	// made when the call returns.
	prev := workspace.SpawnRunner
	workspace.SpawnRunner = func(ref workspace.Ref, job workspace.ProjectJob) error { return workspace.RunProjectSetup(ref, job) }
	t.Cleanup(func() { workspace.SpawnRunner = prev })
	return tmp
}

func initRepo(t *testing.T, dir string) {
	t.Helper()
	os.MkdirAll(dir, 0o755)
	for _, args := range [][]string{
		{"init", "-q", "-b", "main"},
		{"-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"},
	} {
		if _, err := crewexec.RunGitCommand(dir, args...); err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
	}
}

// repoWithOrigin makes a bare remote and a clone of it registered in the pool.
func repoWithOrigin(t *testing.T, tmp, name string) (remote, clone string) {
	t.Helper()
	remote = filepath.Join(tmp, "remotes", name+".git")
	seed := filepath.Join(tmp, "seed", name)
	initRepo(t, seed)
	os.MkdirAll(filepath.Dir(remote), 0o755)
	if _, err := crewexec.RunGitCommand(tmp, "clone", "-q", "--bare", seed, remote); err != nil {
		t.Fatal(err)
	}
	clone = filepath.Join(tmp, "repos", name)
	os.MkdirAll(filepath.Dir(clone), 0o755)
	if _, err := crewexec.RunGitCommand(tmp, "clone", "-q", remote, clone); err != nil {
		t.Fatal(err)
	}
	return remote, clone
}

func TestCollect_RecordsRemoteWhenThereIsOne(t *testing.T) {
	tmp := setupTestConfig(t)
	remote, clone := repoWithOrigin(t, tmp, "api")
	project.Add(project.Project{Name: "api", Path: clone, DevServers: []project.DevServer{{Name: "api", Port: 3000}}})
	local := filepath.Join(tmp, "repos", "local")
	initRepo(t, local)
	project.Add(project.Project{Name: "local", Path: local})
	workspace.Create("ws")
	workspace.AddProject("ws", "api", "backend", "", workspace.CheckoutOptions{})

	b, err := Collect([]string{"api", "local"}, []string{"ws"})
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Projects) != 2 || b.Projects[0].Remote != remote || b.Projects[1].Remote != "" {
		t.Errorf("projects = %+v", b.Projects)
	}
	if len(b.Workspaces) != 1 || b.Workspaces[0].Projects[0].Role != "backend" {
		t.Errorf("workspaces = %+v", b.Workspaces)
	}
}

func TestCovered(t *testing.T) {
	all := []*workspace.Workspace{
		{Name: "both", Projects: []workspace.WorkspaceProject{{Name: "a"}, {Name: "b", Mode: workspace.ModeDirect}}},
		{Name: "only-a", Projects: []workspace.WorkspaceProject{{Name: "a"}}},
	}
	got := Covered(all, map[string]bool{"a": true})
	if len(got) != 1 || got[0].Name != "only-a" {
		t.Errorf("Covered = %+v, want only-a", got)
	}
	if missing := Uncovered(all[0], map[string]bool{"a": true}); len(missing) != 1 || missing[0] != "b" {
		t.Errorf("Uncovered = %v", missing)
	}
}

func TestWriteRead(t *testing.T) {
	tmp := setupTestConfig(t)
	path := filepath.Join(tmp, "x.json")
	in := Bundle{Version: Version, Projects: []Exported{{Project: project.Project{Name: "a", Path: "/p", Bindings: []project.Binding{{Var: "X", Value: "{{b}}", Server: "web"}}}, Remote: "git@x:a.git"}},
		Workspaces: []Membership{{Name: "ws", Projects: []workspace.WorkspaceProject{{Name: "a", Role: "r"}}}}}
	if err := Write(path, in); err != nil {
		t.Fatal(err)
	}
	out, err := Read(path)
	if err != nil {
		t.Fatal(err)
	}
	if out.Projects[0].Remote != "git@x:a.git" || out.Workspaces[0].Projects[0].Role != "r" || out.Projects[0].Bindings[0].Server != "web" {
		t.Errorf("round trip keeps a binding's scope: %+v", out)
	}

	os.WriteFile(path, []byte(`{"version": 99}`), 0o644)
	if _, err := Read(path); err == nil || !strings.Contains(err.Error(), "version 99") {
		t.Errorf("future version: %v", err)
	}
	os.WriteFile(path, []byte(`{"name": "not a bundle"}`), 0o644)
	if _, err := Read(path); err == nil || !strings.Contains(err.Error(), "not a crew export") {
		t.Errorf("not a bundle: %v", err)
	}
}

func TestInspectAndSuggest(t *testing.T) {
	tmp := setupTestConfig(t)
	here := filepath.Join(tmp, "dev", "api")
	os.MkdirAll(here, 0o755)
	os.MkdirAll(filepath.Join(tmp, "dev", "web"), 0o755)
	project.Add(project.Project{Name: "api", Path: here})

	b := Bundle{Projects: []Exported{
		{Project: project.Project{Name: "api", Path: here}},
		{Project: project.Project{Name: "web", Path: "/elsewhere/web"}},
		{Project: project.Project{Name: "gone", Path: "/elsewhere/gone"}},
	}, Workspaces: []Membership{{Name: "ws"}}}
	workspace.Create("ws")

	plan := Inspect(b)
	if !plan.Projects[0].Exists || !plan.Projects[0].PathExists || plan.Projects[0].Local == nil {
		t.Errorf("api: %+v", plan.Projects[0])
	}
	if plan.Projects[1].PathExists || plan.Projects[1].Suggested != filepath.Join(tmp, "dev", "web") {
		t.Errorf("web: %+v", plan.Projects[1])
	}
	if plan.Projects[2].Suggested != "" {
		t.Errorf("gone should have no suggestion: %+v", plan.Projects[2])
	}
	if !plan.Workspaces[0].Exists {
		t.Error("ws exists locally")
	}

	// The latest anchor wins: an accepted import beside which the next one sits.
	os.MkdirAll(filepath.Join(tmp, "other", "web"), 0o755)
	if got := Suggest("/x/web", []string{here, filepath.Join(tmp, "other", "api")}); got != filepath.Join(tmp, "other", "web") {
		t.Errorf("Suggest = %q", got)
	}
}

func TestCloneTarget(t *testing.T) {
	tmp := setupTestConfig(t)
	if got := CloneTarget("/x/web", []string{"/a/api", filepath.Join(tmp, "dev", "api")}); got != filepath.Join(tmp, "dev", "web") {
		t.Errorf("anchored = %q", got)
	}
	if got := CloneTarget(filepath.Join(tmp, "web"), nil); got != filepath.Join(tmp, "web") {
		t.Errorf("parent exists = %q", got)
	}
	// Nowhere else: crew's own projects dir, never a refusal on a fresh machine.
	if got := CloneTarget("/nope/nowhere/web", nil); got != project.ClonePath("web") {
		t.Errorf("no anchor, no parent = %q", got)
	}
	os.MkdirAll(project.ClonePath("web"), 0o755)
	if got := CloneTarget("/nope/nowhere/web", nil); got != "" {
		t.Errorf("projects dir taken = %q", got)
	}
	os.RemoveAll(project.ClonePath("web"))
	// A sibling already beside the anchor is a suggestion, not a clone target.
	os.MkdirAll(filepath.Join(tmp, "dev", "web"), 0o755)
	if got := CloneTarget("/nope/nowhere/web", []string{filepath.Join(tmp, "dev", "api")}); got != project.ClonePath("web") {
		t.Errorf("beside exists, no parent = %q", got)
	}
	if got := CloneTarget(filepath.Join(tmp, "web"), []string{filepath.Join(tmp, "dev", "api")}); got != filepath.Join(tmp, "web") {
		t.Errorf("beside exists, parent exists = %q", got)
	}
	os.MkdirAll(filepath.Join(tmp, "web"), 0o755)
	if got := CloneTarget(filepath.Join(tmp, "web"), nil); got != project.ClonePath("web") {
		t.Errorf("exported exists → own dir = %q", got)
	}
}

func TestClone(t *testing.T) {
	tmp := setupTestConfig(t)
	remote, _ := repoWithOrigin(t, tmp, "api")
	target := filepath.Join(tmp, "new", "api")
	if err := Clone(remote, target); err != nil {
		t.Fatalf("Clone: %v", err)
	}
	if _, err := os.Stat(filepath.Join(target, ".git")); err != nil {
		t.Error("no checkout at target")
	}
	err := Clone(filepath.Join(tmp, "missing.git"), filepath.Join(tmp, "new", "x"))
	if err == nil || !strings.HasPrefix(err.Error(), "git clone: ") {
		t.Errorf("bad remote: %v", err)
	}
}

func TestMissingMembers(t *testing.T) {
	m := Membership{Projects: []workspace.WorkspaceProject{{Name: "here"}, {Name: "accepted"}, {Name: "skipped"}}}
	got := MissingMembers(m, map[string]bool{"here": true, "accepted": true})
	if len(got) != 1 || got[0] != "skipped" {
		t.Errorf("MissingMembers = %v", got)
	}
}

func TestReferencedBy(t *testing.T) {
	b := Bundle{Projects: []Exported{
		{Project: project.Project{Name: "web", Bindings: []project.Binding{{Var: "API_URL", Value: "{{api}}"}, {Var: "WS", Value: "ws://{{api.host}}/x"}}}},
		{Project: project.Project{Name: "worker", Bindings: []project.Binding{{Var: "API", Value: "{{api/main.port}}"}, {Var: "OTHER", Value: "{{apix}}"}}}},
	}}
	got := ReferencedBy(b, "api")
	want := []string{"web's API_URL", "web's WS", "worker's API"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("ReferencedBy = %v, want %v", got, want)
	}
}

func TestImportProject(t *testing.T) {
	setupTestConfig(t)
	p := project.Project{Name: "api", Path: "/p", DevServers: []project.DevServer{{Name: "api", Port: 3000}}}
	if err := ImportProject("api", p, false); err != nil {
		t.Fatal(err)
	}
	if err := ImportProject("api", p, false); err == nil {
		t.Error("duplicate without replace should fail")
	}
	renamed := p
	renamed.Name, renamed.DevServers = "api2", []project.DevServer{{Name: "api", Port: 4000}}
	if err := ImportProject("api", renamed, true); err != nil {
		t.Fatal(err)
	}
	if project.Get("api") != nil || project.Get("api2") == nil || project.Get("api2").DevServers[0].Port != 4000 {
		t.Error("replace should swap the original record for the renamed one")
	}
	if err := ImportProject("x", project.Project{Name: "Bad.Name", Path: "/p"}, false); err == nil {
		t.Error("invalid name must be refused")
	}
}

// An import makes the main worktree the way crew add worktree does: what
// fails is recorded on it, the workspace stands, and a member that is not
// in the pool fails the whole thing before anything is made.
func TestImportWorkspace(t *testing.T) {
	tmp := setupTestConfig(t)
	api := filepath.Join(tmp, "repos", "api")
	initRepo(t, api)
	project.Add(project.Project{Name: "api", Path: api})
	project.SetSetup("api", "exit 7")

	ghost := Membership{Name: "ws", Projects: []workspace.WorkspaceProject{{Name: "api", Role: "backend"}, {Name: "ghost", Role: "x"}}}
	if _, _, err := ImportWorkspace(ghost, workspace.CheckoutOptions{}); err == nil || !strings.Contains(err.Error(), "ghost") {
		t.Fatalf("err = %v, want ghost to fail pre-flight", err)
	}
	if workspace.Exists("ws") {
		t.Fatal("a pre-flight failure must leave no workspace behind")
	}

	m := Membership{Name: "ws", Projects: []workspace.WorkspaceProject{{Name: "api", Role: "backend"}}}
	ref, started, err := ImportWorkspace(m, workspace.CheckoutOptions{Install: true})
	if err != nil {
		t.Fatal(err)
	}
	if !started || ref != (workspace.Ref{Workspace: "ws", Worktree: workspace.DefaultWorktree}) {
		t.Fatalf("started=%v ref=%v", started, ref)
	}
	if _, err := os.Stat(filepath.Join(workspace.WorktreePath(ref, "api"), ".git")); err != nil {
		t.Error("api checkout should exist")
	}
	st, _ := workspace.SetupStatus(ref)
	if len(st.Projects) != 1 || st.Projects[0].State != workspace.StateFailed {
		t.Errorf("status = %+v", st.Projects)
	}
	res, _ := workspace.Resolve(ref)
	if res.Health == nil || res.Health.Summary() != "install failed: api" {
		t.Errorf("health = %+v", res.Health)
	}
	if _, _, err := ImportWorkspace(m, workspace.CheckoutOptions{}); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("existing workspace must be refused: %v", err)
	}
}

func TestMembershipWorkspace_BaseStatuses(t *testing.T) {
	tmp := setupTestConfig(t)
	_, clone := repoWithOrigin(t, tmp, "api")
	project.Add(project.Project{Name: "api", Path: clone})
	m := Membership{Name: "ws", Projects: []workspace.WorkspaceProject{{Name: "api"}, {Name: "ghost"}}}
	st := workspace.BaseStatuses(m.Workspace())
	if len(st) != 2 || st[0].Project != "api" || st[0].Err != "" || st[1].Err == "" {
		t.Errorf("statuses = %+v", st)
	}
}

// An export can carry an empty workspace; it imports as one.
func TestImportWorkspace_Empty(t *testing.T) {
	setupTestConfig(t)
	_, started, err := ImportWorkspace(Membership{Name: "empty"}, workspace.CheckoutOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if started {
		t.Error("nothing to run on an empty workspace")
	}
	if !workspace.Exists("empty") {
		t.Error("the empty workspace should exist")
	}
}

func TestWorkspaceRow(t *testing.T) {
	row, failed := WorkspaceRow("ws", false, nil, false, nil)
	if failed || row.Status != "created" || row.Detail != "" {
		t.Errorf("empty create → %+v %v", row, failed)
	}
	row, failed = WorkspaceRow("ws", true, nil, false, nil)
	if failed || row.Status != "created" || row.Detail != "installing — crew setup status ws/main" {
		t.Errorf("started, not waited → %+v %v", row, failed)
	}
	row, failed = WorkspaceRow("ws", true, nil, true, nil)
	if failed || row.Status != "created" || row.Detail != "" {
		t.Errorf("waited, clean → %+v %v", row, failed)
	}
	h := &workspace.Health{Issues: []workspace.Issue{{Stage: workspace.StageInstall, Project: "api"}, {Stage: workspace.StageSmoke, Project: "api", Server: "api"}}}
	row, failed = WorkspaceRow("ws", true, h, true, nil)
	if !failed || row.Status != "created" || row.Detail != "2 issue(s) recorded — crew fix ws/main --print / crew verify ws/main" {
		t.Errorf("waited, issues → %+v %v", row, failed)
	}
	row, failed = WorkspaceRow("ws", false, nil, false, errors.New("workspace 'ws' already exists"))
	if !failed || row.Status != "failed" || row.Detail != "workspace 'ws' already exists" {
		t.Errorf("error → %+v %v", row, failed)
	}
}

func TestMissingPaths(t *testing.T) {
	tmp := setupTestConfig(t)
	here := filepath.Join(tmp, "here")
	os.MkdirAll(here, 0o755)
	project.Add(project.Project{Name: "known", Path: "/gone/known"})
	b := Bundle{Projects: []Exported{
		{Project: project.Project{Name: "known", Path: "/gone/known"}}, // kept local: never blocks --all
		{Project: project.Project{Name: "present", Path: here}},
		{Project: project.Project{Name: "absent", Path: "/gone/absent"}},
	}}
	got := MissingPaths(b, Inspect(b))
	if len(got) != 1 || got[0].Name != "absent" {
		t.Errorf("MissingPaths = %+v, want just absent", got)
	}
}
