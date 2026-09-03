package dev

import (
	"strings"
	"testing"
)

// A worktree holding speak-api (one server) and mumbo (two, one of them also
// called "api" — legal, since server names are unique only within a project).
func bindingFixture(bindings map[string][]Binding) ResolveParams {
	projects := []DevProject{
		{
			Name:       "speak-api",
			DevServers: []DevServerConfig{{Name: "speak-api", Port: 3000}},
			Bindings:   bindings["speak-api"],
		},
		{
			Name: "mumbo",
			DevServers: []DevServerConfig{
				{Name: "api", Port: 3100},
				{Name: "homepage", Port: 3001},
			},
			Bindings: bindings["mumbo"],
		},
		{
			Name:       "ai-tutor-api",
			DevServers: []DevServerConfig{{Name: "ai-tutor-api", Port: 8000}},
			Bindings:   bindings["ai-tutor-api"],
		},
	}

	return ResolveParams{
		Projects:  projects,
		Workspace: "phone-speak",
		Worktree:  "wrk2",
		Ports: map[ProjectServer]int{
			{Project: "speak-api", Server: "speak-api"}:       54021,
			{Project: "mumbo", Server: "api"}:                 54030,
			{Project: "mumbo", Server: "homepage"}:            54031,
			{Project: "ai-tutor-api", Server: "ai-tutor-api"}: 54088,
		},
	}
}

func find(t *testing.T, rs []Resolution, project, name string) Resolution {
	t.Helper()
	for _, r := range rs {
		if r.Project == project && r.Var == name {
			return r
		}
	}
	t.Fatalf("no resolution for %s/%s in %+v", project, name, rs)
	return Resolution{}
}

func TestResolveBindings_URLTemplate(t *testing.T) {
	p := bindingFixture(map[string][]Binding{
		"ai-tutor-api": {{Var: "SPEAK_API_URL", Value: "{{url:speak-api}}"}},
	})

	got := find(t, ResolveBindings(p), "ai-tutor-api", "SPEAK_API_URL")
	if got.Source != SourceBinding {
		t.Errorf("Source = %s, want binding", got.Source)
	}
	if got.Value != "http://localhost:54021" {
		t.Errorf("Value = %q, want http://localhost:54021", got.Value)
	}
	if got.Detail != "from speak-api" {
		t.Errorf("Detail = %q, want %q", got.Detail, "from speak-api")
	}
}

// The whole point of Route.Project: two projects both expose "api", and the
// binding has to reach the one it named.
func TestResolveBindings_SameServerNameAcrossProjects(t *testing.T) {
	p := bindingFixture(map[string][]Binding{
		"ai-tutor-api": {{Var: "MUMBO_API_URL", Value: "{{url:mumbo/api}}"}},
	})

	got := find(t, ResolveBindings(p), "ai-tutor-api", "MUMBO_API_URL")
	if got.Value != "http://localhost:54030" {
		t.Errorf("Value = %q, want mumbo/api's port 54030", got.Value)
	}
}

func TestResolveBindings_PortInsideLargerValue(t *testing.T) {
	p := bindingFixture(map[string][]Binding{
		"ai-tutor-api": {{Var: "LIVEKIT_URL", Value: "ws://localhost:{{port:mumbo/homepage}}/rtc"}},
	})

	got := find(t, ResolveBindings(p), "ai-tutor-api", "LIVEKIT_URL")
	if got.Value != "ws://localhost:54031/rtc" {
		t.Errorf("Value = %q, want ws://localhost:54031/rtc", got.Value)
	}
}

func TestResolveBindings_IdentityTokens(t *testing.T) {
	p := bindingFixture(map[string][]Binding{
		"ai-tutor-api": {
			{Var: "LIVEKIT_AGENT_NAME", Value: "{{worktree}}"},
			{Var: "DUMP_DIR", Value: "/tmp/turns/{{workspace}}-{{worktree}}"},
			{Var: "PLAIN", Value: "no tokens here"},
		},
	})
	rs := ResolveBindings(p)

	for _, tt := range []struct{ name, want string }{
		{"LIVEKIT_AGENT_NAME", "wrk2"},
		{"DUMP_DIR", "/tmp/turns/phone-speak-wrk2"},
		{"PLAIN", "no tokens here"},
	} {
		if got := find(t, rs, "ai-tutor-api", tt.name); got.Value != tt.want {
			t.Errorf("%s = %q, want %q", tt.name, got.Value, tt.want)
		}
	}
}

func TestResolveBindings_UnresolvableTargets(t *testing.T) {
	tests := []struct {
		name       string
		value      string
		wantDetail string
	}{
		{"project not in worktree", "{{url:speak-partner}}", "not in workspace"},
		{"named server not running", "{{url:speak-api/other}}", "is not running"},
		{"bare ref is ambiguous", "{{url:mumbo}}", "name one"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := bindingFixture(map[string][]Binding{
				"ai-tutor-api": {{Var: "TARGET", Value: tt.value}},
			})

			got := find(t, ResolveBindings(p), "ai-tutor-api", "TARGET")
			if got.Source != SourceUnresolved {
				t.Errorf("Source = %s, want unresolved", got.Source)
			}
			if got.Value != "" {
				t.Errorf("Value = %q, want empty", got.Value)
			}
			if !strings.Contains(got.Detail, tt.wantDetail) {
				t.Errorf("Detail = %q, want it to mention %q", got.Detail, tt.wantDetail)
			}
		})
	}
}

// A value that expands halfway is the silently-wrong URL this feature exists to
// prevent, so a failing token discards the whole thing.
func TestResolveBindings_PartialExpansionDiscardsWholeValue(t *testing.T) {
	p := bindingFixture(map[string][]Binding{
		"ai-tutor-api": {{Var: "COMBINED", Value: "{{url:speak-api}}/from/{{url:speak-partner}}"}},
	})

	got := find(t, ResolveBindings(p), "ai-tutor-api", "COMBINED")
	if got.Source != SourceUnresolved {
		t.Fatalf("Source = %s, want unresolved", got.Source)
	}
	if strings.Contains(got.Value, "54021") {
		t.Errorf("Value = %q — a half-expanded value must never survive", got.Value)
	}
}

func TestResolveBindings_OverrideBeatsResolvableBinding(t *testing.T) {
	p := bindingFixture(map[string][]Binding{
		"ai-tutor-api": {{Var: "SPEAK_API_URL", Value: "{{url:speak-api}}"}},
	})
	p.Overrides = map[string]string{"SPEAK_API_URL": "https://dev-api.speak.com"}

	got := find(t, ResolveBindings(p), "ai-tutor-api", "SPEAK_API_URL")
	if got.Source != SourceOverride {
		t.Errorf("Source = %s, want override", got.Source)
	}
	if got.Value != "https://dev-api.speak.com" {
		t.Errorf("Value = %q, want the override", got.Value)
	}
}

func TestResolveBindings_QualifiedOverrideBeatsBare(t *testing.T) {
	p := bindingFixture(map[string][]Binding{
		"ai-tutor-api": {{Var: "API_URL", Value: "{{url:speak-api}}"}},
		"mumbo":        {{Var: "API_URL", Value: "{{url:speak-api}}"}},
	})
	p.Overrides = map[string]string{
		"API_URL":              "https://shared",
		"ai-tutor-api.API_URL": "https://tutor-only",
	}
	rs := ResolveBindings(p)

	if got := find(t, rs, "ai-tutor-api", "API_URL"); got.Value != "https://tutor-only" {
		t.Errorf("qualified override = %q, want https://tutor-only", got.Value)
	}
	if got := find(t, rs, "mumbo", "API_URL"); got.Value != "https://shared" {
		t.Errorf("bare override = %q, want https://shared", got.Value)
	}
}

// Empty is a legitimate override value, so Source rather than Value has to be
// what distinguishes "set to empty" from "left alone".
func TestResolveBindings_EmptyOverrideIsNotUnresolved(t *testing.T) {
	p := bindingFixture(map[string][]Binding{
		"ai-tutor-api": {{Var: "SPEAK_API_URL", Value: "{{url:speak-api}}"}},
	})
	p.Overrides = map[string]string{"SPEAK_API_URL": ""}

	got := find(t, ResolveBindings(p), "ai-tutor-api", "SPEAK_API_URL")
	if got.Source != SourceOverride || !got.Resolved() {
		t.Errorf("empty override reported as %s (resolved=%v), want a resolved override",
			got.Source, got.Resolved())
	}
	if got.Value != "" {
		t.Errorf("Value = %q, want empty", got.Value)
	}
}

// An override is "set this here", not "amend that binding" — it applies even
// when nothing declared the variable.
func TestResolveBindings_OverrideWithoutBindingStillApplies(t *testing.T) {
	p := bindingFixture(nil)
	p.Overrides = map[string]string{"ai-tutor-api.EXTRA": "value"}

	got := find(t, ResolveBindings(p), "ai-tutor-api", "EXTRA")
	if got.Source != SourceOverride || got.Value != "value" {
		t.Errorf("got %+v, want a resolved override", got)
	}
}

// An unresolvable binding silenced by an override is the acknowledgement
// mechanism: it stops printing as an anomaly on every start.
func TestResolveBindings_OverrideSilencesUnresolvableBinding(t *testing.T) {
	p := bindingFixture(map[string][]Binding{
		"ai-tutor-api": {{Var: "GONE", Value: "{{url:speak-partner}}"}},
	})
	p.Overrides = map[string]string{"GONE": "https://deployed"}

	got := find(t, ResolveBindings(p), "ai-tutor-api", "GONE")
	if got.Source != SourceOverride {
		t.Errorf("Source = %s, want override to win over an unresolvable binding", got.Source)
	}
}

func TestResolveBindings_SelfReference(t *testing.T) {
	p := bindingFixture(map[string][]Binding{
		"ai-tutor-api": {{Var: "SELF_URL", Value: "{{url:ai-tutor-api}}"}},
	})

	got := find(t, ResolveBindings(p), "ai-tutor-api", "SELF_URL")
	if got.Value != "http://localhost:54088" {
		t.Errorf("Value = %q, want its own port", got.Value)
	}
}

// Hand-edited projects.json can declare a variable twice. Last wins, pinned so
// it is a decision rather than an accident of map ordering.
func TestResolveBindings_DuplicateVarLastWins(t *testing.T) {
	p := bindingFixture(map[string][]Binding{
		"ai-tutor-api": {
			{Var: "DUP", Value: "first"},
			{Var: "DUP", Value: "second"},
		},
	})

	var seen []string
	for _, r := range ResolveBindings(p) {
		if r.Var == "DUP" {
			seen = append(seen, r.Value)
		}
	}
	if len(seen) == 0 {
		t.Fatal("no DUP resolution")
	}
	if seen[len(seen)-1] != "second" {
		t.Errorf("last DUP = %q, want %q", seen[len(seen)-1], "second")
	}
}

// In no-proxy mode servers bind their configured ports, and resolution has to
// follow them there.
func TestResolveBindings_NoProxyPorts(t *testing.T) {
	projects := []DevProject{
		{Name: "speak-api", DevServers: []DevServerConfig{{Name: "speak-api", Port: 3000}}},
		{Name: "ai-tutor-api", Bindings: []Binding{{Var: "SPEAK_API_URL", Value: "{{url:speak-api}}"}}},
	}
	planned := PlanServers(projects, nil, true)

	rs := ResolveBindings(ResolveParams{
		Projects:  projects,
		Ports:     IndexPorts(planned),
		Workspace: "ws",
		Worktree:  "wrk1",
	})

	if got := find(t, rs, "ai-tutor-api", "SPEAK_API_URL"); got.Value != "http://localhost:3000" {
		t.Errorf("Value = %q, want the configured port in no-proxy mode", got.Value)
	}
}

func TestIndexRoutePorts(t *testing.T) {
	ports := IndexRoutePorts([]Route{
		{Project: "speak-api", ServerName: "speak-api", InternalPort: 54021},
		{Project: "mumbo", ServerName: "api", InternalPort: 54030},
	})

	if got := ports[ProjectServer{Project: "mumbo", Server: "api"}]; got != 54030 {
		t.Errorf("mumbo/api = %d, want 54030", got)
	}
	if _, ok := ports[ProjectServer{Project: "speak-api", Server: "api"}]; ok {
		t.Error("speak-api/api should not exist — only mumbo owns a server named api")
	}
}

func TestEnvPrefix(t *testing.T) {
	tests := []struct {
		name        string
		resolutions []Resolution
		want        string
	}{
		{"nothing resolved", nil, ""},
		{
			"unresolved is skipped",
			[]Resolution{{Var: "GONE", Source: SourceUnresolved}},
			"",
		},
		{
			"exports rather than inline assignment",
			[]Resolution{{Var: "SPEAK_API_URL", Value: "http://localhost:54021", Source: SourceBinding}},
			"export SPEAK_API_URL='http://localhost:54021'; ",
		},
		{
			"quotes a value with spaces",
			[]Resolution{{Var: "NAME", Value: "a b", Source: SourceOverride}},
			"export NAME='a b'; ",
		},
		{
			"quotes an embedded single quote",
			[]Resolution{{Var: "MSG", Value: "it's", Source: SourceOverride}},
			`export MSG='it'"'"'s'; `,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := EnvPrefix(tt.resolutions); got != tt.want {
				t.Errorf("EnvPrefix = %q, want %q", got, tt.want)
			}
		})
	}
}

// A project with no bindings must produce exactly the command line crew built
// before any of this existed.
func TestEnvPrefix_NoBindingsLeavesCommandByteIdentical(t *testing.T) {
	if prefix := EnvPrefix(nil); prefix+buildServerCommand("npm run start", 54021) != "PORT=54021 npm run start" {
		t.Errorf("command = %q, want the unprefixed form", prefix+buildServerCommand("npm run start", 54021))
	}
}
