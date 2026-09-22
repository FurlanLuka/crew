package main

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

func TestExtractFlag(t *testing.T) {
	tests := []struct {
		name     string
		args     []string
		flag     string
		wantArgs []string
		wantHit  bool
	}{
		{
			name:     "absent",
			args:     []string{"crew", "ls", "workspaces"},
			flag:     "--json",
			wantArgs: []string{"crew", "ls", "workspaces"},
			wantHit:  false,
		},
		{
			name:     "present trailing",
			args:     []string{"crew", "ls", "workspaces", "--json"},
			flag:     "--json",
			wantArgs: []string{"crew", "ls", "workspaces"},
			wantHit:  true,
		},
		{
			name:     "present leading",
			args:     []string{"crew", "--json", "ls", "workspaces"},
			flag:     "--json",
			wantArgs: []string{"crew", "ls", "workspaces"},
			wantHit:  true,
		},
		{
			name:     "repeated",
			args:     []string{"crew", "--json", "show", "ws", "--json"},
			flag:     "--json",
			wantArgs: []string{"crew", "show", "ws"},
			wantHit:  true,
		},
		{
			name:     "only binary",
			args:     []string{"crew"},
			flag:     "--json",
			wantArgs: []string{"crew"},
			wantHit:  false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotArgs, gotHit := extractFlag(tt.args, tt.flag)
			if gotHit != tt.wantHit {
				t.Errorf("hit = %v, want %v", gotHit, tt.wantHit)
			}
			if !reflect.DeepEqual(gotArgs, tt.wantArgs) {
				t.Errorf("args = %v, want %v", gotArgs, tt.wantArgs)
			}
		})
	}
}

// TestEmptySliceMarshalsToArray documents why JSON branches must initialize
// output slices as []T{} rather than a nil var: a nil slice marshals to "null",
// an empty non-nil slice to "[]". Consumers expect an array, so [] is required.
func TestEmptySliceMarshalsToArray(t *testing.T) {
	var nilSlice []int
	nilData, _ := json.Marshal(nilSlice)
	if string(nilData) != "null" {
		t.Errorf("nil slice marshaled to %q, want \"null\"", nilData)
	}

	emptySlice := []int{}
	emptyData, _ := json.Marshal(emptySlice)
	if string(emptyData) != "[]" {
		t.Errorf("empty slice marshaled to %q, want \"[]\"", emptyData)
	}
}

func TestSplitRunArgs(t *testing.T) {
	tests := []struct {
		name    string
		args    []string
		ref     string
		project string
		command []string
		wantErr string
	}{
		{
			name:    "ref project and command",
			args:    []string{"store-front/wrk1", "checkout-api", "--", "make", "eval"},
			ref:     "store-front/wrk1",
			project: "checkout-api",
			command: []string{"make", "eval"},
		},
		{
			name:    "bare workspace",
			args:    []string{"admin", "backend", "--", "npm", "test"},
			ref:     "admin",
			project: "backend",
			command: []string{"npm", "test"},
		},
		{
			name:    "child flags survive",
			args:    []string{"ws/wt", "p", "--", "node", "--json", "--flag"},
			ref:     "ws/wt",
			project: "p",
			command: []string{"node", "--json", "--flag"},
		},
		{name: "no separator", args: []string{"ws", "p", "make"}, wantErr: "missing '--'"},
		{name: "nothing after separator", args: []string{"ws", "p", "--"}, wantErr: "no command"},
		{name: "no project", args: []string{"ws", "--", "make"}, wantErr: "missing workspace or project"},
		{name: "empty", args: nil, wantErr: "missing '--'"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ref, project, command, err := splitRunArgs(tt.args)

			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("error = %v, want it to mention %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("splitRunArgs: %v", err)
			}
			if ref != tt.ref || project != tt.project {
				t.Errorf("got (%q, %q), want (%q, %q)", ref, project, tt.ref, tt.project)
			}
			if strings.Join(command, " ") != strings.Join(tt.command, " ") {
				t.Errorf("command = %q, want %q", command, tt.command)
			}
		})
	}
}

// `crew run ws/wt proj -- node --json` must leave the child's flag alone: the
// global stripper runs before dispatch and would otherwise eat it and switch
// crew's own output to JSON.
func TestExtractFlag_StopsAtSeparator(t *testing.T) {
	args, found := extractFlag([]string{"crew", "run", "ws/wt", "p", "--", "node", "--json"}, "--json")

	if found {
		t.Error("--json after '--' belongs to the child, not to crew")
	}
	if got := strings.Join(args, " "); got != "crew run ws/wt p -- node --json" {
		t.Errorf("args = %q, want the child's flag preserved", got)
	}
}

func TestExtractFlag_BeforeSeparatorStillWorks(t *testing.T) {
	args, found := extractFlag([]string{"crew", "--json", "run", "ws", "p", "--", "node"}, "--json")

	if !found {
		t.Error("--json before '--' is crew's own flag")
	}
	if got := strings.Join(args, " "); got != "crew run ws p -- node" {
		t.Errorf("args = %q, want crew's flag stripped", got)
	}
}

func TestParseAddProjectArgs(t *testing.T) {
	tests := []struct {
		name    string
		args    []string
		want    addProjectArgs
		wantErr string
	}{
		{name: "new project", args: []string{"api", "/repo"}, want: addProjectArgs{name: "api", path: "/repo"}},
		{name: "new with setup", args: []string{"api", "/repo", "--setup=make sync"}, want: addProjectArgs{name: "api", path: "/repo", setup: "make sync", hasSetup: true}},
		{name: "update setup", args: []string{"api", "--setup=make sync"}, want: addProjectArgs{name: "api", setup: "make sync", hasSetup: true}},
		{name: "clear setup", args: []string{"api", "--setup="}, want: addProjectArgs{name: "api", hasSetup: true}},
		{name: "update path", args: []string{"api", "--path=/moved"}, want: addProjectArgs{name: "api", newPath: "/moved"}},
		{name: "both", args: []string{"api", "--setup=x", "--path=/moved"}, want: addProjectArgs{name: "api", setup: "x", hasSetup: true, newPath: "/moved"}},
		{name: "new with env cmd", args: []string{"api", "/repo", "--env-cmd=make get-env"}, want: addProjectArgs{name: "api", path: "/repo", envCmd: "make get-env", hasEnvCmd: true}},
		{name: "clear env cmd", args: []string{"api", "--env-cmd="}, want: addProjectArgs{name: "api", hasEnvCmd: true}},
		{name: "no args", args: nil, wantErr: "usage"},
		{name: "two paths", args: []string{"api", "/a", "/b"}, wantErr: "one path at most"},
		{name: "unknown flag", args: []string{"api", "--nope"}, wantErr: "unknown flag"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseAddProjectArgs(tt.args)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Errorf("got %+v, %v; want %+v", got, err, tt.want)
			}
		})
	}

	// An existing project needs at least one thing to change.
	if err := (addProjectArgs{name: "api"}).updatesExisting(); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("no flags on an existing project: %v", err)
	}
	if err := (addProjectArgs{name: "api", newPath: "/x"}).updatesExisting(); err != nil {
		t.Errorf("--path alone should update: %v", err)
	}
	if err := (addProjectArgs{name: "api", hasEnvCmd: true}).updatesExisting(); err != nil {
		t.Errorf("--env-cmd alone should update: %v", err)
	}
}

func TestParseIntFlag(t *testing.T) {
	for _, tt := range []struct {
		raw      string
		positive bool
		want     int
		wantErr  bool
	}{
		{"30", true, 30, false},
		{" 30 ", true, 30, false},
		{"30x0", true, 0, true},
		{"0", true, 0, true},
		{"-1", true, 0, true},
		{"0", false, 0, false},
		{"", true, 0, true},
	} {
		got, err := parseIntFlag(tt.raw, tt.positive)
		if (err != nil) != tt.wantErr || got != tt.want {
			t.Errorf("parseIntFlag(%q, %v) = %d, %v; want %d, err=%v", tt.raw, tt.positive, got, err, tt.want, tt.wantErr)
		}
	}
}

func TestParseProjectSpecs(t *testing.T) {
	tests := []struct {
		name    string
		args    []string
		want    []workspace.ProjectSpec
		wantErr string
	}{
		{name: "one with --role", args: []string{"api", "--role=Backend"}, want: []workspace.ProjectSpec{{Name: "api", Role: "Backend"}}},
		{name: "one without role", args: []string{"api"}, want: []workspace.ProjectSpec{{Name: "api", Role: "works on api"}}},
		{name: "several with inline roles", args: []string{"api:Backend API", "web:iOS app", "worker"},
			want: []workspace.ProjectSpec{{Name: "api", Role: "Backend API"}, {Name: "web", Role: "iOS app"}, {Name: "worker", Role: "works on worker"}}},
		{name: "direct applies to all", args: []string{"api", "web", "--direct"},
			want: []workspace.ProjectSpec{{Name: "api", Role: "works on api", Mode: workspace.ModeDirect}, {Name: "web", Role: "works on web", Mode: workspace.ModeDirect}}},
		{name: "--role with several", args: []string{"api", "web", "--role=x"}, wantErr: "names one project's role"},
		{name: "role twice", args: []string{"api:x", "--role=y"}, wantErr: "give the role once"},
		{name: "empty name", args: []string{":role"}, wantErr: "project name is needed"},
		{name: "unknown flag", args: []string{"api", "--nope"}, wantErr: "unknown flag"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseProjectSpecs(tt.args)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != len(tt.want) {
				t.Fatalf("got %+v, want %+v", got, tt.want)
			}
			for i := range tt.want {
				if got[i] != tt.want[i] {
					t.Errorf("spec %d = %+v, want %+v", i, got[i], tt.want[i])
				}
			}
		})
	}
}

// Each flag on an existing project lands, and only that one; empty clears.
func TestApplyProjectUpdate(t *testing.T) {
	prev := config.ConfigDir
	config.ConfigDir = t.TempDir()
	t.Cleanup(func() { config.ConfigDir = prev })
	project.Add(project.Project{Name: "api", Path: "/p", Setup: "make sync"})
	lines, err := applyProjectUpdate(addProjectArgs{name: "api", envCmd: "make get-env", hasEnvCmd: true})
	if err != nil || len(lines) != 1 || lines[0] != "Env command for api: make get-env" {
		t.Fatalf("lines = %v, %v", lines, err)
	}
	if p := project.Get("api"); p.EnvCmd != "make get-env" || p.Setup != "make sync" {
		t.Errorf("after --env-cmd: %+v", p)
	}
	if _, err := applyProjectUpdate(addProjectArgs{name: "api", hasEnvCmd: true}); err != nil {
		t.Fatal(err)
	}
	if p := project.Get("api"); p.EnvCmd != "" {
		t.Errorf("empty must clear: %+v", p)
	}
	if _, err := applyProjectUpdate(addProjectArgs{name: "api"}); err == nil {
		t.Error("no flags must be refused")
	}
}

func TestParseRmProjectArgs(t *testing.T) {
	for _, tt := range []struct {
		args    []string
		name    string
		purge   bool
		wantErr string
	}{
		{[]string{"api"}, "api", false, ""},
		{[]string{"api", "--purge"}, "api", true, ""},
		{[]string{"--purge", "api"}, "api", true, ""},
		{nil, "", false, "a project name"},
		{[]string{"api", "web"}, "", false, "unexpected argument"},
		{[]string{"api", "--force"}, "", false, "unknown flag"},
	} {
		name, purge, err := parseRmProjectArgs(tt.args)
		if tt.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("%v: err = %v, want %q", tt.args, err, tt.wantErr)
			}
			continue
		}
		if err != nil || name != tt.name || purge != tt.purge {
			t.Errorf("%v: got %s %v %v", tt.args, name, purge, err)
		}
	}
}

// --purge is for clones crew made, and only once nothing depends on the
// canonical any more.
func TestPurgeAllowed(t *testing.T) {
	prev := config.ProjectsDir
	config.ProjectsDir = t.TempDir()
	t.Cleanup(func() { config.ProjectsDir = prev })
	owned := project.Project{Name: "api", Path: config.ProjectsDir + "/api"}
	if err := purgeAllowed(project.Project{Name: "api", Path: "/home/me/api"}, nil, false); err == nil || !strings.Contains(err.Error(), "not a clone crew made") {
		t.Errorf("user-owned: %v", err)
	}
	if err := purgeAllowed(owned, []string{"store", "admin"}, false); err == nil || !strings.Contains(err.Error(), "workspace store, admin — crew rm workspace store api; crew rm workspace admin api first") {
		t.Errorf("member: %v", err)
	}
	if err := purgeAllowed(owned, nil, true); err == nil || !strings.Contains(err.Error(), "rm worktree check/api") {
		t.Errorf("checked: %v", err)
	}
	if err := purgeAllowed(owned, nil, false); err != nil {
		t.Errorf("clean: %v", err)
	}
}

func TestCloneAllowed(t *testing.T) {
	dir := t.TempDir()
	if err := cloneAllowed("api", dir); err == nil || !strings.Contains(err.Error(), "crew add project api "+dir) {
		t.Errorf("existing dir: %v", err)
	}
	if err := cloneAllowed("api", dir+"/new"); err != nil {
		t.Errorf("free path: %v", err)
	}
}

// Where a new project's path comes from, and what a URL refuses.
func TestAddProjectTarget(t *testing.T) {
	prev := config.ProjectsDir
	config.ProjectsDir = t.TempDir()
	t.Cleanup(func() { config.ProjectsDir = prev })
	url := "git@github.com:example/signals.git"
	existing := &project.Project{Name: "signals", Path: "/repos/signals"}
	for _, tt := range []struct {
		name     string
		a        addProjectArgs
		existing *project.Project
		path     string
		clone    bool
		wantErr  string
	}{
		{"path", addProjectArgs{name: "signals", path: "/repos/signals"}, nil, "/repos/signals", false, ""},
		{"update keeps the path decision to the caller", addProjectArgs{name: "signals", hasSetup: true}, existing, "", false, ""},
		{"no path", addProjectArgs{name: "signals"}, nil, "", false, "usage"},
		{"url", addProjectArgs{name: "signals", path: url}, nil, project.ClonePath("signals"), true, ""},
		{"url on an existing project", addProjectArgs{name: "signals", path: url}, existing, "", false, "already exists at /repos/signals"},
		{"url with --path", addProjectArgs{name: "signals", path: url, newPath: "/x"}, nil, "", false, "--path means"},
	} {
		path, clone, err := addProjectTarget(tt.a, tt.existing)
		if tt.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("%s: err = %v, want %q", tt.name, err, tt.wantErr)
			}
			continue
		}
		if err != nil || path != tt.path || clone != tt.clone {
			t.Errorf("%s: got %q %v %v", tt.name, path, clone, err)
		}
	}
	os.MkdirAll(project.ClonePath("taken"), 0o755)
	if _, _, err := addProjectTarget(addProjectArgs{name: "taken", path: url}, nil); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("clone dir taken: %v", err)
	}
}
