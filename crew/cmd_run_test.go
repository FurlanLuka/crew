package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// A resolved worktree of one monorepo (web, worker) and its sibling api,
// with one binding scoped to web — no I/O beyond the fixture.
func monoResolved() *workspace.Resolved {
	ref := workspace.Ref{Workspace: "ws", Worktree: "wrk1"}
	return &workspace.Resolved{
		Ref:  ref,
		Slug: ref.Slug(),
		Projects: []workspace.ResolvedProject{
			{Name: "mono", Path: "/w/mono", DevServers: []project.DevServer{{Name: "web", Port: 3000}, {Name: "worker", Port: 3001}},
				Bindings: []project.Binding{{Var: "QUEUE_URL", Value: "amqp://q"}, {Var: "API_URL", Value: "{{api}}", Server: "web"}}},
			{Name: "api", Path: "/w/api", DevServers: []project.DevServer{{Name: "api", Port: 8000}}},
		},
		Ports: map[string]int{"mono/web": 54040, "mono/worker": 54041, "api/api": 54021},
	}
}

// envVars names the rows a target gets; nothing runs in this fixture, so a
// sibling URL is a row left alone, which is still the right row.
func envVars(rs []dev.Resolution) string {
	var out []string
	for _, r := range rs {
		out = append(out, r.Label())
	}
	return strings.Join(out, ",")
}

// <project> is the project-wide set, <project>/<server> that server's;
// an unknown server or project is refused by name.
func TestResolveTarget(t *testing.T) {
	res := monoResolved()
	rows := dev.ResolveBindings(res.ResolveParams(nil))
	pw, err := resolveTarget(res, rows, "mono")
	if err != nil || envVars(pw.Env()) != "QUEUE_URL" {
		t.Errorf("bare project = %s, %v", envVars(pw.Env()), err)
	}
	web, err := resolveTarget(res, rows, "mono/web")
	if err != nil || envVars(web.Env()) != "QUEUE_URL,API_URL (web)" {
		t.Errorf("mono/web = %s, %v", envVars(web.Env()), err)
	}
	worker, err := resolveTarget(res, rows, "mono/worker")
	if err != nil || envVars(worker.Env()) != "QUEUE_URL" {
		t.Errorf("mono/worker = %s, %v", envVars(worker.Env()), err)
	}
	if _, err := resolveTarget(res, rows, "mono/typo"); err == nil || !strings.Contains(err.Error(), "no dev server 'typo' (has: web, worker)") {
		t.Errorf("unknown server: %v", err)
	}
	if _, err := resolveTarget(res, rows, "nope"); err == nil || !strings.Contains(err.Error(), "not in ws/wrk1") {
		t.Errorf("unknown project: %v", err)
	}
	if _, err := resolveTarget(res, rows, "mono/web/x"); err == nil {
		t.Error("a malformed target is refused")
	}
	if got := scopedHint(pw); !strings.Contains(got, "bound per server (web)") || !strings.Contains(got, "crew env ws/wrk1 mono/web") {
		t.Errorf("hint under the bare project: %q", got)
	}
	if got := scopedHint(web); got != "" {
		t.Errorf("no hint on a server's own set: %q", got)
	}
}

func TestParseBindingArgs(t *testing.T) {
	a, err := parseBindingArgs([]string{"--var=X", "--url=api/web"})
	if err != nil || a.varName != "X" || a.url != "api/web" || a.scan {
		t.Errorf("%+v, %v", a, err)
	}
	a, err = parseBindingArgs([]string{"--scan", "--apply"})
	if err != nil || !a.scan || !a.apply {
		t.Errorf("%+v, %v", a, err)
	}
	if _, err := parseBindingArgs([]string{"--server=web"}); err == nil || !strings.Contains(err.Error(), "unknown flag") {
		t.Errorf("the scope is the argument, not a flag: %v", err)
	}
}

func TestBindingRows(t *testing.T) {
	bindings := []project.Binding{{Var: "X", Value: "{{api}}"}, {Var: "X", Value: "{{api.host}}", Server: "web"}}
	resolved := map[dev.BindingKey]dev.Resolution{
		{Var: "X"}:                {Var: "X", Value: "http://localhost:1", Source: dev.SourceBinding},
		{Var: "X", Server: "web"}: {Var: "X", Server: "web", Source: dev.SourceUnresolved, Detail: "api not in workspace"},
	}
	rows := bindingRows(bindings, resolved)
	if got := rows[0].line(); got != "X\t-\t{{api}}\thttp://localhost:1" {
		t.Errorf("project-wide row = %q", got)
	}
	if got := rows[1].line(); got != "X\tweb\t{{api.host}}\tleft alone — api not in workspace" {
		t.Errorf("scoped row = %q", got)
	}
	if got := bindingRows(bindings, nil)[1].line(); got != "X\tweb\t{{api.host}}" {
		t.Errorf("without --check: %q", got)
	}
	if data, _ := json.MarshalIndent(bindingRows(bindings[:1], nil), "", "  "); !strings.Contains(string(data), `"server": ""`) {
		t.Errorf("server is always present in the document: %s", data)
	}
	if got := bindingRows(nil, nil); got == nil || len(got) != 0 {
		t.Error("no bindings is an empty list, never null")
	}
}

func TestStillBoundNote(t *testing.T) {
	bindings := []project.Binding{{Var: "X"}, {Var: "X", Server: "web"}, {Var: "X", Server: "worker"}, {Var: "Y"}}
	if got := stillBoundNote(bindings, "X", ""); got != " (still bound for web, worker)" {
		t.Errorf("%q", got)
	}
	if got := stillBoundNote(bindings, "X", "web"); got != " (still bound for all servers, worker)" {
		t.Errorf("%q", got)
	}
	if got := stillBoundNote(bindings, "Y", ""); got != "" {
		t.Errorf("%q", got)
	}
	if got := stillBoundNote(nil, "X", ""); got != "" {
		t.Errorf("%q", got)
	}
}
