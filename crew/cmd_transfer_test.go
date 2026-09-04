package main

import (
	"strings"
	"testing"
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
