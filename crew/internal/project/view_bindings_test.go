package project

import (
	"regexp"
	"strings"
	"testing"
)

var ansi = regexp.MustCompile(`\x1b\[[0-9;]*m`)

func TestRenderTokenLegend_Golden(t *testing.T) {
	targets := []Project{
		{Name: "speak-api", DevServers: []DevServer{{Name: "speak-api", Port: 3000}}},
		{Name: "ai-tutor-api", DevServers: []DevServer{{Name: "api", Port: 8000}, {Name: "worker", Port: 8001}}},
	}

	var b strings.Builder
	renderTokenLegend(&b, targets)
	got := ansi.ReplaceAllString(b.String(), "")

	want := strings.Join([]string{
		"  Tokens",
		"    {{url:PROJECT}}           http://localhost:<port> of that project's server   {{url:speak-api}}",
		"    {{port:PROJECT/SERVER}}   the port alone — for any other scheme, or a path   ws://localhost:{{port:livekit}}/rtc",
		"    {{worktree}}              this worktree's name                               agent-{{worktree}}",
		"    {{workspace}}             this workspace's name                              db_{{workspace}}_{{worktree}}",
		"    SERVER is optional when the project has one server. A value without tokens is used as-is.",
		"",
		"  Projects",
		"    speak-api     speak-api :3000",
		"    ai-tutor-api  api :8000  worker :8001",
		"",
	}, "\n")

	if got != want {
		t.Errorf("legend =\n%s\nwant\n%s", got, want)
	}
}

func TestRenderTokenLegend_NoTargets(t *testing.T) {
	var b strings.Builder
	renderTokenLegend(&b, nil)
	got := ansi.ReplaceAllString(b.String(), "")
	if !strings.Contains(got, "none with dev servers yet") {
		t.Errorf("legend without targets =\n%s", got)
	}
}
