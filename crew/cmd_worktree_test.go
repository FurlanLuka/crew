package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

func TestBindingValue(t *testing.T) {
	tests := []struct {
		name                   string
		url, host, port, value string
		want, wantErr          string
	}{
		{name: "url shorthand", url: "store-api", want: "{{store-api}}"},
		{name: "url with server", url: "admin/backend", want: "{{admin/backend}}"},
		{name: "host shorthand", host: "signals", want: "{{signals.host}}"},
		{name: "port with server", port: "admin/backend", want: "{{admin/backend.port}}"},
		{name: "value verbatim", value: "ws://{{signals.host}}/rtc", want: "ws://{{signals.host}}/rtc"},
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
	if got := worktreeRow("ws/wt", "/p", 0, false, false, false, "server died: api/api"); got != "ws/wt\t/p\t\tserver died: api/api" {
		t.Errorf("health column: %q", got)
	}
	if got := worktreeRow("ws/wt", "/p", 0, false, false, true, ""); got != "ws/wt\t/p\tinstalling" {
		t.Errorf("installing column: %q", got)
	}
	if got := worktreeRow("ws/wt", "/p", 0, false, true, true, ""); got != "ws/wt\t/p\tdev" {
		t.Errorf("dev wins over installing: %q", got)
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := worktreeRow("ws/wt", "/p", tt.size, tt.withSize, tt.running, false, ""); got != tt.want {
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

	text := renderCreationSummary(res, "Created ws/wt", res.Health)
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
	if text != want {
		t.Errorf("summary =\n%s\nwant\n%s", text, want)
	}
	text = renderCreationSummary(res, "Created ws/wt", nil)
	if !strings.Contains(text, "crew launch ws/wt") || strings.Contains(text, "!") {
		t.Errorf("clean summary =\n%s", text)
	}
}

// The status document an agent polls: every list a list, the verdict
// flags alongside, the health as recorded.
func TestJSONStatus_ListsNeverNull(t *testing.T) {
	st := workspace.Status{Ref: workspace.Ref{Workspace: "ws", Worktree: "wt"}, Projects: []workspace.ProjectStatus{{Project: "api", State: workspace.StateRunning}}}
	data, _ := json.Marshal(jsonStatus(st, nil))
	for _, want := range []string{`"steps":[]`, `"issues":[]`, `"running":true`, `"failed":false`, `"ref":"ws/wt"`, `"health":null`} {
		if !strings.Contains(string(data), want) {
			t.Errorf("missing %s in %s", want, data)
		}
	}
	if data, _ := json.Marshal(jsonStatus(workspace.Status{}, nil)); !strings.Contains(string(data), `"projects":[]`) {
		t.Errorf("no projects → %s", data)
	}
}

// The creation documents an agent parses: the keys promised in the skill,
// every list a list.
func TestCreationDocs(t *testing.T) {
	ref := workspace.Ref{Workspace: "ws", Worktree: "wt"}
	started, _ := json.Marshal(startedDoc(ref, projectsOut(&workspace.Resolved{})))
	if string(started) != `{"projects":[],"ref":"ws/wt","running":true}` {
		t.Errorf("started = %s", started)
	}
	finished, _ := json.Marshal(finishedDoc(ref, []projOut{{"api", "/p/api"}}, nil))
	if string(finished) != `{"health":null,"projects":[{"name":"api","path":"/p/api"}],"ref":"ws/wt"}` {
		t.Errorf("finished = %s", finished)
	}
	logs, _ := json.Marshal(logsDoc(ref, "api", ""))
	if string(logs) != `{"lines":[],"project":"api","ref":"ws/wt"}` {
		t.Errorf("empty logs = %s", logs)
	}
	logs, _ = json.Marshal(logsDoc(ref, "api", "a\nb"))
	if !strings.Contains(string(logs), `"lines":["a","b"]`) {
		t.Errorf("logs = %s", logs)
	}
	h := &workspace.Health{Issues: []workspace.Issue{{Stage: workspace.StageInstall, Project: "api", Detail: "x"}}}
	if got := renderVerdict(ref, h, "checks out"); !strings.Contains(got, "! install   api") || !strings.Contains(got, "crew fix ws/wt") {
		t.Errorf("verdict with issues = %q", got)
	}
	if got := renderVerdict(ref, nil, "checks out"); got != "\nws/wt checks out\n" {
		t.Errorf("clean verdict = %q", got)
	}
}

func TestRenderStarted(t *testing.T) {
	got := renderStarted(workspace.Ref{Workspace: "ws", Worktree: "wt"}, "Created ws/wt", 3)
	want := "Created ws/wt — 3 projects installing in the background.\n  crew setup status ws/wt [--wait]   what each runner has done; --wait stays until every one is done\n  crew setup logs ws/wt <project>    what an install is printing\n"
	if got != want {
		t.Errorf("got\n%s\nwant\n%s", got, want)
	}
}

func TestParseSetupArgs(t *testing.T) {
	f, err := parseSetupArgs([]string{"--no-smoke", "--wait", "api", "web"}, true)
	if err != nil || !f.install || f.smoke || !f.wait || strings.Join(f.projects, ",") != "api,web" {
		t.Errorf("flags = %+v, %v", f, err)
	}
	if _, err := parseSetupArgs([]string{"api"}, false); err == nil {
		t.Error("a project where none is allowed must be refused")
	}
	if _, err := parseSetupArgs([]string{"--nope"}, true); err == nil {
		t.Error("unknown flag must be refused")
	}
	// No install, nothing to smoke.
	if o := (setupFlags{install: false, smoke: true}).checkoutOptions(); o.Install || o.Smoke {
		t.Errorf("--no-install must also skip the smoke: %+v", o)
	}
}
