package dev

import "testing"

func configuredFixture() map[int][]ProjectServer {
	return map[int][]ProjectServer{
		3000: {{Project: "speak-api", Server: "speak-api"}},
		8000: {{Project: "ai-tutor-api", Server: "ai-tutor-api"}},
		3100: {{Project: "mumbo", Server: "backend"}},
		3001: {{Project: "mumbo", Server: "homepage"}},
	}
}

func TestProposeBindings(t *testing.T) {
	proposals := ProposeBindings(map[string]string{
		"SPEAK_API_URL":      "http://localhost:3000",
		"SELF_URL":           "http://localhost:8000",
		"MUMBO_URL":          "http://localhost:3100",
		"UNKNOWN_PORT":       "http://localhost:9999",
		"BRAINTRUST_API_KEY": "sk-abcdef",
		"DEPLOYED":           "https://dev-api.speak.com",
	}, configuredFixture())

	byVar := map[string]Proposal{}
	for _, p := range proposals {
		byVar[p.Var] = p
	}

	// A configured port becomes a proposal naming the project that claims it,
	// and takes the bare form when that project owns one server.
	if got := byVar["SPEAK_API_URL"]; got.Template != "{{speak-api}}" {
		t.Errorf("SPEAK_API_URL template = %q, want {{speak-api}}", got.Template)
	}

	// Pointing at your own dev server is a legitimate binding, not a mistake.
	if got := byVar["SELF_URL"]; got.Template != "{{ai-tutor-api}}" {
		t.Errorf("SELF_URL template = %q, want the self reference proposed", got.Template)
	}

	// mumbo owns two servers, so the bare form would be ambiguous.
	if got := byVar["MUMBO_URL"]; got.Template != "{{mumbo/backend}}" {
		t.Errorf("MUMBO_URL template = %q, want the server named", got.Template)
	}

	for _, absent := range []string{"UNKNOWN_PORT", "BRAINTRUST_API_KEY", "DEPLOYED"} {
		if _, ok := byVar[absent]; ok {
			t.Errorf("%s should not be proposed", absent)
		}
	}
}

// Two projects configured on the same port cannot be resolved by guessing, so
// the proposal says so rather than picking one.
func TestProposeBindings_AmbiguousPort(t *testing.T) {
	configured := map[int][]ProjectServer{
		3000: {
			{Project: "speak-api", Server: "speak-api"},
			{Project: "mumbo", Server: "homepage"},
		},
	}

	proposals := ProposeBindings(map[string]string{"API_URL": "http://localhost:3000"}, configured)
	if len(proposals) != 1 {
		t.Fatalf("got %d proposals, want 1", len(proposals))
	}
	if !proposals[0].Ambiguous {
		t.Error("a port claimed by two projects should be marked ambiguous")
	}
	if proposals[0].Template != "" {
		t.Errorf("template = %q, want none for an ambiguous port", proposals[0].Template)
	}
	if proposals[0].Port != 3000 {
		t.Errorf("Port = %d, want 3000", proposals[0].Port)
	}
}

func TestProposeBindings_SortedByVar(t *testing.T) {
	proposals := ProposeBindings(map[string]string{
		"Z_URL": "http://localhost:3000",
		"A_URL": "http://localhost:3000",
	}, configuredFixture())

	if len(proposals) != 2 || proposals[0].Var != "A_URL" {
		t.Errorf("proposals = %+v, want stable order, not map order", proposals)
	}
}

func TestProposeBindings_NothingToPropose(t *testing.T) {
	if got := ProposeBindings(nil, configuredFixture()); len(got) != 0 {
		t.Errorf("got %+v, want none", got)
	}
}

// {{proj}} expands to http://, so proposing it for a ws:// value would
// silently change the scheme — and --apply writes that unseen.
func TestProposeTemplate_PreservesSchemeAndPath(t *testing.T) {
	configured := map[int][]ProjectServer{
		7880: {{Project: "livekit", Server: "livekit"}},
		3000: {{Project: "speak-api", Server: "speak-api"}},
		3100: {{Project: "mumbo", Server: "backend"}},
		3001: {{Project: "mumbo", Server: "homepage"}},
	}

	tests := []struct {
		value string
		want  string
	}{
		{"http://localhost:3000", "{{speak-api}}"},
		{"http://localhost:3000/v1?x=1", "{{speak-api}}/v1?x=1"},
		{"ws://localhost:7880", "ws://{{livekit.host}}"},
		{"wss://localhost:7880/rtc", "wss://{{livekit.host}}/rtc"},
		{"https://localhost:3000", "https://{{speak-api.host}}"},
		{"localhost:3000", "{{speak-api.host}}"},
		{"http://localhost:3100", "{{mumbo/backend}}"},
		{"ws://127.0.0.1:3001", "ws://{{mumbo/homepage.host}}"},
	}

	for _, tt := range tests {
		t.Run(tt.value, func(t *testing.T) {
			proposals := ProposeBindings(map[string]string{"V": tt.value}, configured)
			if len(proposals) != 1 {
				t.Fatalf("got %d proposals, want 1", len(proposals))
			}
			if got := proposals[0].Template; got != tt.want {
				t.Errorf("template = %q, want %q", got, tt.want)
			}
		})
	}
}
