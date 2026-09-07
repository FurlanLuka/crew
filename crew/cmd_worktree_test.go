package main

import (
	"github.com/FurlanLuka/crew/crew/internal/workspace"
	"strings"
	"testing"
)

func TestBindingValue(t *testing.T) {
	tests := []struct {
		name                   string
		url, host, port, value string
		want, wantErr          string
	}{
		{name: "url shorthand", url: "speak-api", want: "{{speak-api}}"},
		{name: "url with server", url: "mumbo/backend", want: "{{mumbo/backend}}"},
		{name: "host shorthand", host: "livekit", want: "{{livekit.host}}"},
		{name: "port with server", port: "mumbo/backend", want: "{{mumbo/backend.port}}"},
		{name: "value verbatim", value: "ws://{{livekit.host}}/rtc", want: "ws://{{livekit.host}}/rtc"},
		{name: "nothing given", wantErr: "give one of"},
		{name: "two given", url: "a", port: "b", wantErr: "give one of"},
		{name: "bad target", url: "a/b/c", wantErr: "--url=a/b/c: expected project or project/server"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := bindingValue(tt.url, tt.host, tt.port, tt.value)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want it to mention %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("bindingValue: %v", err)
			}
			if got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestWorktreeRow(t *testing.T) {
	tests := []struct {
		name     string
		size     int64
		withSize bool
		running  bool
		want     string
	}{
		{"plain", 0, false, false, "ws/wt\t/p\t"},
		{"running", 0, false, true, "ws/wt\t/p\tdev"},
		{"size", 161 << 30, true, false, "ws/wt\t/p\t161 GB\t"},
		{"size and running", 226 << 20, true, true, "ws/wt\t/p\t226 MB\tdev"},
	}
	if got := worktreeRow("ws/wt", "/p", 0, false, false, "server died: api/api"); got != "ws/wt\t/p\t\tserver died: api/api" {
		t.Errorf("health column: %q", got)
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := worktreeRow("ws/wt", "/p", tt.size, tt.withSize, tt.running, ""); got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestHealthWarningLineAndCreationSummary(t *testing.T) {
	ref := workspace.Ref{Workspace: "ws", Worktree: "wt"}
	res := &workspace.Resolved{Ref: ref, Projects: []workspace.ResolvedProject{{Name: "api", Path: "/w/api"}}}
	if got := healthWarningLine(res); got != "" {
		t.Errorf("no health: %q", got)
	}
	res.Health = &workspace.Health{Issues: []workspace.Issue{{Stage: workspace.StageInstall, Project: "api", Detail: "a\nb\nc\nd\ne\nf"}}}
	if got := healthWarningLine(res); got != "! ws/wt: install failed: api — crew fix ws/wt / crew verify ws/wt\n" {
		t.Errorf("warning = %q", got)
	}

	text, failed := renderCreationSummary(res, "Created ws/wt", res.Health)
	want := strings.Join([]string{
		"",
		"Created ws/wt — install failed: api",
		"",
		"  api\t/w/api",
		"",
		"  ! install   api",
		"      c",
		"      d",
		"      e",
		"      f",
		"    crew fix ws/wt     Claude in the worktree with this failure",
		"    crew verify ws/wt  finish what is missing and check again",
		"",
	}, "\n")
	if !failed || text != want {
		t.Errorf("failed=%v summary =\n%s\nwant\n%s", failed, text, want)
	}
	text, failed = renderCreationSummary(res, "Created ws/wt", nil)
	if failed || !strings.Contains(text, "crew launch ws/wt") || strings.Contains(text, "!") {
		t.Errorf("clean summary =\n%s", text)
	}
}
