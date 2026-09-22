package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/transfer"
)

func TestParseExportArgs(t *testing.T) {
	tests := []struct {
		name    string
		args    []string
		want    exportArgs
		wantErr string
	}{
		{name: "none → picker, default file", args: nil, want: exportArgs{file: "crew-export.json"}},
		{name: "file only", args: []string{"x.json"}, want: exportArgs{file: "x.json"}},
		{name: "all", args: []string{"--all", "out.json"}, want: exportArgs{file: "out.json", all: true}},
		{name: "projects and workspaces", args: []string{"--projects=a, b", "--workspaces=ws"},
			want: exportArgs{file: "crew-export.json", projects: []string{"a", "b"}, workspaces: []string{"ws"}}},
		{name: "workspaces without projects", args: []string{"--workspaces=ws"}, wantErr: "needs --projects"},
		{name: "all with projects", args: []string{"--all", "--projects=a"}, wantErr: "--all takes everything"},
		{name: "two files", args: []string{"a.json", "b.json"}, wantErr: "one file at most"},
		{name: "unknown flag", args: []string{"--nope"}, wantErr: "unknown flag"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseExportArgs(tt.args)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got.file != tt.want.file || got.all != tt.want.all ||
				strings.Join(got.projects, ",") != strings.Join(tt.want.projects, ",") ||
				strings.Join(got.workspaces, ",") != strings.Join(tt.want.workspaces, ",") {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
			if got.interactive() != (tt.want.all == false && len(tt.want.projects) == 0) {
				t.Errorf("interactive = %v", got.interactive())
			}
		})
	}
}

func TestParseImportArgs(t *testing.T) {
	home, _ := os.UserHomeDir()
	tests := []struct {
		name    string
		args    []string
		want    importArgs
		wantErr string
	}{
		{name: "file only → wizard", args: []string{"b.json"}, want: importArgs{file: "b.json"}},
		{name: "plan", args: []string{"b.json", "--plan"}, want: importArgs{file: "b.json", plan: true}},
		{name: "all with replace", args: []string{"--all", "b.json", "--replace"},
			want: importArgs{file: "b.json", all: true, project: transfer.ProjectOptions{Replace: true}}},
		{name: "project with every flag", args: []string{"b.json", "project", "api", "--replace", "--name=api2", "--setup=make", "--env-cmd=make get-env", "--path=/p"},
			want: importArgs{file: "b.json", item: "project", name: "api", project: transfer.ProjectOptions{Replace: true, Name: "api2", Setup: "make", EnvCmd: "make get-env", Path: "/p"}}},
		{name: "tilde path", args: []string{"b.json", "project", "api", "--path=~/x"},
			want: importArgs{file: "b.json", item: "project", name: "api", project: transfer.ProjectOptions{Path: filepath.Join(home, "x")}}},
		{name: "env cmd on workspace", args: []string{"b.json", "workspace", "ws", "--env-cmd=x"}, wantErr: "belong to import <file> project"},
		{name: "workspace", args: []string{"b.json", "workspace", "ws"}, want: importArgs{file: "b.json", item: "workspace", name: "ws"}},
		{name: "no file", args: []string{"--plan"}, wantErr: "bundle file"},
		{name: "item without name", args: []string{"b.json", "project"}, wantErr: "needs a name"},
		{name: "two modes", args: []string{"b.json", "--plan", "--all"}, wantErr: "one of"},
		{name: "path on all", args: []string{"b.json", "--all", "--path=/p"}, wantErr: "belong to import <file> project"},
		{name: "clone is the default now", args: []string{"b.json", "--all", "--clone"}, wantErr: "clone is the default now; --path=<dir> adopts"},
		{name: "clone= too", args: []string{"b.json", "project", "api", "--clone=/x"}, wantErr: "clone is the default now"},
		{name: "replace on workspace", args: []string{"b.json", "workspace", "ws", "--replace"}, wantErr: "belongs to project"},
		{name: "replace on plan", args: []string{"b.json", "--plan", "--replace"}, wantErr: "needs --all"},
		{name: "unknown flag", args: []string{"b.json", "--nope"}, wantErr: "unknown flag"},
		{name: "stray argument", args: []string{"b.json", "x"}, wantErr: "unexpected argument"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseImportArgs(tt.args)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			// install and smoke default on; the table leaves them out.
			tt.want.install, tt.want.smoke = true, true
			if got != tt.want {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

// outcomeWord is the outcome column agents parse from import --json.
func TestOutcomeWord(t *testing.T) {
	for _, tt := range []struct {
		res  transfer.ProjectResult
		want string
	}{
		{transfer.ProjectResult{}, "imported"},
		{transfer.ProjectResult{Cloned: true}, "imported (cloned)"},
		{transfer.ProjectResult{Replaced: true}, "replaced"},
		{transfer.ProjectResult{Replaced: true, Cloned: true}, "replaced (cloned)"},
	} {
		if got := outcomeWord(tt.res); got != tt.want {
			t.Errorf("%+v → %q, want %q", tt.res, got, tt.want)
		}
	}
}

func TestParseImportArgs_WorktreeOptions(t *testing.T) {
	a, err := parseImportArgs([]string{"b.json", "workspace", "ws", "--pull", "--no-smoke"})
	if err != nil || !a.pull || !a.install || a.smoke {
		t.Errorf("workspace flags: %+v, %v", a, err)
	}
	a, err = parseImportArgs([]string{"b.json", "--all", "--no-install"})
	if err != nil || a.install || !a.smoke {
		t.Errorf("--all flags: %+v, %v", a, err)
	}
	// No install, nothing to smoke — the same rule as crew add worktree.
	if o := a.checkoutOptions(); o.Install || o.Smoke {
		t.Errorf("--no-install must also skip the smoke: %+v", o)
	}
	a, _ = parseImportArgs([]string{"b.json", "workspace", "ws", "--no-smoke"})
	if o := a.checkoutOptions(); !o.Install || o.Smoke {
		t.Errorf("--no-smoke keeps the install: %+v", o)
	}
	if _, err := parseImportArgs([]string{"b.json", "project", "api", "--pull"}); err == nil || !strings.Contains(err.Error(), "belong to workspace") {
		t.Errorf("--pull on a project: %v", err)
	}
	if a, _ := parseImportArgs([]string{"b.json", "--plan"}); !a.install || !a.smoke {
		t.Errorf("defaults should be install+smoke: %+v", a)
	}
	if a, err := parseImportArgs([]string{"b.json", "workspace", "ws", "--wait"}); err != nil || !a.wait {
		t.Errorf("workspace --wait: %+v, %v", a, err)
	}
	if a, err := parseImportArgs([]string{"b.json", "--all", "--wait"}); err != nil || !a.wait {
		t.Errorf("--all --wait: %+v, %v", a, err)
	}
	if _, err := parseImportArgs([]string{"b.json", "project", "api", "--wait"}); err == nil || !strings.Contains(err.Error(), "belong to workspace") {
		t.Errorf("--wait on a project: %v", err)
	}
}
