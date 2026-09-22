package main

import (
	"encoding/json"
	"os"
	"path/filepath"
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
	// ~ reaches crew unexpanded from an agent; the parser expands it.
	home, _ := os.UserHomeDir()
	tests := []struct {
		name    string
		args    []string
		want    addProjectArgs
		wantErr string
	}{
		{name: "new project", args: []string{"api", "git@x:api.git"}, want: addProjectArgs{name: "api", url: "git@x:api.git"}},
		{name: "new with setup", args: []string{"api", "git@x:api.git", "--setup=make sync"}, want: addProjectArgs{name: "api", url: "git@x:api.git", setup: "make sync", hasSetup: true}},
		{name: "update setup", args: []string{"api", "--setup=make sync"}, want: addProjectArgs{name: "api", setup: "make sync", hasSetup: true}},
		{name: "clear setup", args: []string{"api", "--setup="}, want: addProjectArgs{name: "api", hasSetup: true}},
		{name: "update path", args: []string{"api", "--path=/moved"}, want: addProjectArgs{name: "api", newPath: "/moved"}},
		{name: "both", args: []string{"api", "--setup=x", "--path=/moved"}, want: addProjectArgs{name: "api", setup: "x", hasSetup: true, newPath: "/moved"}},
		{name: "new with env cmd", args: []string{"api", "git@x:api.git", "--env-cmd=make get-env"}, want: addProjectArgs{name: "api", url: "git@x:api.git", envCmd: "make get-env", hasEnvCmd: true}},
		{name: "adopt", args: []string{"api", "--path=/repo"}, want: addProjectArgs{name: "api", newPath: "/repo"}},
		{name: "tilde path", args: []string{"api", "--path=~/x"}, want: addProjectArgs{name: "api", newPath: filepath.Join(home, "x")}},
		{name: "clear env cmd", args: []string{"api", "--env-cmd="}, want: addProjectArgs{name: "api", hasEnvCmd: true}},
		{name: "no args", args: nil, wantErr: "usage"},
		{name: "two urls", args: []string{"api", "git@x:a.git", "git@x:b.git"}, wantErr: "one url at most"},
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
		{name: "one", args: []string{"api"}, want: []workspace.ProjectSpec{{Name: "api"}}},
		{name: "several", args: []string{"api", "web", "worker"},
			want: []workspace.ProjectSpec{{Name: "api"}, {Name: "web"}, {Name: "worker"}}},
		{name: "direct applies to all", args: []string{"api", "web", "--direct"},
			want: []workspace.ProjectSpec{{Name: "api", Mode: workspace.ModeDirect}, {Name: "web", Mode: workspace.ModeDirect}}},
		{name: "the old role form", args: []string{"api:Backend API"}, wantErr: "'api:Backend API': roles are gone"},
		{name: "the old role flag", args: []string{"api", "--role=x"}, wantErr: "unknown flag '--role=x' — roles are gone"},
		{name: "empty name", args: []string{":role"}, wantErr: "roles are gone"},
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
		args        []string
		name        string
		keep, purge bool
		wantErr     string
	}{
		{[]string{"api"}, "api", false, false, ""},
		{[]string{"api", "--keep-clone"}, "api", true, false, ""},
		{[]string{"--keep-clone", "api"}, "api", true, false, ""},
		{[]string{"api", "--purge"}, "api", false, true, ""},
		{[]string{"api", "--purge", "--keep-clone"}, "api", true, true, ""},
		{nil, "", false, false, "a project name"},
		{[]string{"api", "web"}, "", false, false, "unexpected argument"},
		{[]string{"api", "--force"}, "", false, false, "unknown flag"},
	} {
		name, keep, purge, err := parseRmProjectArgs(tt.args)
		if tt.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("%v: err = %v, want %q", tt.args, err, tt.wantErr)
			}
			continue
		}
		if err != nil || name != tt.name || keep != tt.keep || purge != tt.purge {
			t.Errorf("%v: got %s keep=%v purge=%v %v", tt.args, name, keep, purge, err)
		}
	}
}

func TestShowRows(t *testing.T) {
	res := &workspace.Resolved{Projects: []workspace.ResolvedProject{
		{Name: "api", Path: "/w/ws/main/api"},
		{Name: "infra", Path: "/repos/infra", Direct: true},
	}}
	got := showRows(res)
	want := []wsProjectOut{{Name: "api", Path: "/w/ws/main/api", Mode: "worktree"}, {Name: "infra", Path: "/repos/infra", Mode: "direct"}}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("showRows = %+v, want %+v", got, want)
	}
	if data, _ := json.Marshal(got); strings.Contains(string(data), "role") {
		t.Errorf("no role key: %s", data)
	}
}

// Where a new project's path comes from, and what a URL refuses.
func TestAddProjectTarget(t *testing.T) {
	prevDir, prevProjects := config.ConfigDir, config.ProjectsDir
	config.ConfigDir, config.ProjectsDir = t.TempDir(), t.TempDir()
	t.Cleanup(func() { config.ConfigDir, config.ProjectsDir = prevDir, prevProjects })
	url := "git@github.com:example/signals.git"
	have := t.TempDir()
	// The pool holds the existing project: the "already exists" refusal
	// is NewTarget's, read off the pool.
	project.Add(project.Project{Name: "store-api", Path: "/repos/store-api"})
	existing := project.Get("store-api")
	for _, tt := range []struct {
		name     string
		a        addProjectArgs
		existing *project.Project
		path     string
		clone    bool
		wantErr  string
	}{
		{"url clones", addProjectArgs{name: "signals", url: url}, nil, project.ClonePath("signals"), true, ""},
		{"--path adopts", addProjectArgs{name: "signals", newPath: have}, nil, have, false, ""},
		{"--path must be a dir", addProjectArgs{name: "signals", newPath: have + "/nope"}, nil, "", false, "is not a directory"},
		{"a bare path is refused", addProjectArgs{name: "signals", url: "/repos/signals"}, nil, "", false, "crew add project signals --path=/repos/signals; the default is a git URL"},
		{"update keeps the path decision to the caller", addProjectArgs{name: "store-api", hasSetup: true}, existing, "", false, ""},
		{"--path on an existing project is a move", addProjectArgs{name: "store-api", newPath: "/moved"}, existing, "/moved", false, ""},
		{"nothing given", addProjectArgs{name: "signals"}, nil, "", false, "usage"},
		{"url on an existing project", addProjectArgs{name: "store-api", url: url}, existing, "", false, "already exists at /repos/store-api"},
		{"a bad name with --path", addProjectArgs{name: "Bad", newPath: have}, nil, "", false, "'Bad' is not a valid project name"},
		{"url with --path", addProjectArgs{name: "signals", url: url, newPath: "/x"}, nil, "", false, "drop --path to clone it, or drop the URL to adopt /x"},
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
	if _, _, err := addProjectTarget(addProjectArgs{name: "taken", url: url}, nil); err == nil || !strings.Contains(err.Error(), "crew add project taken --path="+project.ClonePath("taken")) {
		t.Errorf("clone dir taken: %v", err)
	}
	wd, _ := os.Getwd()
	if rel, err := filepath.Rel(wd, have); err == nil {
		if path, _, err := addProjectTarget(addProjectArgs{name: "signals", newPath: rel}, nil); err != nil || path != have {
			t.Errorf("a relative --path is recorded absolute: %q, %v", path, err)
		}
	}
}

func TestProjectLine(t *testing.T) {
	p := project.Project{Name: "api", Path: "/p/api"}
	if got := projectLine(p, "git@x:api.git"); got != "api\t/p/api\tgit@x:api.git" {
		t.Errorf("%q", got)
	}
	if got := projectLine(p, ""); got != "api\t/p/api\t-" {
		t.Errorf("%q", got)
	}
}
