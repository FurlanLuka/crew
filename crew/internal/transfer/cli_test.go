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

// The import decision, rule by rule, with no disk in sight.
func TestDecide(t *testing.T) {
	local := &project.Project{Name: "api", Path: "/local/api"}
	here := ProjectStatus{Exists: true, Local: local, LocalRemote: "git@x:api.git"}
	noOrigin := ProjectStatus{Exists: true, Local: local}
	other := ProjectStatus{Exists: true, Local: local, LocalRemote: "git@y:api.git"}
	away := ProjectStatus{}
	for _, tt := range []struct {
		name    string
		project string
		remote  string
		st      ProjectStatus
		o       ProjectOptions
		want    decision
		wantErr string
	}{
		{"not here → clone", "api", "git@x:api.git", away, ProjectOptions{}, decision{actionClone, project.ClonePath("api"), false}, ""},
		{"not here, no remote → refuse", "api", "", away, ProjectOptions{}, decision{}, "no git remote — --path=<dir>"},
		{"not here, no remote, path → adopt", "api", "", away, ProjectOptions{Path: "/x"}, decision{actionAdopt, "/x", false}, ""},
		{"a given path beats the clone", "api", "git@x:api.git", away, ProjectOptions{Path: "/x"}, decision{actionAdopt, "/x", false}, ""},
		{"here, same remote → keep", "api", "git@x:api.git", here, ProjectOptions{}, decision{actionKeep, "", false}, ""},
		{"here, same remote, replace → record on the local path", "api", "https://x/api", here, ProjectOptions{Replace: true}, decision{actionRecord, "/local/api", true}, ""},
		{"here, nothing to compare, replace → record (config-only export)", "api", "", noOrigin, ProjectOptions{Replace: true}, decision{actionRecord, "/local/api", true}, ""},
		{"here, other remote → keep", "api", "git@x:api.git", other, ProjectOptions{}, decision{actionKeep, "", false}, ""},
		{"here, other remote, replace → clone", "api", "git@x:api.git", other, ProjectOptions{Replace: true}, decision{actionClone, project.ClonePath("api"), true}, ""},
		{"here, replace with a path → adopt", "api", "git@x:api.git", other, ProjectOptions{Replace: true, Path: "/x"}, decision{actionAdopt, "/x", true}, ""},
		{"here, path without replace → keep", "api", "git@x:api.git", here, ProjectOptions{Path: "/x"}, decision{actionKeep, "", false}, ""},
		{"the clone follows the imported name", "api2", "git@x:api.git", away, ProjectOptions{Name: "api2"}, decision{actionClone, project.ClonePath("api2"), false}, ""},
	} {
		got, err := decide(tt.project, tt.remote, tt.st, tt.o)
		if tt.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("%s: err = %v, want %q", tt.name, err, tt.wantErr)
			}
			continue
		}
		if err != nil || got != tt.want {
			t.Errorf("%s: got %+v, %v; want %+v", tt.name, got, err, tt.want)
		}
	}
}

// classify is the one reading of a project's situation — the plan row,
// the card and the decision all come from it.
func TestClassify(t *testing.T) {
	local := &project.Project{Name: "x", Path: "/x"}
	for _, tt := range []struct {
		name   string
		st     ProjectStatus
		remote string
		want   situation
	}{
		{"here same", ProjectStatus{Exists: true, Local: local, LocalRemote: "git@x:r.git"}, "https://x/r", sitHere},
		{"here, nothing to compare", ProjectStatus{Exists: true, Local: local}, "", sitHere},
		{"here other", ProjectStatus{Exists: true, Local: local, LocalRemote: "git@y:r.git"}, "git@x:r.git", sitOtherRemote},
		{"here, local without origin", ProjectStatus{Exists: true, Local: local}, "git@x:r.git", sitOtherRemote},
		{"clone", ProjectStatus{}, "git@x:r.git", sitClone},
		{"blocked", ProjectStatus{CloneDirTaken: true}, "git@x:r.git", sitBlocked},
		{"no remote", ProjectStatus{}, "", sitNoRemote},
	} {
		if got := classify(tt.st, tt.remote); got != tt.want {
			t.Errorf("%s: %v, want %v", tt.name, got, tt.want)
		}
	}
}

func TestPlanRows(t *testing.T) {
	tmp := setupTestConfig(t)
	remote, clone := repoWithOrigin(t, tmp, "api")
	project.Add(project.Project{Name: "api", Path: clone})
	plain := filepath.Join(tmp, "repos", "plain")
	initRepo(t, plain)
	project.Add(project.Project{Name: "plain", Path: plain})
	os.MkdirAll(project.ClonePath("taken"), 0o755)
	workspace.Create("old")

	notes := filepath.Join(tmp, "repos", "notes")
	initRepo(t, notes)
	project.Add(project.Project{Name: "notes", Path: notes})
	os.WriteFile(project.ClonePath("filed"), []byte("x"), 0o644)
	b := Bundle{Projects: []Exported{
		{Project: project.Project{Name: "api"}, Remote: "file://" + remote},
		{Project: project.Project{Name: "plain"}, Remote: "git@x:plain.git"},
		{Project: project.Project{Name: "notes"}}, // config-only export of a project here without origin
		{Project: project.Project{Name: "web"}, Remote: "git@x:web.git"},
		{Project: project.Project{Name: "taken"}, Remote: "git@x:taken.git"},
		{Project: project.Project{Name: "filed"}, Remote: "git@x:filed.git"}, // a file, not a dir, still blocks
		{Project: project.Project{Name: "gone"}},
	}, Workspaces: []Membership{
		{Name: "old"},
		{Name: "ready", Projects: []workspace.WorkspaceProject{{Name: "api"}}},
		{Name: "blocked", Projects: []workspace.WorkspaceProject{{Name: "api"}, {Name: "web"}, {Name: "gone"}}},
	}}

	got := PlanRows(b, Inspect(b))
	want := []PlanRow{
		{Kind: "project", Name: "api", Status: "exists", Detail: clone},
		{Kind: "project", Name: "plain", Status: "other remote", Detail: "local no remote"},
		{Kind: "project", Name: "notes", Status: "exists", Detail: notes},
		{Kind: "project", Name: "web", Status: "clone", Detail: project.ClonePath("web")},
		{Kind: "project", Name: "taken", Status: "blocked", Detail: project.ClonePath("taken") + " exists — --path=" + project.ClonePath("taken") + " adopts it, or delete it"},
		{Kind: "project", Name: "filed", Status: "blocked", Detail: project.ClonePath("filed") + " exists and is not a directory — delete it first"},
		{Kind: "project", Name: "gone", Status: "missing", Detail: "no git remote — --path=<dir>"},
		{Kind: "workspace", Name: "old", Status: "exists"},
		{Kind: "workspace", Name: "ready", Status: "ready"},
		{Kind: "workspace", Name: "blocked", Status: "needs", Detail: "web, gone"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("rows =\n%+v\nwant\n%+v", got, want)
	}
	// An existing name whose local checkout points elsewhere names it.
	other := ProjectStatus{Exists: true, Local: &project.Project{Name: "x", Path: "/x"}, LocalRemote: "git@y:x.git"}
	rows := PlanRows(Bundle{Projects: []Exported{{Project: project.Project{Name: "x"}, Remote: "git@x:x.git"}}}, Plan{Projects: []ProjectStatus{other}})
	if rows[0].Status != StatusOtherRemote || rows[0].Detail != "local git@y:x.git" {
		t.Errorf("other remote row = %+v", rows[0])
	}
}

// The default is a clone into crew's own dir, under the imported name,
// with the bundle's config and the overrides given.
func TestApplyProject_Clone(t *testing.T) {
	tmp := setupTestConfig(t)
	remote, _ := repoWithOrigin(t, tmp, "api")
	// The bundle's path (a v1 bundle carries one) is never where the clone
	// lands.
	b := Bundle{Projects: []Exported{
		{Project: project.Project{Name: "api", Path: "/Users/other/api", Setup: "npm ci"}, Remote: remote},
		{Project: project.Project{Name: "noremote"}},
	}}
	plan := Inspect(b)
	project.Add(project.Project{Name: "taken", Path: tmp})

	res, err := ApplyProject(b, plan, "api", ProjectOptions{Name: "api2", Setup: "make sync"})
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	if res.Path != project.ClonePath("api2") || !res.Cloned || res.Name != "api2" || res.Replaced {
		t.Errorf("result = %+v", res)
	}
	if _, err := os.Stat(filepath.Join(res.Path, ".git")); err != nil {
		t.Error("no checkout at the clone target")
	}
	p := project.Get("api2")
	if p == nil || p.Setup != "make sync" || !project.CrewOwned(*p) || project.RemoteOf(*p) != remote {
		t.Errorf("record = %+v", p)
	}
	if _, err := ApplyProject(b, plan, "noremote", ProjectOptions{}); err == nil || !strings.Contains(err.Error(), "no git remote") {
		t.Errorf("no remote: %v", err)
	}
	if _, err := os.Stat(project.ClonePath("noremote")); err == nil {
		t.Error("a refusal leaves nothing behind")
	}
	if _, err := ApplyProject(b, plan, "nope", ProjectOptions{}); err == nil {
		t.Error("unknown project must fail")
	}
	// A bad name, or a rename onto a name already in the pool, is refused
	// before any clone.
	if _, err := ApplyProject(b, plan, "api", ProjectOptions{Name: "Bad_Name"}); err == nil {
		t.Error("invalid name must be refused")
	}
	if _, err := os.Stat(project.ClonePath("Bad_Name")); err == nil {
		t.Error("a refused name must not have cloned")
	}
	if _, err := ApplyProject(b, plan, "api", ProjectOptions{Name: "taken"}); err == nil || !strings.Contains(err.Error(), "already in the pool — choose another name") {
		t.Errorf("collision: %v", err)
	}
	if _, err := os.Stat(project.ClonePath("taken")); err == nil {
		t.Error("a collision must not have cloned")
	}
	if p := project.Get("taken"); p == nil || p.Path != tmp {
		t.Error("the colliding record is untouched")
	}
}

// --path adopts a checkout as it is; nothing is cloned, and its own
// origin is the identity from then on.
func TestApplyProject_Adopt(t *testing.T) {
	tmp := setupTestConfig(t)
	_, have := repoWithOrigin(t, tmp, "web")
	b := Bundle{Projects: []Exported{{Project: project.Project{Name: "web"}, Remote: "git@x:web.git"}}}
	plan := Inspect(b)

	res, err := ApplyProject(b, plan, "web", ProjectOptions{Path: have})
	if err != nil || res.Path != have || res.Cloned {
		t.Errorf("adopt: %+v, %v", res, err)
	}
	// A relative path is recorded absolute — the identity is read off the
	// record later, from wherever crew is run.
	project.Remove("web")
	wd, _ := os.Getwd()
	rel, _ := filepath.Rel(wd, have)
	res, err = ApplyProject(b, plan, "web", ProjectOptions{Path: rel})
	if err != nil || res.Path != have {
		t.Errorf("relative adopt: %+v, %v", res, err)
	}
	if _, err := os.Stat(project.ClonePath("web")); err == nil {
		t.Error("an adoption clones nothing")
	}
	project.Remove("web")
	_, err = ApplyProject(b, plan, "web", ProjectOptions{Path: filepath.Join(tmp, "nope")})
	if err == nil || !strings.Contains(err.Error(), "--path: '"+filepath.Join(tmp, "nope")+"' is not a directory") {
		t.Errorf("missing --path: %v", err)
	}
	if project.Get("web") != nil {
		t.Error("a refused adoption records nothing")
	}
}

// The clone dir already there is refused, with the way out — never adopted
// silently, never deleted.
func TestApplyProject_DirTaken(t *testing.T) {
	tmp := setupTestConfig(t)
	remote, _ := repoWithOrigin(t, tmp, "api")
	os.MkdirAll(project.ClonePath("api"), 0o755)
	os.WriteFile(filepath.Join(project.ClonePath("api"), "marker"), nil, 0o644)
	b := Bundle{Projects: []Exported{{Project: project.Project{Name: "api"}, Remote: remote}}}
	_, err := ApplyProject(b, Inspect(b), "api", ProjectOptions{})
	if err == nil || !strings.Contains(err.Error(), "--path="+project.ClonePath("api")) {
		t.Errorf("dir taken: %v", err)
	}
	if _, err := os.Stat(filepath.Join(project.ClonePath("api"), "marker")); err != nil {
		t.Error("the dir must be untouched")
	}
	if project.Get("api") != nil {
		t.Error("nothing recorded")
	}
}

// --replace: same remote keeps the local checkout and swaps the config;
// another remote clones fresh — unless worktrees hang off the old one, or
// the clone dir is the old one.
func TestApplyProject_Replace(t *testing.T) {
	tmp := setupTestConfig(t)
	remote, clone := repoWithOrigin(t, tmp, "api")
	project.Add(project.Project{Name: "api", Path: clone})
	b := Bundle{Projects: []Exported{
		{Project: project.Project{Name: "api", DevServers: []project.DevServer{{Name: "api", Port: 3000}}}, Remote: "file://" + remote},
	}}
	plan := Inspect(b)
	if _, err := ApplyProject(b, plan, "api", ProjectOptions{}); err == nil || !strings.Contains(err.Error(), "--replace") {
		t.Fatalf("existing name without --replace: %v", err)
	}
	res, err := ApplyProject(b, plan, "api", ProjectOptions{Replace: true})
	if err != nil || res.Path != clone || res.Cloned || !res.Replaced {
		t.Errorf("same remote: %+v, %v", res, err)
	}
	if p := project.Get("api"); p == nil || p.Path != clone || len(p.DevServers) != 1 {
		t.Errorf("record = %+v", p)
	}
	if _, err := os.Stat(project.ClonePath("api")); err == nil {
		t.Error("a same-remote replace clones nothing")
	}

	// Another remote: refused before any clone while a workspace has it.
	other, _ := repoWithOrigin(t, tmp, "fork")
	b2 := Bundle{Projects: []Exported{{Project: project.Project{Name: "api"}, Remote: other}}}
	workspace.Create("ws")
	if _, err := workspace.AddProjects("ws", []workspace.ProjectSpec{{Name: "api"}}, workspace.CheckoutOptions{}); err != nil {
		t.Fatal(err)
	}
	_, err = ApplyProject(b2, Inspect(b2), "api", ProjectOptions{Replace: true})
	if err == nil || !strings.Contains(err.Error(), "still in workspace ws") {
		t.Errorf("other remote while in a workspace: %v", err)
	}
	if _, err := os.Stat(project.ClonePath("api")); err == nil {
		t.Error("refused before cloning")
	}
	workspace.Remove("ws")
	res, err = ApplyProject(b2, Inspect(b2), "api", ProjectOptions{Replace: true})
	if err != nil || res.Path != project.ClonePath("api") || !res.Cloned || !res.Replaced {
		t.Errorf("other remote, free: %+v, %v", res, err)
	}
	if p := project.Get("api"); p == nil || project.RemoteOf(*p) != other {
		t.Errorf("record points at the new remote: %+v", p)
	}
	// Now the local is crew-owned at the clone dir: a further replace from
	// elsewhere hits the dir-taken refusal.
	third, _ := repoWithOrigin(t, tmp, "third")
	b3 := Bundle{Projects: []Exported{{Project: project.Project{Name: "api"}, Remote: third}}}
	_, err = ApplyProject(b3, Inspect(b3), "api", ProjectOptions{Replace: true})
	if err == nil || !strings.Contains(err.Error(), "api's own clone — crew rm project api --purge first") {
		t.Errorf("crew-owned local at the clone dir names the purge: %v", err)
	}

	// A replace with --path is "the repo moved": allowed even under live
	// worktrees, as crew add project --path is on an existing project.
	workspace.Create("ws2")
	if _, err := workspace.AddProjects("ws2", []workspace.ProjectSpec{{Name: "api"}}, workspace.CheckoutOptions{}); err != nil {
		t.Fatal(err)
	}
	// Both refusals apply: the worktrees come first, because --purge is
	// itself refused while a workspace still has the project.
	_, err = ApplyProject(b3, Inspect(b3), "api", ProjectOptions{Replace: true})
	if err == nil || !strings.Contains(err.Error(), "still in workspace ws2") {
		t.Errorf("worktrees before the taken dir: %v", err)
	}
	_, moved := repoWithOrigin(t, tmp, "moved")
	res, err = ApplyProject(b3, Inspect(b3), "api", ProjectOptions{Replace: true, Path: moved})
	if err != nil || res.Path != moved || res.Cloned || !res.Replaced {
		t.Errorf("adopt-replace under worktrees: %+v, %v", res, err)
	}
}

// A config-only export of a project that is here without an origin: the
// card and the plan both say exists, and a replace syncs the config.
func TestApplyProject_ReplaceConfigOnly(t *testing.T) {
	tmp := setupTestConfig(t)
	plain := filepath.Join(tmp, "repos", "notes")
	initRepo(t, plain)
	project.Add(project.Project{Name: "notes", Path: plain})
	b := Bundle{Projects: []Exported{{Project: project.Project{Name: "notes", Setup: "make"}}}}
	res, err := ApplyProject(b, Inspect(b), "notes", ProjectOptions{Replace: true})
	if err != nil || res.Path != plain || res.Cloned || !res.Replaced {
		t.Errorf("%+v, %v", res, err)
	}
	if p := project.Get("notes"); p == nil || p.Setup != "make" || p.Path != plain {
		t.Errorf("record = %+v", p)
	}
}

// --all's rows: kept, cloned, replaced, failed — and a --replace that
// would move a canonical under worktrees is a refusal before any clone.
func TestAllRows(t *testing.T) {
	tmp := setupTestConfig(t)
	remote, clone := repoWithOrigin(t, tmp, "api")
	project.Add(project.Project{Name: "api", Path: clone})
	webRemote, _ := repoWithOrigin(t, tmp, "web")
	forkRemote, _ := repoWithOrigin(t, tmp, "fork")
	b := Bundle{Projects: []Exported{
		{Project: project.Project{Name: "api", Setup: "make"}, Remote: remote},
		{Project: project.Project{Name: "web"}, Remote: webRemote},
		{Project: project.Project{Name: "bad"}, Remote: filepath.Join(tmp, "missing.git")},
	}}
	word := func(r ProjectResult) string {
		if r.Replaced {
			return "replaced"
		}
		return "imported"
	}
	rows := AllRows(b, Inspect(b), ProjectOptions{}, word)
	// git's own wording for a missing remote varies by version; the row is
	// pinned up to git's fatal line.
	if len(rows) != 3 || !strings.HasPrefix(rows[2].Detail, "bad: git clone: fatal:") || rows[2].Status != "failed" {
		t.Fatalf("rows = %+v", rows)
	}
	rows[2].Detail = ""
	want := []PlanRow{
		{Kind: "project", Name: "api", Status: "kept local"},
		{Kind: "project", Name: "web", Status: "imported", Detail: project.ClonePath("web")},
		{Kind: "project", Name: "bad", Status: "failed"},
	}
	if !reflect.DeepEqual(rows, want) {
		t.Errorf("rows =\n%+v\nwant\n%+v", rows, want)
	}
	if project.Get("api").Setup != "" {
		t.Error("kept local means untouched")
	}
	rows = AllRows(b, Inspect(b), ProjectOptions{Replace: true}, word)
	if rows[0].Status != "replaced" || project.Get("api").Setup != "make" || rows[1].Status != "replaced" {
		t.Errorf("--replace rows = %+v", rows)
	}

	// Another remote for a project in a workspace: refused up front, so
	// the run never reaches AllRows and the local record stands.
	workspace.Create("ws")
	if _, err := workspace.AddProjects("ws", []workspace.ProjectSpec{{Name: "api"}}, workspace.CheckoutOptions{}); err != nil {
		t.Fatal(err)
	}
	b2 := Bundle{Projects: []Exported{{Project: project.Project{Name: "api"}, Remote: forkRemote}}}
	plan := Inspect(b2)
	if refused := Refusals(b2, plan, ProjectOptions{}); len(refused) != 0 {
		t.Errorf("without --replace nothing is refused: %+v", refused)
	}
	refused := Refusals(b2, plan, ProjectOptions{Replace: true})
	if len(refused) != 1 || refused[0].Status != StatusOtherRemote || !strings.Contains(refused[0].Detail, "still in workspace ws") {
		t.Errorf("refused = %+v", refused)
	}
	if lines := RefusalLines(refused); len(lines) != 1 || !strings.HasPrefix(lines[0], "  api\tother remote\t") {
		t.Errorf("lines = %q", lines)
	}
	if p := project.Get("api"); p == nil || p.Path != clone {
		t.Errorf("a refused run leaves the record alone: %+v", p)
	}
	if _, err := os.Stat(project.ClonePath("api")); err == nil {
		t.Error("a refused run clones nothing")
	}
}

func TestMembershipOf(t *testing.T) {
	tmp := setupTestConfig(t)
	api := filepath.Join(tmp, "repos", "api")
	initRepo(t, api)
	b := Bundle{
		Projects:   []Exported{{Project: project.Project{Name: "api"}}},
		Workspaces: []Membership{{Name: "ws", Projects: []workspace.WorkspaceProject{{Name: "api"}}}},
	}
	if _, err := MembershipOf(b, "ws"); err == nil {
		t.Fatal("members not in the pool yet must block")
	}
	if _, err := ApplyProject(b, Inspect(b), "api", ProjectOptions{Path: api}); err != nil {
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

// --env-cmd overrides the bundle's command on the way in; empty keeps it.
func TestApplyProject_EnvCmdOverride(t *testing.T) {
	tmp := setupTestConfig(t)
	here := filepath.Join(tmp, "web")
	os.MkdirAll(here, 0o755)
	b := Bundle{Projects: []Exported{{Project: project.Project{Name: "web", EnvCmd: "npm run get-env"}}}}
	if _, err := ApplyProject(b, Inspect(b), "web", ProjectOptions{Path: here}); err != nil {
		t.Fatal(err)
	}
	if got := project.Get("web").EnvCmd; got != "npm run get-env" {
		t.Errorf("kept = %q", got)
	}
	if _, err := ApplyProject(b, Inspect(b), "web", ProjectOptions{Replace: true, Path: here, EnvCmd: "make get-env"}); err != nil {
		t.Fatal(err)
	}
	if got := project.Get("web").EnvCmd; got != "make get-env" {
		t.Errorf("overridden = %q", got)
	}
}
