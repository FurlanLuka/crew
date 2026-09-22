package dev

import (
	"reflect"
	"strings"
	"testing"
)

// mono is a monorepo registered as one project with two servers; api is the
// sibling its web server needs and its worker does not.
func monoFixture(mono []Binding, overrides map[string]string) ResolveParams {
	return ResolveParams{
		Projects: []DevProject{
			{Name: "mono", DevServers: []DevServerConfig{{Name: "web", Port: 3000}, {Name: "worker", Port: 3001}}, Bindings: mono},
			{Name: "api", DevServers: []DevServerConfig{{Name: "api", Port: 8000}}},
		},
		Ports: map[ProjectServer]int{
			{Project: "mono", Server: "web"}:    54040,
			{Project: "mono", Server: "worker"}: 54041,
			{Project: "api", Server: "api"}:     54021,
		},
		Workspace: "ws", Worktree: "wrk1", Overrides: overrides,
	}
}

func web() ProjectServer    { return ProjectServer{Project: "mono", Server: "web"} }
func worker() ProjectServer { return ProjectServer{Project: "mono", Server: "worker"} }

func vars(rs []Resolution) string {
	var out []string
	for _, r := range rs {
		v := r.Label() + "=" + r.Value
		if !r.Resolved() {
			v = r.Label() + "!" + r.Detail
		}
		out = append(out, v)
	}
	return strings.Join(out, ",")
}

// With no scoped binding anywhere the resolver's output is what it was —
// and EnvFor is the project's rows unchanged.
func TestScope_NoScopeIsUnchanged(t *testing.T) {
	p := monoFixture([]Binding{{Var: "API_URL", Value: "{{api}}"}, {Var: "QUEUE", Value: "amqp://q"}}, nil)
	rs := ResolveBindings(p)
	for _, r := range rs {
		if r.Server != "" {
			t.Errorf("no binding was scoped, got %+v", r)
		}
	}
	group := GroupResolutions(rs)["mono"]
	for _, target := range []ProjectServer{web(), worker(), {Project: "mono"}} {
		if got := EnvFor(rs, target); !reflect.DeepEqual(got, group) {
			t.Errorf("EnvFor(%+v) = %v, want the project's rows %v", target, vars(got), vars(group))
		}
	}
}

func TestScope_ScopedRowsAndEnvFor(t *testing.T) {
	for _, tt := range []struct {
		name        string
		mono        []Binding
		web, worker string
		projectWide string
	}{
		{"scoped only", []Binding{{Var: "API_URL", Value: "{{api}}", Server: "web"}},
			"API_URL (web)=http://localhost:54021", "", ""},
		{"scoped replaces project-wide in place", []Binding{{Var: "A", Value: "1"}, {Var: "API_URL", Value: "x"}, {Var: "B", Value: "2"}, {Var: "API_URL", Value: "{{api}}", Server: "web"}},
			"A=1,API_URL (web)=http://localhost:54021,B=2", "A=1,API_URL=x,B=2", "A=1,API_URL=x,B=2"},
		{"scoped declared first", []Binding{{Var: "API_URL", Value: "{{api}}", Server: "web"}, {Var: "API_URL", Value: "x"}},
			"API_URL (web)=http://localhost:54021", "API_URL=x", "API_URL=x"},
		{"scoped-only var absent elsewhere", []Binding{{Var: "Q", Value: "amqp://q", Server: "worker"}},
			"", "Q (worker)=amqp://q", ""},
		{"project-wide duplicates kept", []Binding{{Var: "D", Value: "first"}, {Var: "D", Value: "second"}},
			"D=first,D=second", "D=first,D=second", "D=first,D=second"},
		{"scoped over duplicates replaces the first, the last export still wins", []Binding{{Var: "D", Value: "first"}, {Var: "D", Value: "second"}, {Var: "D", Value: "web", Server: "web"}},
			"D=first,D (web)=web", "D=first,D=second", "D=first,D=second"},
		{"unresolved scoped leaves the var alone, no fallback", []Binding{{Var: "API_URL", Value: "x"}, {Var: "API_URL", Value: "{{ghost}}", Server: "web"}},
			"API_URL (web)!ghost not in workspace", "API_URL=x", "API_URL=x"},
		{"dangling scope is unresolved", []Binding{{Var: "API_URL", Value: "{{api}}", Server: "gone"}},
			"", "", ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			rs := ResolveBindings(monoFixture(tt.mono, nil))
			if got := vars(EnvFor(rs, web())); got != tt.web {
				t.Errorf("web = %s, want %s", got, tt.web)
			}
			if got := vars(EnvFor(rs, worker())); got != tt.worker {
				t.Errorf("worker = %s, want %s", got, tt.worker)
			}
			if got := vars(EnvFor(rs, ProjectServer{Project: "mono"})); got != tt.projectWide {
				t.Errorf("project-wide = %s, want %s", got, tt.projectWide)
			}
		})
	}
}

func TestScope_DanglingServerIsNamed(t *testing.T) {
	rs := ResolveBindings(monoFixture([]Binding{{Var: "API_URL", Value: "{{api}}", Server: "gone"}}, nil))
	if len(rs) != 1 || rs[0].Resolved() || rs[0].Server != "gone" || rs[0].Detail != "no dev server 'gone' on mono" {
		t.Errorf("rows = %+v", rs)
	}
	if got := EnvFor(rs, ProjectServer{Project: "mono", Server: "gone"}); len(got) != 1 || got[0].Resolved() {
		t.Errorf("the dangling row is the server's own, unresolved: %+v", got)
	}
}

// An override is per var: it beats a scoped binding as it beats a
// project-wide one, and both rows carry it.
func TestScope_OverrideBeatsBothScopes(t *testing.T) {
	rs := ResolveBindings(monoFixture([]Binding{{Var: "API_URL", Value: "x"}, {Var: "API_URL", Value: "{{api}}", Server: "web"}}, map[string]string{"mono.API_URL": "o"}))
	if got := vars(EnvFor(rs, web())); got != "API_URL (web)=o" {
		t.Errorf("web = %s", got)
	}
	if got := vars(EnvFor(rs, worker())); got != "API_URL=o" {
		t.Errorf("worker = %s", got)
	}
	for _, r := range rs {
		if r.Source != SourceOverride {
			t.Errorf("%+v should be the override", r)
		}
	}

	// A var bound only for one server: the override is worktree-wide, so
	// the other server gets it too, as the extra row an undeclared var gets.
	rs = ResolveBindings(monoFixture([]Binding{{Var: "API_URL", Value: "{{api}}", Server: "web"}}, map[string]string{"mono.API_URL": "o"}))
	if got := vars(EnvFor(rs, web())); got != "API_URL (web)=o" {
		t.Errorf("web = %s", got)
	}
	if got := vars(EnvFor(rs, worker())); got != "API_URL=o" {
		t.Errorf("worker = %s", got)
	}
}

func TestScope_EnvForFiltersProjectsAndUnknownServer(t *testing.T) {
	rs := []Resolution{
		{Project: "mono", Var: "A", Value: "1", Source: SourceBinding},
		{Project: "mono", Var: "A", Value: "2", Server: "web", Source: SourceBinding},
		{Project: "api", Var: "A", Value: "3", Source: SourceBinding},
	}
	if got := vars(EnvFor(rs, ProjectServer{Project: "mono", Server: "zzz"})); got != "A=1" {
		t.Errorf("unknown server gets the project-wide set: %s", got)
	}
	if got := vars(EnvFor(rs, ProjectServer{Project: "api", Server: "api"})); got != "A=3" {
		t.Errorf("other projects' rows are dropped: %s", got)
	}
	if got := EnvFor(nil, web()); got != nil {
		t.Errorf("nothing in, nothing out: %v", got)
	}
}

func TestResolution_LabelAndKey(t *testing.T) {
	if got := (Resolution{Var: "A"}).Label(); got != "A" {
		t.Errorf("%q", got)
	}
	if got := (Resolution{Var: "A", Server: "web"}).Label(); got != "A (web)" {
		t.Errorf("%q", got)
	}
	if (Binding{Var: "A", Server: "web"}).Key() != (Resolution{Var: "A", Server: "web"}).Key() {
		t.Error("a binding and its row share the key")
	}
	if (Binding{Var: "A"}).Key() == (Binding{Var: "A", Server: "web"}).Key() {
		t.Error("scope is part of the identity")
	}
}

// One scoped var: the two windows of one project get different prefixes.
func TestServerCommand_PerWindow(t *testing.T) {
	rs := ResolveBindings(monoFixture([]Binding{{Var: "QUEUE_URL", Value: "amqp://x"}, {Var: "API_URL", Value: "{{api}}", Server: "web"}}, nil))
	webPlanned := PlannedServer{Project: "mono", Server: DevServerConfig{Name: "web", Command: "npm run web"}, Route: Route{InternalPort: 54040}}
	workerPlanned := PlannedServer{Project: "mono", Server: DevServerConfig{Name: "worker", Command: "npm run worker"}, Route: Route{InternalPort: 54041}}
	if got := ServerCommand(webPlanned, EnvFor(rs, web())); got != "export QUEUE_URL='amqp://x'; export API_URL='http://localhost:54021'; PORT=54040 npm run web" {
		t.Errorf("web: %s", got)
	}
	if got := ServerCommand(workerPlanned, EnvFor(rs, worker())); got != "export QUEUE_URL='amqp://x'; PORT=54041 npm run worker" {
		t.Errorf("worker: %s", got)
	}
}

func TestScopedServers(t *testing.T) {
	rs := []Resolution{{Var: "A"}, {Var: "B", Server: "web"}, {Var: "C", Server: "web"}, {Var: "D", Server: "worker"}}
	if got := strings.Join(ScopedServers(rs), ","); got != "web,worker" {
		t.Errorf("%s", got)
	}
	if got := ScopedServers([]Resolution{{Var: "A"}}); got != nil {
		t.Errorf("%v", got)
	}
}

// A var injected for one server only still reaches the other from the env
// file, so its file value is not harmless there.
func TestInjectedEverywhere(t *testing.T) {
	mono := DevProject{Name: "mono", DevServers: []DevServerConfig{{Name: "web"}, {Name: "worker"}}}
	rs := []Resolution{
		{Project: "mono", Var: "BOTH", Value: "1", Source: SourceBinding},
		{Project: "mono", Var: "WEB_ONLY", Value: "2", Server: "web", Source: SourceBinding},
		{Project: "mono", Var: "EACH", Value: "3", Server: "web", Source: SourceBinding},
		{Project: "mono", Var: "EACH", Value: "4", Server: "worker", Source: SourceBinding},
		{Project: "api", Var: "OTHER", Value: "5", Source: SourceBinding},
	}
	if got := vars(injectedEverywhere(rs, mono)); got != "BOTH=1,EACH (web)=3" {
		t.Errorf("injected everywhere = %s", got)
	}
	none := DevProject{Name: "mono"}
	if got := vars(injectedEverywhere(rs, none)); got != "BOTH=1" {
		t.Errorf("a project without servers: %s", got)
	}
	// An unresolved row on one side, or a duplicate, must not count.
	rs = []Resolution{
		{Project: "mono", Var: "X", Value: "1", Source: SourceBinding},
		{Project: "mono", Var: "X", Server: "web", Source: SourceUnresolved, Detail: "ghost"},
		{Project: "mono", Var: "Y", Value: "a", Server: "web", Source: SourceBinding},
		{Project: "mono", Var: "Y", Server: "worker", Source: SourceUnresolved, Detail: "ghost"},
		{Project: "mono", Var: "DUP", Value: "1", Source: SourceBinding},
		{Project: "mono", Var: "DUP", Value: "2", Source: SourceBinding},
	}
	if got := vars(injectedEverywhere(rs, mono)); got != "DUP=1" {
		t.Errorf("unresolved on one side is not injected everywhere; a duplicate counts once: %s", got)
	}
}
