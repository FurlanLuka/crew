package project

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
)

func setupPool(t *testing.T) {
	t.Helper()
	config.ConfigDir = t.TempDir()
	os.MkdirAll(config.ConfigDir, 0o755)

	Add(Project{Name: "store-api", Path: "/p/store-api", DevServers: []DevServer{
		{Name: "store-api", Port: 3000, Command: "npm start"},
	}})
	Add(Project{Name: "admin", Path: "/p/admin", DevServers: []DevServer{
		{Name: "backend", Port: 3100, Command: "pnpm dev"},
		{Name: "homepage", Port: 3001, Command: "pnpm dev"},
	}})
	Add(Project{Name: "checkout-api", Path: "/p/checkout-api"})
}

func TestValidateBinding(t *testing.T) {
	setupPool(t)

	tests := []struct {
		name    string
		binding Binding
		wantErr string
	}{
		{name: "bare project reference", binding: Binding{Var: "A", Value: "{{store-api}}"}},
		{name: "named server", binding: Binding{Var: "A", Value: "{{admin/backend}}"}},
		{name: "host inside a larger value", binding: Binding{Var: "A", Value: "ws://{{store-api.host}}/rtc"}},
		{name: "port on a named server", binding: Binding{Var: "A", Value: "{{admin/backend.port}}"}},
		{name: "legacy url form", binding: Binding{Var: "A", Value: "{{url:store-api}}"}},
		{name: "legacy port form", binding: Binding{Var: "A", Value: "ws://localhost:{{port:admin/backend}}"}},
		{name: "identity tokens", binding: Binding{Var: "A", Value: "db_{{workspace}}_{{worktree}}"}},
		{name: "plain literal", binding: Binding{Var: "A", Value: "https://deployed"}},

		{name: "bad var name", binding: Binding{Var: "not-a-var", Value: "x"}, wantErr: "not a valid"},
		{name: "empty value", binding: Binding{Var: "A"}, wantErr: "no value"},
		{name: "unknown project", binding: Binding{Var: "A", Value: "{{ghost}}"}, wantErr: "no project 'ghost'"},
		{name: "unknown server", binding: Binding{Var: "A", Value: "{{admin/nope}}"}, wantErr: "no dev server"},
		{name: "ambiguous bare reference", binding: Binding{Var: "A", Value: "{{admin}}"}, wantErr: "name one"},
		{name: "target has no servers", binding: Binding{Var: "A", Value: "{{checkout-api}}"}, wantErr: "no dev servers"},
		{name: "unknown legacy kind", binding: Binding{Var: "A", Value: "{{nope:x}}"}, wantErr: dev.GrammarHint},
		{name: "accessor on identity token", binding: Binding{Var: "A", Value: "{{worktree.host}}"}, wantErr: "takes no accessor"},
		{name: "dot where slash belongs", binding: Binding{Var: "A", Value: "{{admin.backend}}"}, wantErr: "a server is written {{admin/backend}}"},
		{name: "empty token", binding: Binding{Var: "A", Value: "{{}}"}, wantErr: dev.GrammarHint},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateBinding("checkout-api", tt.binding)

			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("ValidateBinding: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("want error mentioning %q, got none", tt.wantErr)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("error = %q, want it to mention %q", err, tt.wantErr)
			}
		})
	}
}

// The ambiguity message has to name the servers, or there is nothing to act on.
func TestValidateBinding_AmbiguityNamesTheServers(t *testing.T) {
	setupPool(t)

	err := ValidateBinding("checkout-api", Binding{Var: "A", Value: "{{url:admin}}"})
	if err == nil {
		t.Fatal("want an error")
	}
	for _, want := range []string{"backend", "homepage"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q should name server %q", err, want)
		}
	}
}

func TestAddBinding_RoundTrip(t *testing.T) {
	setupPool(t)

	if err := AddBinding("checkout-api", Binding{Var: "STORE_API_URL", Value: "{{url:store-api}}"}); err != nil {
		t.Fatalf("AddBinding: %v", err)
	}

	p := Get("checkout-api")
	if len(p.Bindings) != 1 || p.Bindings[0].Var != "STORE_API_URL" {
		t.Fatalf("bindings = %+v, want one for STORE_API_URL", p.Bindings)
	}

	// It survives a real read of projects.json, not just the in-memory value.
	data, _ := os.ReadFile(filepath.Join(config.ConfigDir, "projects.json"))
	if !strings.Contains(string(data), "STORE_API_URL") {
		t.Error("binding not persisted to projects.json")
	}
}

func TestAddBinding_ReplacesSameVar(t *testing.T) {
	setupPool(t)

	AddBinding("checkout-api", Binding{Var: "A", Value: "{{url:store-api}}"})
	if err := AddBinding("checkout-api", Binding{Var: "A", Value: "{{url:admin/backend}}"}); err != nil {
		t.Fatalf("AddBinding: %v", err)
	}

	p := Get("checkout-api")
	if len(p.Bindings) != 1 {
		t.Fatalf("bindings = %+v, want one — the same var replaces", p.Bindings)
	}
	if p.Bindings[0].Value != "{{url:admin/backend}}" {
		t.Errorf("value = %q, want the replacement", p.Bindings[0].Value)
	}
}

func TestRemoveBinding(t *testing.T) {
	setupPool(t)
	AddBinding("checkout-api", Binding{Var: "A", Value: "{{url:store-api}}"})

	if err := RemoveBinding("checkout-api", dev.BindingKey{Var: "A"}); err != nil {
		t.Fatalf("RemoveBinding: %v", err)
	}
	if p := Get("checkout-api"); len(p.Bindings) != 0 {
		t.Errorf("bindings = %+v, want none", p.Bindings)
	}
	if err := RemoveBinding("checkout-api", dev.BindingKey{Var: "A"}); err == nil {
		t.Error("removing an absent binding should error")
	}
}

func TestFindServer(t *testing.T) {
	setupPool(t)
	admin := Get("admin")
	if ds, err := FindServer("admin", admin.DevServers, "homepage"); err != nil || ds.Port != 3001 {
		t.Errorf("found = %+v, %v", ds, err)
	}
	if _, err := FindServer("admin", admin.DevServers, "nope"); err == nil || err.Error() != "project 'admin' has no dev server 'nope' (has: backend, homepage)" {
		t.Errorf("unknown: %v", err)
	}
	if _, err := FindServer("checkout-api", nil, "x"); err == nil || !strings.Contains(err.Error(), "(has: )") {
		t.Errorf("no servers: %v", err)
	}
}

// A binding's scope must name one of its own project's servers.
func TestValidateBinding_Scope(t *testing.T) {
	setupPool(t)
	if err := ValidateBinding("admin", Binding{Var: "A", Value: "{{store-api}}", Server: "backend"}); err != nil {
		t.Errorf("scoped to an existing server: %v", err)
	}
	if err := ValidateBinding("admin", Binding{Var: "A", Value: "{{store-api}}", Server: "nope"}); err == nil || !strings.Contains(err.Error(), "no dev server 'nope' (has: backend, homepage)") {
		t.Errorf("unknown server: %v", err)
	}
	if err := ValidateBinding("checkout-api", Binding{Var: "A", Value: "{{store-api}}", Server: "x"}); err == nil || !strings.Contains(err.Error(), "no dev server 'x'") {
		t.Errorf("project without servers: %v", err)
	}
	if err := ValidateBinding("admin", Binding{Var: "A", Value: "{{url:store-api}}", Server: "backend"}); err != nil {
		t.Errorf("scope and template grammar are independent: %v", err)
	}
}

// Identity is (var, server): a scoped and a project-wide binding on one var
// coexist, and each is replaced or removed on its own.
func TestBindings_ByIdentity(t *testing.T) {
	setupPool(t)
	pw := Binding{Var: "A", Value: "{{store-api}}"}
	scoped := Binding{Var: "A", Value: "{{admin/homepage}}", Server: "backend"}
	for _, b := range []Binding{pw, scoped} {
		if err := AddBinding("admin", b); err != nil {
			t.Fatal(err)
		}
	}
	if p := Get("admin"); len(p.Bindings) != 2 {
		t.Fatalf("both should be kept: %+v", p.Bindings)
	}
	scoped.Value = "{{store-api.host}}"
	AddBinding("admin", scoped)
	if p := Get("admin"); len(p.Bindings) != 2 || p.Bindings[1].Value != "{{store-api.host}}" || p.Bindings[0].Value != "{{store-api}}" {
		t.Errorf("the scoped one is replaced in place, the project-wide one untouched: %+v", p.Bindings)
	}

	data, _ := os.ReadFile(filepath.Join(config.ConfigDir, "projects.json"))
	if strings.Count(string(data), `"server": "backend"`) != 1 || strings.Contains(string(data), `"server": ""`) {
		t.Errorf("only the scoped binding writes a server key:\n%s", data)
	}

	if err := RemoveBinding("admin", dev.BindingKey{Var: "A", Server: "homepage"}); err == nil || !strings.Contains(err.Error(), "no binding for A scoped to homepage") {
		t.Errorf("unknown scope: %v", err)
	}
	if err := RemoveBinding("admin", dev.BindingKey{Var: "A", Server: "backend"}); err != nil {
		t.Fatal(err)
	}
	if p := Get("admin"); len(p.Bindings) != 1 || p.Bindings[0].Server != "" {
		t.Errorf("removing the scoped one leaves the project-wide one: %+v", p.Bindings)
	}

	AddBinding("admin", Binding{Var: "B", Value: "{{store-api}}", Server: "backend"})
	AddBinding("admin", Binding{Var: "B", Value: "{{store-api}}", Server: "homepage"})
	err := RemoveBinding("admin", dev.BindingKey{Var: "B"})
	if err == nil || err.Error() != "project 'admin' has B bound per server (backend, homepage) — crew rm binding <project>/<server> B" {
		t.Errorf("a bare removal of a var bound only per server names them: %v", err)
	}
	if p := Get("admin"); len(p.Bindings) != 3 {
		t.Errorf("nothing removed on the refusal: %+v", p.Bindings)
	}
}

// A projects.json from before scopes existed reads as project-wide.
func TestBindings_LegacyFileIsProjectWide(t *testing.T) {
	config.ConfigDir = t.TempDir()
	os.WriteFile(filepath.Join(config.ConfigDir, "projects.json"), []byte(`[{"name":"api","path":"/p/api","bindings":[{"var":"A","value":"x"}]}]`), 0o644)
	p := Get("api")
	if p == nil || len(p.Bindings) != 1 || p.Bindings[0].Server != "" || p.Bindings[0].Label() != "A" {
		t.Errorf("%+v", p)
	}
}

func TestScopedToAndBoundFor(t *testing.T) {
	bindings := []Binding{{Var: "A"}, {Var: "B", Server: "web"}, {Var: "C", Server: "worker"}, {Var: "D", Server: "web"}}
	got := ScopedTo(bindings, "web")
	if len(got) != 2 || got[0].Var != "B" || got[1].Var != "D" {
		t.Errorf("%+v", got)
	}
	if got := ScopedTo(bindings, ""); len(got) != 1 || got[0].Var != "A" {
		t.Errorf("the empty scope is the project-wide set: %+v", got)
	}
	if d := BoundFor(bindings, ""); !d["A"] || d["B"] {
		t.Errorf("root scan: %v", d)
	}
	if d := BoundFor(bindings, "web"); !d["A"] || !d["B"] || d["C"] {
		t.Errorf("web scan: %v", d)
	}
}

// Removing a server takes its scoped bindings with it in the same write;
// renaming one keeps them on the new name.
func TestRemoveAndRenameDevServer_Scopes(t *testing.T) {
	setupPool(t)
	AddBinding("admin", Binding{Var: "A", Value: "x"})
	AddBinding("admin", Binding{Var: "B", Value: "x", Server: "backend"})
	AddBinding("admin", Binding{Var: "C", Value: "x", Server: "homepage"})
	AddBinding("admin", Binding{Var: "D", Value: "x", Server: "backend"})

	if err := RenameDevServer("admin", "backend", DevServer{Name: "Web App", Port: 3100, Command: "pnpm dev"}); err == nil || !strings.Contains(err.Error(), "invalid") {
		t.Errorf("a rename keeps the name rule: %v", err)
	}
	if p := Get("admin"); p.DevServers[0].Name != "backend" {
		t.Errorf("a refused rename changes nothing: %+v", p.DevServers)
	}
	if err := RenameDevServer("admin", "backend", DevServer{Name: "api", Port: 3100, Command: "pnpm dev"}); err != nil {
		t.Fatal(err)
	}
	p := Get("admin")
	if len(p.DevServers) != 2 || p.DevServers[1].Name != "api" || p.Bindings[1].Server != "api" || p.Bindings[3].Server != "api" {
		t.Errorf("rename re-scopes: %+v / %+v", p.DevServers, p.Bindings)
	}

	dropped, err := RemoveDevServer("admin", "api")
	if err != nil || len(dropped) != 2 || dropped[0].Var != "B" || dropped[1].Var != "D" {
		t.Fatalf("dropped = %+v, %v", dropped, err)
	}
	p = Get("admin")
	if len(p.DevServers) != 1 || len(p.Bindings) != 2 || p.Bindings[0].Var != "A" || p.Bindings[1].Var != "C" {
		t.Errorf("the rest stays: %+v / %+v", p.DevServers, p.Bindings)
	}
	if dropped, err := RemoveDevServer("admin", "homepage"); err != nil || len(dropped) != 1 {
		t.Errorf("%+v, %v", dropped, err)
	}
	if dropped, err := RemoveDevServer("store-api", "store-api"); err != nil || dropped != nil {
		t.Errorf("no scoped bindings: %+v, %v", dropped, err)
	}
}

// A scoped scan reads the server's own dir in every checkout, and nothing
// else.
func TestScanEnv_Subdir(t *testing.T) {
	setupPool(t)
	checkout := t.TempDir()
	os.WriteFile(filepath.Join(checkout, ".env"), []byte("ROOT=http://localhost:3000\n"), 0o644)
	os.MkdirAll(filepath.Join(checkout, "apps", "web"), 0o755)
	os.WriteFile(filepath.Join(checkout, "apps", "web", ".env"), []byte("WEB=http://localhost:3100\n"), 0o644)
	dirs := []string{checkout, filepath.Join(checkout, "missing")}

	if got := ScanEnv(dirs, "apps/web"); len(got) != 1 || got["WEB"] != "http://localhost:3100" {
		t.Errorf("subdir scan = %v", got)
	}
	if got := ScanEnv(dirs, ""); len(got) != 1 || got["ROOT"] != "http://localhost:3000" {
		t.Errorf("root scan = %v", got)
	}
}

func TestConfiguredPorts(t *testing.T) {
	setupPool(t)
	ports := ConfiguredPorts()

	if got := ports[3000]; len(got) != 1 || got[0].Project != "store-api" {
		t.Errorf("port 3000 = %+v, want store-api", got)
	}
	if got := ports[3100]; len(got) != 1 || got[0].Server != "backend" {
		t.Errorf("port 3100 = %+v, want admin/backend", got)
	}
	if _, ok := ports[9999]; ok {
		t.Error("unconfigured port should be absent")
	}
	// Servers without a port are not on any port — two of them do not
	// collide on 0.
	Add(Project{Name: "signals", Path: "/repos/signals", DevServers: []DevServer{{Name: "worker", Command: "a"}, {Name: "cron", Command: "b"}}})
	if _, ok := ConfiguredPorts()[0]; ok {
		t.Error("port-less servers should not key on 0")
	}
}

// Two projects on the same port is what makes a proposal ambiguous rather than
// a guess.
func TestConfiguredPorts_Collision(t *testing.T) {
	setupPool(t)
	Add(Project{Name: "other", Path: "/p/other", DevServers: []DevServer{
		{Name: "web", Port: 3000, Command: "x"},
	}})

	if got := ConfiguredPorts()[3000]; len(got) != 2 {
		t.Errorf("port 3000 claimed by %+v, want both projects", got)
	}
}

// The scan and the validator count servers independently; every non-ambiguous
// proposal has to be one the validator accepts, or --apply fails on its own
// output.
func TestProposeThenAdd_EveryProposalValidates(t *testing.T) {
	setupPool(t)

	proposals := dev.ProposeBindings(map[string]string{
		"STORE_API_URL": "http://localhost:3000",
		"ADMIN_URL":     "http://localhost:3100",
		"HOMEPAGE_WS":   "ws://localhost:3001/live",
	}, ConfiguredPorts())

	if len(proposals) != 3 {
		t.Fatalf("got %d proposals, want 3", len(proposals))
	}
	for _, p := range proposals {
		if p.Ambiguous {
			t.Errorf("%s unexpectedly ambiguous", p.Var)
			continue
		}
		if err := AddBinding("checkout-api", Binding{Var: p.Var, Value: p.Template}); err != nil {
			t.Errorf("proposal %s=%s rejected by the validator: %v", p.Var, p.Template, err)
		}
	}
	if got := Get("checkout-api"); len(got.Bindings) != 3 {
		t.Errorf("bindings = %+v, want all three applied", got.Bindings)
	}
}

// ParseEnvFile accepts keys the validator rejects; --apply has to report the
// rejection rather than abort the run.
func TestProposeThenAdd_RejectsUnusableVarName(t *testing.T) {
	setupPool(t)

	proposals := dev.ProposeBindings(dev.ParseEnvFile("MY-VAR=http://localhost:3000"), ConfiguredPorts())
	if len(proposals) != 1 {
		t.Fatalf("got %d proposals, want 1 — the scan itself does not validate names", len(proposals))
	}
	if err := AddBinding("checkout-api", Binding{Var: proposals[0].Var, Value: proposals[0].Template}); err == nil {
		t.Error("MY-VAR should be rejected as a variable name")
	}
}

func TestWithDevServers(t *testing.T) {
	pool := []Project{{Name: "docs"}, {Name: "api", DevServers: []DevServer{{Name: "api", Port: 3000}}}, {Name: "web", DevServers: []DevServer{{Name: "web", Port: 5173}}},
		{Name: "jobs", DevServers: []DevServer{{Name: "worker"}}},                             // workers only: not a target
		{Name: "mixed", DevServers: []DevServer{{Name: "worker"}, {Name: "web", Port: 3001}}}} // one server with a port: a target
	got := WithDevServers(pool)
	if len(got) != 3 || got[0].Name != "api" || got[1].Name != "web" || got[2].Name != "mixed" {
		t.Errorf("%+v", got)
	}
	if got := WithDevServers(nil); got != nil {
		t.Errorf("empty pool → %+v", got)
	}
}

// A server with no port is not a target: refused where the binding is
// written, not at start time.
func TestValidateBinding_PortlessTarget(t *testing.T) {
	setupPool(t)
	Add(Project{Name: "signals", Path: "/repos/signals", DevServers: []DevServer{{Name: "worker", Command: "a"}}})
	Add(Project{Name: "jobs", Path: "/repos/jobs", DevServers: []DevServer{{Name: "worker", Command: "a"}, {Name: "web", Port: 3000, Command: "b"}}})
	if err := ValidateBinding("store-api", Binding{Var: "X", Value: "{{signals/worker}}"}); err == nil || !strings.Contains(err.Error(), "has no port") {
		t.Errorf("named port-less server: %v", err)
	}
	if err := ValidateBinding("store-api", Binding{Var: "X", Value: "{{signals}}"}); err == nil || !strings.Contains(err.Error(), "no dev server with a port") {
		t.Errorf("project with only port-less servers: %v", err)
	}
	// The one server with a port makes the bare reference unambiguous.
	if err := ValidateBinding("store-api", Binding{Var: "X", Value: "{{jobs}}"}); err != nil {
		t.Errorf("bare ref with one listening server: %v", err)
	}
}
