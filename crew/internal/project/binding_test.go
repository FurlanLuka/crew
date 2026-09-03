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

	Add(Project{Name: "speak-api", Path: "/p/speak-api", DevServers: []DevServer{
		{Name: "speak-api", Port: 3000, Command: "npm start"},
	}})
	Add(Project{Name: "mumbo", Path: "/p/mumbo", DevServers: []DevServer{
		{Name: "backend", Port: 3100, Command: "pnpm dev"},
		{Name: "homepage", Port: 3001, Command: "pnpm dev"},
	}})
	Add(Project{Name: "ai-tutor-api", Path: "/p/ai-tutor-api"})
}

func TestValidateBinding(t *testing.T) {
	setupPool(t)

	tests := []struct {
		name    string
		binding Binding
		wantErr string
	}{
		{name: "bare project reference", binding: Binding{Var: "A", Value: "{{url:speak-api}}"}},
		{name: "named server", binding: Binding{Var: "A", Value: "{{url:mumbo/backend}}"}},
		{name: "port inside a larger value", binding: Binding{Var: "A", Value: "ws://localhost:{{port:speak-api}}"}},
		{name: "identity tokens", binding: Binding{Var: "A", Value: "db_{{workspace}}_{{worktree}}"}},
		{name: "plain literal", binding: Binding{Var: "A", Value: "https://deployed"}},

		{name: "bad var name", binding: Binding{Var: "not-a-var", Value: "x"}, wantErr: "not a valid"},
		{name: "empty value", binding: Binding{Var: "A"}, wantErr: "no value"},
		{name: "unknown project", binding: Binding{Var: "A", Value: "{{url:ghost}}"}, wantErr: "no project 'ghost'"},
		{name: "unknown server", binding: Binding{Var: "A", Value: "{{url:mumbo/nope}}"}, wantErr: "no dev server"},
		{name: "ambiguous bare reference", binding: Binding{Var: "A", Value: "{{url:mumbo}}"}, wantErr: "name one"},
		{name: "target has no servers", binding: Binding{Var: "A", Value: "{{url:ai-tutor-api}}"}, wantErr: "no dev servers"},
		{name: "unknown token", binding: Binding{Var: "A", Value: "{{nope:x}}"}, wantErr: "unknown token"},
		{name: "argument on identity token", binding: Binding{Var: "A", Value: "{{worktree:x}}"}, wantErr: "takes no argument"},
		{name: "missing target", binding: Binding{Var: "A", Value: "{{url:}}"}, wantErr: "missing target"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateBinding("ai-tutor-api", tt.binding)

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

	err := ValidateBinding("ai-tutor-api", Binding{Var: "A", Value: "{{url:mumbo}}"})
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

	if err := AddBinding("ai-tutor-api", Binding{Var: "SPEAK_API_URL", Value: "{{url:speak-api}}"}); err != nil {
		t.Fatalf("AddBinding: %v", err)
	}

	p := Get("ai-tutor-api")
	if len(p.Bindings) != 1 || p.Bindings[0].Var != "SPEAK_API_URL" {
		t.Fatalf("bindings = %+v, want one for SPEAK_API_URL", p.Bindings)
	}

	// It survives a real read of projects.json, not just the in-memory value.
	data, _ := os.ReadFile(filepath.Join(config.ConfigDir, "projects.json"))
	if !strings.Contains(string(data), "SPEAK_API_URL") {
		t.Error("binding not persisted to projects.json")
	}
}

func TestAddBinding_ReplacesSameVar(t *testing.T) {
	setupPool(t)

	AddBinding("ai-tutor-api", Binding{Var: "A", Value: "{{url:speak-api}}"})
	if err := AddBinding("ai-tutor-api", Binding{Var: "A", Value: "{{url:mumbo/backend}}"}); err != nil {
		t.Fatalf("AddBinding: %v", err)
	}

	p := Get("ai-tutor-api")
	if len(p.Bindings) != 1 {
		t.Fatalf("bindings = %+v, want one — the same var replaces", p.Bindings)
	}
	if p.Bindings[0].Value != "{{url:mumbo/backend}}" {
		t.Errorf("value = %q, want the replacement", p.Bindings[0].Value)
	}
}

func TestRemoveBinding(t *testing.T) {
	setupPool(t)
	AddBinding("ai-tutor-api", Binding{Var: "A", Value: "{{url:speak-api}}"})

	if err := RemoveBinding("ai-tutor-api", "A"); err != nil {
		t.Fatalf("RemoveBinding: %v", err)
	}
	if p := Get("ai-tutor-api"); len(p.Bindings) != 0 {
		t.Errorf("bindings = %+v, want none", p.Bindings)
	}
	if err := RemoveBinding("ai-tutor-api", "A"); err == nil {
		t.Error("removing an absent binding should error")
	}
}

func TestConfiguredPorts(t *testing.T) {
	setupPool(t)
	ports := ConfiguredPorts()

	if got := ports[3000]; len(got) != 1 || got[0].Project != "speak-api" {
		t.Errorf("port 3000 = %+v, want speak-api", got)
	}
	if got := ports[3100]; len(got) != 1 || got[0].Server != "backend" {
		t.Errorf("port 3100 = %+v, want mumbo/backend", got)
	}
	if _, ok := ports[9999]; ok {
		t.Error("unconfigured port should be absent")
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
		"SPEAK_API_URL": "http://localhost:3000",
		"MUMBO_URL":     "http://localhost:3100",
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
		if err := AddBinding("ai-tutor-api", Binding{Var: p.Var, Value: p.Template}); err != nil {
			t.Errorf("proposal %s=%s rejected by the validator: %v", p.Var, p.Template, err)
		}
	}
	if got := Get("ai-tutor-api"); len(got.Bindings) != 3 {
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
	if err := AddBinding("ai-tutor-api", Binding{Var: proposals[0].Var, Value: proposals[0].Template}); err == nil {
		t.Error("MY-VAR should be rejected as a variable name")
	}
}
