package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
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
			args:    []string{"phone-speak/wrk1", "ai-tutor-api", "--", "make", "eval"},
			ref:     "phone-speak/wrk1",
			project: "ai-tutor-api",
			command: []string{"make", "eval"},
		},
		{
			name:    "bare workspace",
			args:    []string{"mumbo", "backend", "--", "npm", "test"},
			ref:     "mumbo",
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

func TestShouldSweepTrash(t *testing.T) {
	for cmd, want := range map[string]bool{"": true, "workspace": true, "rm": true, "uninstall": false} {
		if got := shouldSweepTrash(cmd); got != want {
			t.Errorf("shouldSweepTrash(%q) = %v, want %v", cmd, got, want)
		}
	}
}
