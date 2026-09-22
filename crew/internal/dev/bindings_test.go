package dev

import (
	"strings"
	"testing"
)

// A worktree holding store-api (one server) and admin (two, one of them also
// called "api" — legal, since server names are unique only within a project).
func bindingFixture(bindings map[string][]Binding) ResolveParams {
	projects := []DevProject{
		{
			Name:       "store-api",
			DevServers: []DevServerConfig{{Name: "store-api", Port: 3000}},
			Bindings:   bindings["store-api"],
		},
		{
			Name: "admin",
			DevServers: []DevServerConfig{
				{Name: "api", Port: 3100},
				{Name: "homepage", Port: 3001},
			},
			Bindings: bindings["admin"],
		},
		{
			Name:       "checkout-api",
			DevServers: []DevServerConfig{{Name: "checkout-api", Port: 8000}},
			Bindings:   bindings["checkout-api"],
		},
		{
			// A worker: runs, never listens — nothing to point at.
			Name:       "signals",
			DevServers: []DevServerConfig{{Name: "worker"}},
		},
	}

	return ResolveParams{
		Projects:  projects,
		Workspace: "store-front",
		Worktree:  "wrk2",
		Ports: map[ProjectServer]int{
			{Project: "store-api", Server: "store-api"}:       54021,
			{Project: "admin", Server: "api"}:                 54030,
			{Project: "admin", Server: "homepage"}:            54031,
			{Project: "checkout-api", Server: "checkout-api"}: 54088,
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
		"checkout-api": {{Var: "STORE_API_URL", Value: "{{url:store-api}}"}},
	})

	got := find(t, ResolveBindings(p), "checkout-api", "STORE_API_URL")
	if got.Source != SourceBinding {
		t.Errorf("Source = %s, want binding", got.Source)
	}
	if got.Value != "http://localhost:54021" {
		t.Errorf("Value = %q, want http://localhost:54021", got.Value)
	}
	if got.Detail != "from store-api" {
		t.Errorf("Detail = %q, want %q", got.Detail, "from store-api")
	}
}

// The whole point of Route.Project: two projects both expose "api", and the
// binding has to reach the one it named.
func TestResolveBindings_SameServerNameAcrossProjects(t *testing.T) {
	p := bindingFixture(map[string][]Binding{
		"checkout-api": {{Var: "ADMIN_API_URL", Value: "{{url:admin/api}}"}},
	})

	got := find(t, ResolveBindings(p), "checkout-api", "ADMIN_API_URL")
	if got.Value != "http://localhost:54030" {
		t.Errorf("Value = %q, want admin/api's port 54030", got.Value)
	}
}

func TestResolveBindings_PortInsideLargerValue(t *testing.T) {
	p := bindingFixture(map[string][]Binding{
		"checkout-api": {{Var: "SIGNALS_URL", Value: "ws://localhost:{{port:admin/homepage}}/rtc"}},
	})

	got := find(t, ResolveBindings(p), "checkout-api", "SIGNALS_URL")
	if got.Value != "ws://localhost:54031/rtc" {
		t.Errorf("Value = %q, want ws://localhost:54031/rtc", got.Value)
	}
}

func TestResolveBindings_IdentityTokens(t *testing.T) {
	p := bindingFixture(map[string][]Binding{
		"checkout-api": {
			{Var: "SIGNALS_AGENT_NAME", Value: "{{worktree}}"},
			{Var: "DUMP_DIR", Value: "/tmp/turns/{{workspace}}-{{worktree}}"},
			{Var: "PLAIN", Value: "no tokens here"},
		},
	})
	rs := ResolveBindings(p)

	for _, tt := range []struct{ name, want string }{
		{"SIGNALS_AGENT_NAME", "wrk2"},
		{"DUMP_DIR", "/tmp/turns/store-front-wrk2"},
		{"PLAIN", "no tokens here"},
	} {
		if got := find(t, rs, "checkout-api", tt.name); got.Value != tt.want {
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
		{"project not in worktree", "{{url:store-partner}}", "not in workspace"},
		{"named server not running", "{{url:store-api/other}}", "is not running"},
		{"bare ref is ambiguous", "{{url:admin}}", "name one"},
		{"server has no port", "{{signals/worker}}", "has no port"},
		{"project has only portless servers", "{{signals}}", "signals has no port"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := bindingFixture(map[string][]Binding{
				"checkout-api": {{Var: "TARGET", Value: tt.value}},
			})

			got := find(t, ResolveBindings(p), "checkout-api", "TARGET")
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
		"checkout-api": {{Var: "COMBINED", Value: "{{url:store-api}}/from/{{url:store-partner}}"}},
	})

	got := find(t, ResolveBindings(p), "checkout-api", "COMBINED")
	if got.Source != SourceUnresolved {
		t.Fatalf("Source = %s, want unresolved", got.Source)
	}
	if strings.Contains(got.Value, "54021") {
		t.Errorf("Value = %q — a half-expanded value must never survive", got.Value)
	}
}

func TestResolveBindings_OverrideBeatsResolvableBinding(t *testing.T) {
	p := bindingFixture(map[string][]Binding{
		"checkout-api": {{Var: "STORE_API_URL", Value: "{{url:store-api}}"}},
	})
	p.Overrides = map[string]string{"STORE_API_URL": "https://dev-api.store.com"}

	got := find(t, ResolveBindings(p), "checkout-api", "STORE_API_URL")
	if got.Source != SourceOverride {
		t.Errorf("Source = %s, want override", got.Source)
	}
	if got.Value != "https://dev-api.store.com" {
		t.Errorf("Value = %q, want the override", got.Value)
	}
}

func TestResolveBindings_QualifiedOverrideBeatsBare(t *testing.T) {
	p := bindingFixture(map[string][]Binding{
		"checkout-api": {{Var: "API_URL", Value: "{{url:store-api}}"}},
		"admin":        {{Var: "API_URL", Value: "{{url:store-api}}"}},
	})
	p.Overrides = map[string]string{
		"API_URL":              "https://shared",
		"checkout-api.API_URL": "https://tutor-only",
	}
	rs := ResolveBindings(p)

	if got := find(t, rs, "checkout-api", "API_URL"); got.Value != "https://tutor-only" {
		t.Errorf("qualified override = %q, want https://tutor-only", got.Value)
	}
	if got := find(t, rs, "admin", "API_URL"); got.Value != "https://shared" {
		t.Errorf("bare override = %q, want https://shared", got.Value)
	}
}

// Empty is a legitimate override value, so Source rather than Value has to be
// what distinguishes "set to empty" from "left alone".
func TestResolveBindings_EmptyOverrideIsNotUnresolved(t *testing.T) {
	p := bindingFixture(map[string][]Binding{
		"checkout-api": {{Var: "STORE_API_URL", Value: "{{url:store-api}}"}},
	})
	p.Overrides = map[string]string{"STORE_API_URL": ""}

	got := find(t, ResolveBindings(p), "checkout-api", "STORE_API_URL")
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
	p.Overrides = map[string]string{"checkout-api.EXTRA": "value"}

	got := find(t, ResolveBindings(p), "checkout-api", "EXTRA")
	if got.Source != SourceOverride || got.Value != "value" {
		t.Errorf("got %+v, want a resolved override", got)
	}
}

// An unresolvable binding silenced by an override is the acknowledgement
// mechanism: it stops printing as an anomaly on every start.
func TestResolveBindings_OverrideSilencesUnresolvableBinding(t *testing.T) {
	p := bindingFixture(map[string][]Binding{
		"checkout-api": {{Var: "GONE", Value: "{{url:store-partner}}"}},
	})
	p.Overrides = map[string]string{"GONE": "https://deployed"}

	got := find(t, ResolveBindings(p), "checkout-api", "GONE")
	if got.Source != SourceOverride {
		t.Errorf("Source = %s, want override to win over an unresolvable binding", got.Source)
	}
}

func TestResolveBindings_SelfReference(t *testing.T) {
	p := bindingFixture(map[string][]Binding{
		"checkout-api": {{Var: "SELF_URL", Value: "{{url:checkout-api}}"}},
	})

	got := find(t, ResolveBindings(p), "checkout-api", "SELF_URL")
	if got.Value != "http://localhost:54088" {
		t.Errorf("Value = %q, want its own port", got.Value)
	}
}

// Hand-edited projects.json can declare a variable twice. Last wins, pinned so
// it is a decision rather than an accident of map ordering.
func TestResolveBindings_DuplicateVarLastWins(t *testing.T) {
	p := bindingFixture(map[string][]Binding{
		"checkout-api": {
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

// No-proxy mode allocates like proxy mode does; resolution follows the
// allocated port, never the configured one.
func TestResolveBindings_NoProxyPorts(t *testing.T) {
	projects := []DevProject{
		{Name: "store-api", DevServers: []DevServerConfig{{Name: "store-api", Port: 3000}}},
		{Name: "checkout-api", Bindings: []Binding{{Var: "STORE_API_URL", Value: "{{url:store-api}}"}}},
	}
	planned := PlanServers(projects, []int{54021}, true)

	rs := ResolveBindings(ResolveParams{
		Projects:  projects,
		Ports:     IndexPorts(planned),
		Workspace: "ws",
		Worktree:  "wrk1",
	})

	if got := find(t, rs, "checkout-api", "STORE_API_URL"); got.Value != "http://localhost:54021" {
		t.Errorf("Value = %q, want the allocated port, not the configured 3000", got.Value)
	}
}

func TestIndexRoutePorts(t *testing.T) {
	ports := IndexRoutePorts([]Route{
		{Project: "store-api", ServerName: "store-api", InternalPort: 54021},
		{Project: "admin", ServerName: "api", InternalPort: 54030},
	})

	if got := ports[ProjectServer{Project: "admin", Server: "api"}]; got != 54030 {
		t.Errorf("admin/api = %d, want 54030", got)
	}
	if _, ok := ports[ProjectServer{Project: "store-api", Server: "api"}]; ok {
		t.Error("store-api/api should not exist — only admin owns a server named api")
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
			[]Resolution{{Var: "STORE_API_URL", Value: "http://localhost:54021", Source: SourceBinding}},
			"export STORE_API_URL='http://localhost:54021'; ",
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

// Unqualified overrides come from a map; the export prefix and the env table
// must not reshuffle between runs.
func TestResolveBindings_OverrideOrderIsStable(t *testing.T) {
	p := bindingFixture(nil)
	p.Overrides = map[string]string{"Z": "1", "A": "2", "M": "3", "B": "4"}

	first := ResolveBindings(p)
	for i := 0; i < 50; i++ {
		again := ResolveBindings(p)
		for j := range first {
			if again[j].Var != first[j].Var || again[j].Project != first[j].Project {
				t.Fatalf("run %d reordered: %+v vs %+v", i, again[j], first[j])
			}
		}
	}

	var vars []string
	for _, r := range first {
		if r.Project == "store-api" {
			vars = append(vars, r.Var)
		}
	}
	if strings.Join(vars, "") != "ABMZ" {
		t.Errorf("order = %v, want sorted", vars)
	}
}

// A route file written before Route.Project existed cannot say which project
// owns a server, so two "api" routes would collapse to one key — exactly the
// silent wrong-port binding this exists to prevent. Skip them instead.
func TestIndexRoutePorts_LegacyRoutesDoNotResolve(t *testing.T) {
	ports := IndexRoutePorts([]Route{
		{ServerName: "api", InternalPort: 54001},
		{ServerName: "api", InternalPort: 54002},
		{Project: "admin", ServerName: "api", InternalPort: 54003},
	})

	if len(ports) != 1 {
		t.Fatalf("ports = %+v, want only the project-tagged route", ports)
	}
	if _, ok := ports[ProjectServer{Project: "", Server: "api"}]; ok {
		t.Error("legacy route indexed under an empty project")
	}

	p := bindingFixture(map[string][]Binding{
		"checkout-api": {{Var: "STORE_API_URL", Value: "{{url:store-api}}"}},
	})
	p.Ports = ports
	if got := find(t, ResolveBindings(p), "checkout-api", "STORE_API_URL"); got.Source != SourceUnresolved {
		t.Errorf("Source = %s, want unresolved against a legacy route file", got.Source)
	}
}

func TestParseTokens(t *testing.T) {
	target := func(proj, server, accessor string) Token {
		return Token{Kind: TokenTarget, Target: TargetRef{Project: proj, Server: server, HasServer: server != ""}, Accessor: accessor}
	}

	tests := []struct {
		in   string
		want Token
	}{
		{"{{store-api}}", target("store-api", "", AccessorURL)},
		{"{{store-api.url}}", target("store-api", "", AccessorURL)},
		{"{{store-api.host}}", target("store-api", "", AccessorHost)},
		{"{{store-api.port}}", target("store-api", "", AccessorPort)},
		{"{{admin/backend}}", target("admin", "backend", AccessorURL)},
		{"{{admin/backend.port}}", target("admin", "backend", AccessorPort)},
		{"{{worktree}}", Token{Kind: TokenWorktree}},
		{"{{workspace}}", Token{Kind: TokenWorkspace}},
		// Pre-2.1 spelling, still read.
		{"{{url:store-api}}", target("store-api", "", AccessorURL)},
		{"{{port:signals}}", target("signals", "", AccessorPort)},
		{"{{url:admin/backend}}", target("admin", "backend", AccessorURL)},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			tokens, err := ParseTokens("x-" + tt.in + "-y")
			if err != nil {
				t.Fatalf("ParseTokens: %v", err)
			}
			tt.want.Raw = tt.in
			if len(tokens) != 1 || tokens[0] != tt.want {
				t.Errorf("tokens = %+v, want %+v", tokens, tt.want)
			}
		})
	}
}

func TestParseTokens_Malformed(t *testing.T) {
	tests := []struct {
		in      string
		wantErr string
	}{
		{"{{}}", GrammarHint},
		{"{{store-api.}}", GrammarHint},
		{"{{.port}}", "expected project or project/server"},
		{"{{store-api/}}", "expected project or project/server"},
		{"{{a/b/c}}", "expected project or project/server"},
		{"{{worktree:}}", GrammarHint},
		{"{{ws:x}}", GrammarHint},
		{"{{url:}}", GrammarHint},
		{"{{worktree.host}}", "{{worktree}} takes no accessor"},
		{"{{workspace.port}}", "{{workspace}} takes no accessor"},
		{"{{store-api.foo}}", ".foo is not url, host or port — a server is written {{store-api/foo}}"},
		{"{{checkout-api.worker}}", "a server is written {{checkout-api/worker}}"},
		{"{{a.b.port}}", ".b.port is not url, host or port"},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			_, err := ParseTokens(tt.in)
			if err == nil {
				t.Fatalf("ParseTokens(%q) accepted it", tt.in)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("error = %q, want it to mention %q", err, tt.wantErr)
			}
			if !strings.HasPrefix(err.Error(), tt.in+": ") {
				t.Errorf("error = %q, want it prefixed with the token", err)
			}
		})
	}
}

func TestParseTokens_MultipleInOneValue(t *testing.T) {
	tokens, err := ParseTokens("ws://{{signals.host}}/x/{{worktree}}")
	if err != nil {
		t.Fatal(err)
	}
	if len(tokens) != 2 || tokens[0].Raw != "{{signals.host}}" || tokens[1].Raw != "{{worktree}}" {
		t.Errorf("tokens = %+v", tokens)
	}
}

// TokenFor is the only writer; whatever it spells must read back identically,
// and never in the legacy form.
func TestTokenFor_RoundTrips(t *testing.T) {
	targets := []TargetRef{
		{Project: "store-api"},
		{Project: "admin", Server: "backend", HasServer: true},
	}
	for _, target := range targets {
		for _, accessor := range []string{"", AccessorURL, AccessorHost, AccessorPort} {
			spelled := TokenFor(target, accessor)
			if IsLegacyToken(spelled) || strings.Contains(spelled, ".url") {
				t.Errorf("TokenFor(%+v, %q) = %q", target, accessor, spelled)
			}
			tokens, err := ParseTokens(spelled)
			if err != nil || len(tokens) != 1 {
				t.Fatalf("ParseTokens(%q) = %+v, %v", spelled, tokens, err)
			}
			wantAccessor := accessor
			if wantAccessor == "" {
				wantAccessor = AccessorURL
			}
			if tokens[0].Target != target || tokens[0].Accessor != wantAccessor {
				t.Errorf("ParseTokens(%q) = %+v", spelled, tokens[0])
			}
		}
	}
}

func TestIsLegacyToken(t *testing.T) {
	tests := map[string]bool{
		"{{url:store-api}}":         true,
		"ws://localhost:{{port:x}}": true,
		"{{store-api}}":             false,
		"ws://{{store-api.host}}":   false,
		"{{worktree}}":              false,
		"literal":                   false,
	}
	for in, want := range tests {
		if got := IsLegacyToken(in); got != want {
			t.Errorf("IsLegacyToken(%q) = %v, want %v", in, got, want)
		}
	}
}

// The new spelling resolves to exactly what the legacy one did, value and
// description alike, since saved bindings keep the old form indefinitely.
func TestResolveBindings_NewFormMatchesLegacy(t *testing.T) {
	pairs := []struct{ legacy, modern string }{
		{"{{url:store-api}}", "{{store-api}}"},
		{"ws://localhost:{{port:store-api}}/rtc", "ws://{{store-api.host}}/rtc"},
		{"{{port:admin/api}}", "{{admin/api.port}}"},
		{"{{url:admin/api}}", "{{admin/api}}"},
	}
	for _, pair := range pairs {
		t.Run(pair.modern, func(t *testing.T) {
			resolve := func(value string) Resolution {
				p := bindingFixture(map[string][]Binding{
					"checkout-api": {{Var: "V", Value: value}},
				})
				return find(t, ResolveBindings(p), "checkout-api", "V")
			}
			legacy, modern := resolve(pair.legacy), resolve(pair.modern)
			if !modern.Resolved() {
				t.Fatalf("%s left alone: %s", pair.modern, modern.Detail)
			}
			if modern.Value != legacy.Value || modern.Detail != legacy.Detail {
				t.Errorf("%s = (%q, %q), legacy %s = (%q, %q)",
					pair.modern, modern.Value, modern.Detail, pair.legacy, legacy.Value, legacy.Detail)
			}
		})
	}
}

func TestIndexReservedPorts(t *testing.T) {
	got := IndexReservedPorts(map[string]int{"store-api/store-api": 54021, "admin/api": 54030, "junk": 1})
	want := map[ProjectServer]int{
		{Project: "store-api", Server: "store-api"}: 54021,
		{Project: "admin", Server: "api"}:           54030,
	}
	if len(got) != len(want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%+v = %d, want %d", k, got[k], v)
		}
	}
}
