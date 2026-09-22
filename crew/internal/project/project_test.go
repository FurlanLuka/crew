package project

import (
	"encoding/json"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/exec"
)

func setupTestConfig(t *testing.T) {
	t.Helper()
	tmp := t.TempDir()
	config.ConfigDir = tmp
	config.WorkspacesDir = filepath.Join(tmp, "workspaces")
	config.ProjectsDir = filepath.Join(tmp, "projects")
	config.ClaudeConfigDir = filepath.Join(tmp, "claude")
	os.MkdirAll(config.WorkspacesDir, 0o755)
	os.MkdirAll(config.ClaudeConfigDir, 0o755)
}

func TestList_Empty(t *testing.T) {
	setupTestConfig(t)

	projects, err := List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if projects != nil {
		t.Errorf("List on missing file = %v, want nil", projects)
	}
}

func TestAddAndList(t *testing.T) {
	setupTestConfig(t)

	if err := Add(Project{Name: "api", Path: "/tmp/api"}); err != nil {
		t.Fatalf("Add api: %v", err)
	}
	if err := Add(Project{Name: "web", Path: "/tmp/web"}); err != nil {
		t.Fatalf("Add web: %v", err)
	}

	projects, err := List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(projects) != 2 {
		t.Fatalf("List returned %d, want 2", len(projects))
	}
	if projects[0].Name != "api" {
		t.Errorf("projects[0].Name = %q, want %q", projects[0].Name, "api")
	}
	if projects[1].Name != "web" {
		t.Errorf("projects[1].Name = %q, want %q", projects[1].Name, "web")
	}
}

func TestRemove(t *testing.T) {
	setupTestConfig(t)

	if err := Add(Project{Name: "a", Path: "/a"}); err != nil {
		t.Fatalf("Add a: %v", err)
	}
	if err := Add(Project{Name: "b", Path: "/b"}); err != nil {
		t.Fatalf("Add b: %v", err)
	}

	if err := Remove("a"); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	projects, _ := List()
	if len(projects) != 1 {
		t.Fatalf("After remove: %d projects, want 1", len(projects))
	}
	if projects[0].Name != "b" {
		t.Errorf("Remaining = %q, want %q", projects[0].Name, "b")
	}
}

func TestGet_Found(t *testing.T) {
	setupTestConfig(t)

	if err := Add(Project{Name: "target", Path: "/target"}); err != nil {
		t.Fatalf("Add: %v", err)
	}

	p := Get("target")
	if p == nil {
		t.Fatal("Get returned nil for existing project")
	}
	if p.Name != "target" || p.Path != "/target" {
		t.Errorf("Get = %+v, want {target /target}", p)
	}
}

func TestGet_NotFound(t *testing.T) {
	setupTestConfig(t)

	p := Get("nonexistent")
	if p != nil {
		t.Errorf("Get for non-existent = %+v, want nil", p)
	}
}

func TestAdd_Duplicate(t *testing.T) {
	setupTestConfig(t)

	if err := Add(Project{Name: "dup", Path: "/dup"}); err != nil {
		t.Fatalf("Add: %v", err)
	}
	err := Add(Project{Name: "dup", Path: "/other"})
	if err == nil {
		t.Fatal("Add should fail for duplicate project name")
	}
}

// A project name has to work inside {{…}}: no reserved word, no "." or "/".
func TestAdd_RejectsNamesThatCannotBeTokens(t *testing.T) {
	setupTestConfig(t)

	for _, name := range []string{"worktree", "workspace", "url", "host", "port", "Bad.Name", "a/b", "Caps"} {
		if err := Add(Project{Name: name, Path: "/p"}); err == nil {
			t.Errorf("Add(%q) accepted it", name)
		}
	}
	if err := Add(Project{Name: "store-api-2", Path: "/p"}); err != nil {
		t.Errorf("Add(store-api-2): %v", err)
	}
}

func TestUpdate(t *testing.T) {
	setupTestConfig(t)

	Add(Project{Name: "upd", Path: "/old"})
	if err := Update(Project{Name: "upd", Path: "/new"}); err != nil {
		t.Fatalf("Update: %v", err)
	}

	p := Get("upd")
	if p == nil {
		t.Fatal("project should exist after update")
	}
	if p.Path != "/new" {
		t.Errorf("Path = %q, want %q", p.Path, "/new")
	}
}

func TestUpdate_NotFound(t *testing.T) {
	setupTestConfig(t)

	err := Update(Project{Name: "ghost", Path: "/ghost"})
	if err == nil {
		t.Fatal("Update should fail for non-existent project")
	}
}

func TestAddDevServer(t *testing.T) {
	setupTestConfig(t)

	Add(Project{Name: "api", Path: "/api"})
	if err := AddDevServer("api", DevServer{Name: "web", Port: 3000, Command: "npm start"}); err != nil {
		t.Fatalf("AddDevServer: %v", err)
	}

	p := Get("api")
	if len(p.DevServers) != 1 {
		t.Fatalf("DevServers = %d, want 1", len(p.DevServers))
	}
	if p.DevServers[0].Name != "web" || p.DevServers[0].Port != 3000 {
		t.Errorf("DevServer = %+v, want {web 3000}", p.DevServers[0])
	}
}

func TestAddDevServer_ReplacesExisting(t *testing.T) {
	setupTestConfig(t)

	Add(Project{Name: "api", Path: "/api"})
	AddDevServer("api", DevServer{Name: "web", Port: 3000, Command: "npm start"})
	AddDevServer("api", DevServer{Name: "web", Port: 4000, Command: "npm run dev"})

	p := Get("api")
	if len(p.DevServers) != 1 {
		t.Fatalf("DevServers = %d, want 1 (should replace, not append)", len(p.DevServers))
	}
	if p.DevServers[0].Port != 4000 {
		t.Errorf("Port = %d, want 4000", p.DevServers[0].Port)
	}
}

func TestRemoveDevServer(t *testing.T) {
	setupTestConfig(t)

	Add(Project{Name: "api", Path: "/api"})
	AddDevServer("api", DevServer{Name: "web", Port: 3000, Command: "npm start"})
	AddDevServer("api", DevServer{Name: "api", Port: 8080, Command: "go run ."})

	if _, err := RemoveDevServer("api", "web"); err != nil {
		t.Fatalf("RemoveDevServer: %v", err)
	}

	p := Get("api")
	if len(p.DevServers) != 1 {
		t.Fatalf("DevServers = %d, want 1", len(p.DevServers))
	}
	if p.DevServers[0].Name != "api" {
		t.Errorf("remaining server = %q, want %q", p.DevServers[0].Name, "api")
	}
}

func TestSetPath(t *testing.T) {
	setupTestConfig(t)
	dir := t.TempDir()
	Add(Project{Name: "api", Path: "/old"})

	if err := SetPath("api", dir); err != nil {
		t.Fatalf("SetPath: %v", err)
	}
	if got := Get("api").Path; got != dir {
		t.Errorf("path = %q, want %q", got, dir)
	}
	if err := SetPath("api", "/nope/missing"); err == nil {
		t.Error("a missing dir must be refused")
	}
	if err := SetPath("ghost", dir); err == nil {
		t.Error("an unknown project must be refused")
	}
}

func TestSetEnvCmd_RoundTripsAndClears(t *testing.T) {
	setupTestConfig(t)
	Add(Project{Name: "api", Path: "/p"})
	if err := SetEnvCmd("api", "make get-env"); err != nil {
		t.Fatal(err)
	}
	if got := Get("api").EnvCmd; got != "make get-env" {
		t.Errorf("EnvCmd = %q", got)
	}
	if err := SetEnvCmd("api", ""); err != nil || Get("api").EnvCmd != "" {
		t.Errorf("clear: %v %q", err, Get("api").EnvCmd)
	}
	if err := SetEnvCmd("nope", "x"); err == nil {
		t.Error("unknown project must fail")
	}
}

func TestCrewOwned(t *testing.T) {
	setupTestConfig(t)
	if !CrewOwned(Project{Path: ClonePath("api")}) {
		t.Error("a clone under ProjectsDir is crew-owned")
	}
	if CrewOwned(Project{Path: config.ProjectsDir}) {
		t.Error("the projects dir itself is not a project")
	}
	if CrewOwned(Project{Path: config.ProjectsDir + "-old/api"}) {
		t.Error("a sibling dir with the prefix is not under it")
	}
	if CrewOwned(Project{Path: "repos/api"}) {
		t.Error("a relative path elsewhere is not crew-owned")
	}
}

// The identity is read off the checkout, never stored: a pool entry from
// before, a clone, a plain repo and a vanished path all answer.
func TestRemoteOf(t *testing.T) {
	if _, err := osexec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	setupTestConfig(t)
	seed := t.TempDir()
	for _, args := range [][]string{{"init", "-q", "-b", "main"}, {"-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"}} {
		if _, err := exec.RunGitCommand(seed, args...); err != nil {
			t.Fatal(err)
		}
	}
	clone := filepath.Join(t.TempDir(), "clone")
	if err := exec.Clone("file://"+seed, clone); err != nil {
		t.Fatal(err)
	}
	if got := RemoteOf(Project{Name: "api", Path: clone}); got != "file://"+seed {
		t.Errorf("clone = %q", got)
	}
	if got := RemoteOf(Project{Name: "seed", Path: seed}); got != "" {
		t.Errorf("plain repo = %q", got)
	}
	if got := RemoteOf(Project{Name: "gone", Path: "/nope/gone"}); got != "" {
		t.Errorf("vanished = %q", got)
	}
}

func TestPath_OmittedWhenEmpty(t *testing.T) {
	data, _ := json.Marshal(Project{Name: "a"})
	if strings.Contains(string(data), `"path"`) {
		t.Errorf("empty path written: %s", data)
	}
	data, _ = json.Marshal(Project{Name: "a", Path: "/p"})
	if !strings.Contains(string(data), `"path":"/p"`) {
		t.Errorf("path missing: %s", data)
	}
}

func TestCloneAllowed(t *testing.T) {
	setupTestConfig(t)
	if err := CloneAllowed("api"); err != nil || CloneDirTaken("api") {
		t.Errorf("free: %v", err)
	}
	os.MkdirAll(ClonePath("api"), 0o755)
	if err := CloneAllowed("api"); err == nil || !strings.Contains(err.Error(), "crew add project api --path="+ClonePath("api")+" registers what is there, or delete it first") {
		t.Errorf("taken: %v", err)
	}
	// A file where the clone would land stops git just as a dir does.
	os.WriteFile(ClonePath("filed"), []byte("x"), 0o644)
	if !CloneDirTaken("filed") {
		t.Error("a file at the clone path is taken")
	}
	if err := ValidateCheckoutDir(ClonePath("filed")); err == nil || !strings.Contains(err.Error(), "is not a directory") {
		t.Errorf("a file is not a checkout: %v", err)
	}
	if err := ValidateCheckoutDir(ClonePath("api")); err != nil {
		t.Errorf("a dir is: %v", err)
	}
}

// The repo moved: the new path is recorded absolute, since the identity is
// read off it later from wherever crew runs.
func TestSetPath_Absolute(t *testing.T) {
	setupTestConfig(t)
	Add(Project{Name: "api", Path: "/old"})
	dir := t.TempDir()
	wd, _ := os.Getwd()
	rel, err := filepath.Rel(wd, dir)
	if err != nil {
		t.Skip("temp dir not relative to cwd")
	}
	if err := SetPath("api", rel); err != nil {
		t.Fatal(err)
	}
	if got := Get("api").Path; got != dir {
		t.Errorf("Path = %q, want %q", got, dir)
	}
	if err := SetPath("api", filepath.Join(dir, "nope")); err == nil || !strings.Contains(err.Error(), "is not a directory") {
		t.Errorf("missing dir: %v", err)
	}
}

// NewTarget is the decision crew add project and the wizard share: the
// refusals come before any clone would land.
func TestNewTarget(t *testing.T) {
	setupTestConfig(t)
	have := t.TempDir()
	Add(Project{Name: "taken", Path: have})
	os.MkdirAll(ClonePath("blocked"), 0o755)
	for _, tt := range []struct {
		name, path string
		target     string
		clone      bool
		wantErr    string
	}{
		{"signals", "", ClonePath("signals"), true, ""},
		{"signals", have, have, false, ""},
		{"taken", "", "", false, "project 'taken' already exists at " + have},
		{"blocked", "", "", false, "crew add project blocked --path=" + ClonePath("blocked")},
		{"signals", have + "/nope", "", false, "is not a directory"},
		{"Bad", "", "", false, "not a valid project name"},
	} {
		target, clone, err := NewTarget(tt.name, tt.path)
		if tt.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("%s/%s: err = %v, want %q", tt.name, tt.path, err, tt.wantErr)
			}
			continue
		}
		if err != nil || target != tt.target || clone != tt.clone {
			t.Errorf("%s/%s: got %q %v %v", tt.name, tt.path, target, clone, err)
		}
	}
	wd, _ := os.Getwd()
	if rel, err := filepath.Rel(wd, have); err == nil {
		if target, _, err := NewTarget("signals", rel); err != nil || target != have {
			t.Errorf("a relative path is taken absolute: %q, %v", target, err)
		}
	}
}
