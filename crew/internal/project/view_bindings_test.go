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
		"    {{speak-api}}                  http://localhost:54494   URL of its one server",
		"    {{speak-api.host}}             localhost:54494          ws://{{speak-api.host}}/rtc",
		"    {{speak-api.port}}             54494",
		"    {{ai-tutor-api/worker}}        http://localhost:54497   a named server",
		"    {{ai-tutor-api/worker.port}}   54497                    .host / .port go after the server",
		"    {{worktree}}                   wrk1                     this worktree's name",
		"    {{workspace}}                  phone-speak              this workspace's name",
		"    Name the server only when the project has more than one. No tokens = used as-is.",
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

func TestDraftState(t *testing.T) {
	tests := []struct {
		name        string
		draft       Binding
		previewable bool
		wantErr     string
	}{
		{name: "complete", draft: Binding{Var: "A", Value: "{{speak-api}}"}, previewable: true},
		{name: "literal", draft: Binding{Var: "A", Value: "x"}, previewable: true},
		{name: "var not yet valid", draft: Binding{Var: "not-a-var", Value: "{{speak-api}}"}},
		{name: "empty value", draft: Binding{Var: "A"}},
		{name: "malformed token", draft: Binding{Var: "A", Value: "{{speak-api.foo}}"}, wantErr: "a server is written"},
		{name: "malformed token beats missing var", draft: Binding{Value: "{{}}"}, wantErr: "expected"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			previewable, err := draftState(tt.draft)
			if previewable != tt.previewable {
				t.Errorf("previewable = %v, want %v", previewable, tt.previewable)
			}
			if tt.wantErr == "" && err != nil {
				t.Errorf("err = %v, want nil", err)
			}
			if tt.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tt.wantErr)) {
				t.Errorf("err = %v, want it to mention %q", err, tt.wantErr)
			}
		})
	}
}

func TestCompleteVar(t *testing.T) {
	v := BindingsView{
		envKeys:  []string{"LIVEKIT_AGENT_NAME", "LIVEKIT_URL", "SPEAK_API_URL"},
		bindings: []Binding{{Var: "LIVEKIT_AGENT_NAME", Value: "{{worktree}}"}},
	}
	tests := map[string]string{
		"":              "",
		"live":          "LIVEKIT_URL", // LIVEKIT_AGENT_NAME is already bound
		"LIVEKIT_U":     "LIVEKIT_URL",
		"speak":         "SPEAK_API_URL",
		"NOPE":          "",
		"SPEAK_API_URL": "SPEAK_API_URL",
	}
	for prefix, want := range tests {
		if got := v.completeVar(prefix); got != want {
			t.Errorf("completeVar(%q) = %q, want %q", prefix, got, want)
		}
	}
}

func TestRenderList_MarksLegacyForm(t *testing.T) {
	v := BindingsView{bindings: []Binding{
		{Var: "OLD", Value: "{{url:speak-api}}"},
		{Var: "NEW", Value: "{{speak-api}}"},
	}}
	var b strings.Builder
	v.renderList(&b)
	lines := strings.Split(ansi.ReplaceAllString(b.String(), ""), "\n")

	if !strings.Contains(lines[0], "OLD") || !strings.Contains(lines[0], "· old form") {
		t.Errorf("legacy row = %q, want the old-form marker", lines[0])
	}
	if strings.Contains(lines[1], "old form") {
		t.Errorf("modern row = %q, want no marker", lines[1])
	}
}

func TestRenderEdit_MalformedTokenShowsOneError(t *testing.T) {
	prev := Previewer
	Previewer = func(string, Binding) []BindingPreview { return nil }
	t.Cleanup(func() { Previewer = prev })

	v := NewBindingsView("ai-tutor-api")
	v.editIdx = -1
	v.varInput.SetValue("A")
	v.valueInput.SetValue("{{speak-api.foo}}")
	v.syncDraft()

	var b strings.Builder
	v.renderEdit(&b)
	got := ansi.ReplaceAllString(b.String(), "")

	if strings.Count(got, "a server is written") != 1 {
		t.Errorf("want the parse error exactly once:\n%s", got)
	}
	if strings.Contains(got, "not in any worktree yet") || strings.Contains(got, "→") {
		t.Errorf("malformed draft must not preview:\n%s", got)
	}

	// Fixing the token clears the error and falls back to the no-worktree hint.
	v.valueInput.SetValue("{{speak-api}}")
	v.syncDraft()
	b.Reset()
	v.renderEdit(&b)
	got = ansi.ReplaceAllString(b.String(), "")
	if strings.Contains(got, "a server is written") || !strings.Contains(got, "not in any worktree yet") {
		t.Errorf("valid draft:\n%s", got)
	}
}
