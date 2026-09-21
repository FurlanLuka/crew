package transfer

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

func TestPlanRows(t *testing.T) {
	tmp := setupTestConfig(t)
	here := filepath.Join(tmp, "dev", "api")
	os.MkdirAll(here, 0o755)
	os.MkdirAll(filepath.Join(tmp, "dev", "web"), 0o755)
	project.Add(project.Project{Name: "api", Path: here})
	workspace.Create("old")

	b := Bundle{Projects: []Exported{
		{Project: project.Project{Name: "api", Path: here}},
		{Project: project.Project{Name: "web", Path: "/elsewhere/web"}, Remote: "git@x:web.git"}, // sibling beats clone
		{Project: project.Project{Name: "infra", Path: "/elsewhere/infra"}, Remote: "git@x:infra.git"},
		{Project: project.Project{Name: "gone", Path: "/elsewhere/gone"}},
		{Project: project.Project{Name: "local", Path: filepath.Join(tmp, "dev", "web")}},
	}, Workspaces: []Membership{
		{Name: "old"},
		{Name: "ready", Projects: []workspace.WorkspaceProject{{Name: "api"}}},
		{Name: "blocked", Projects: []workspace.WorkspaceProject{{Name: "api"}, {Name: "web"}, {Name: "gone"}}},
	}}

	got := PlanRows(b, Inspect(b))
	want := []PlanRow{
		{Kind: "project", Name: "api", Status: "exists", Detail: here},
		{Kind: "project", Name: "web", Status: "suggested", Detail: filepath.Join(tmp, "dev", "web")},
		{Kind: "project", Name: "infra", Status: "clone", Detail: filepath.Join(tmp, "dev", "infra")},
		{Kind: "project", Name: "gone", Status: "missing", Detail: "/elsewhere/gone"},
		{Kind: "project", Name: "local", Status: "path exists", Detail: filepath.Join(tmp, "dev", "web")},
		{Kind: "workspace", Name: "old", Status: "exists"},
		{Kind: "workspace", Name: "ready", Status: "ready"},
		{Kind: "workspace", Name: "blocked", Status: "needs", Detail: "web, gone"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("rows =\n%+v\nwant\n%+v", got, want)
	}
}

func TestApplyProject_PathDecisions(t *testing.T) {
	tmp := setupTestConfig(t)
	remote, _ := repoWithOrigin(t, tmp, "api")
	anchor := filepath.Join(tmp, "dev", "anchor")
	os.MkdirAll(anchor, 0o755)
	os.MkdirAll(filepath.Join(tmp, "dev", "web"), 0o755)
	project.Add(project.Project{Name: "anchor", Path: anchor})

	b := Bundle{Projects: []Exported{
		{Project: project.Project{Name: "api", Path: "/elsewhere/api", Setup: "npm ci"}, Remote: remote},
		{Project: project.Project{Name: "web", Path: "/elsewhere/web"}},
		{Project: project.Project{Name: "noremote", Path: "/elsewhere/noremote"}},
	}}
	plan := Inspect(b)

	// Not here, no flag: refused rather than guessed.
	if _, err := ApplyProject(b, plan, "noremote", ProjectOptions{}); err == nil {
		t.Error("missing path without --path/--clone must fail")
	}
	// A sibling beside a known repo is taken without being asked.
	res, err := ApplyProject(b, plan, "web", ProjectOptions{})
	if err != nil || res.Path != filepath.Join(tmp, "dev", "web") {
		t.Errorf("suggested: %+v, %v", res, err)
	}
	// --clone with no target lands beside the latest anchor; the record
	// carries the bundle's setup and a rename when asked.
	res, err = ApplyProject(b, plan, "api", ProjectOptions{Clone: true, Name: "api2", Setup: "make sync"})
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	if res.Path != filepath.Join(tmp, "dev", "api") || !res.Cloned || res.Name != "api2" {
		t.Errorf("clone result = %+v", res)
	}
	if _, err := os.Stat(filepath.Join(res.Path, ".git")); err != nil {
		t.Error("no checkout at the clone target")
	}
	if p := project.Get("api2"); p == nil || p.Setup != "make sync" {
		t.Errorf("record = %+v", p)
	}
	// Not in the bundle.
	if _, err := ApplyProject(b, plan, "nope", ProjectOptions{}); err == nil {
		t.Error("unknown project must fail")
	}
}

func TestApplyProject_PathFlag(t *testing.T) {
	tmp := setupTestConfig(t)
	anchor := filepath.Join(tmp, "dev", "anchor")
	given := filepath.Join(tmp, "picked", "web")
	os.MkdirAll(anchor, 0o755)
	os.MkdirAll(filepath.Join(tmp, "dev", "web"), 0o755)
	os.MkdirAll(given, 0o755)
	project.Add(project.Project{Name: "anchor", Path: anchor})
	b := Bundle{Projects: []Exported{{Project: project.Project{Name: "web", Path: "/elsewhere/web"}}}}
	plan := Inspect(b)

	// --path wins over the sibling Suggest found.
	res, err := ApplyProject(b, plan, "web", ProjectOptions{Path: given})
	if err != nil || res.Path != given || res.Cloned {
		t.Errorf("given path: %+v, %v", res, err)
	}
	project.Remove("web")
	// A --path that is not here is refused, not guessed around.
	_, err = ApplyProject(b, plan, "web", ProjectOptions{Path: filepath.Join(tmp, "nope")})
	if err == nil || !strings.Contains(err.Error(), "--path=<dir> or --clone") {
		t.Errorf("missing --path: %v", err)
	}
}

// --clone is a fallback, never a second copy: a path that exists or a
// sibling Suggest found is taken as is, and a refusal leaves nothing on disk.
func TestApplyProject_CloneIsFallbackOnly(t *testing.T) {
	tmp := setupTestConfig(t)
	remote, _ := repoWithOrigin(t, tmp, "api")
	anchor := filepath.Join(tmp, "dev", "anchor")
	sibling := filepath.Join(tmp, "dev", "web")
	local := filepath.Join(tmp, "dev", "local")
	for _, d := range []string{anchor, sibling, local} {
		os.MkdirAll(d, 0o755)
	}
	project.Add(project.Project{Name: "anchor", Path: anchor})
	b := Bundle{Projects: []Exported{
		{Project: project.Project{Name: "web", Path: "/elsewhere/web"}, Remote: remote},
		{Project: project.Project{Name: "local", Path: local}, Remote: remote},
		{Project: project.Project{Name: "noremote", Path: "/elsewhere/noremote"}},
	}}
	plan := Inspect(b)

	res, err := ApplyProject(b, plan, "web", ProjectOptions{Clone: true})
	if err != nil || res.Path != sibling || res.Cloned {
		t.Errorf("suggested under --clone: %+v, %v", res, err)
	}
	// --clone=<dir> is explicit: it clones there even with a sibling found.
	project.Remove("web")
	picked := filepath.Join(tmp, "picked", "web")
	res, err = ApplyProject(b, plan, "web", ProjectOptions{Clone: true, CloneTo: picked})
	if err != nil || res.Path != picked || !res.Cloned {
		t.Errorf("explicit --clone=<dir> with sibling: %+v, %v", res, err)
	}
	res, err = ApplyProject(b, plan, "local", ProjectOptions{Clone: true})
	if err != nil || res.Path != local || res.Cloned {
		t.Errorf("existing path under --clone: %+v, %v", res, err)
	}
	_, err = ApplyProject(b, plan, "noremote", ProjectOptions{Clone: true})
	if err == nil || !strings.Contains(err.Error(), "no remote") {
		t.Errorf("no remote: %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(tmp, "dev", "noremote")); statErr == nil {
		t.Error("a refused clone must leave nothing behind")
	}
}

// With no repo crew knows and the exported parent absent, --clone has
// nowhere to go and says so; nothing is created.
func TestApplyProject_CloneNowhere(t *testing.T) {
	tmp := setupTestConfig(t)
	remote, _ := repoWithOrigin(t, tmp, "api")
	b := Bundle{Projects: []Exported{{Project: project.Project{Name: "api", Path: "/nope/nowhere/api"}, Remote: remote}}}
	_, err := ApplyProject(b, Inspect(b), "api", ProjectOptions{Clone: true})
	if err == nil || !strings.Contains(err.Error(), "nowhere to clone") {
		t.Errorf("err = %v", err)
	}
	if _, statErr := os.Stat("/nope/nowhere/api"); statErr == nil {
		t.Error("nothing should have been created")
	}
}

func TestPlanRows_NoAnchors(t *testing.T) {
	tmp := setupTestConfig(t)
	os.MkdirAll(filepath.Join(tmp, "have"), 0o755)
	b := Bundle{Projects: []Exported{
		{Project: project.Project{Name: "api", Path: "/nope/nowhere/api"}, Remote: "git@x:api.git"},
		{Project: project.Project{Name: "web", Path: filepath.Join(tmp, "have", "web")}, Remote: "git@x:web.git"},
	}}
	got := PlanRows(b, Inspect(b))
	want := []PlanRow{
		{Kind: "project", Name: "api", Status: "missing", Detail: "/nope/nowhere/api"},
		{Kind: "project", Name: "web", Status: "clone", Detail: filepath.Join(tmp, "have", "web")},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("rows =\n%+v\nwant\n%+v", got, want)
	}
}

func TestApplyProject_ExplicitCloneAndReplace(t *testing.T) {
	tmp := setupTestConfig(t)
	remote, _ := repoWithOrigin(t, tmp, "api")
	project.Add(project.Project{Name: "api", Path: "/old/api"})
	b := Bundle{Projects: []Exported{
		{Project: project.Project{Name: "api", Path: "/elsewhere/api", DevServers: []project.DevServer{{Name: "api", Port: 3000}}}, Remote: remote},
	}}
	plan := Inspect(b)

	target := filepath.Join(tmp, "picked", "api")
	if _, err := ApplyProject(b, plan, "api", ProjectOptions{Clone: true, CloneTo: target}); err == nil {
		t.Fatal("existing name without --replace must fail before cloning")
	}
	if _, err := os.Stat(target); err == nil {
		t.Fatal("refusal must not have cloned")
	}
	res, err := ApplyProject(b, plan, "api", ProjectOptions{Clone: true, CloneTo: target, Replace: true})
	if err != nil {
		t.Fatalf("replace+clone: %v", err)
	}
	if res.Path != target || !res.Cloned {
		t.Errorf("result = %+v", res)
	}
	if p := project.Get("api"); p == nil || p.Path != target || len(p.DevServers) != 1 {
		t.Errorf("record after replace = %+v", p)
	}
}

func TestMembershipOf(t *testing.T) {
	tmp := setupTestConfig(t)
	api := filepath.Join(tmp, "repos", "api")
	initRepo(t, api)
	b := Bundle{
		Projects:   []Exported{{Project: project.Project{Name: "api", Path: api}}},
		Workspaces: []Membership{{Name: "ws", Projects: []workspace.WorkspaceProject{{Name: "api", Role: "api"}}}},
	}
	if _, err := MembershipOf(b, "ws"); err == nil {
		t.Fatal("members not in the pool yet must block")
	}
	if _, err := ApplyProject(b, Inspect(b), "api", ProjectOptions{}); err != nil {
		t.Fatal(err)
	}
	// The pool is re-read: the project imported a moment ago counts.
	m, err := MembershipOf(b, "ws")
	if err != nil {
		t.Fatalf("MembershipOf: %v", err)
	}
	if _, _, err := ImportWorkspace(m, workspace.CheckoutOptions{}); err != nil {
		t.Fatalf("ImportWorkspace: %v", err)
	}
	if !workspace.Exists("ws") {
		t.Error("workspace not created")
	}
	if _, err := MembershipOf(b, "nope"); err == nil {
		t.Error("unknown workspace must fail")
	}
}
