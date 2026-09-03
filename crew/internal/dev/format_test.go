package dev

import (
	"strings"
	"testing"
)

// One worktree covering every outcome at once: an override, a resolved
// binding, an identity token, and one variable left alone.
func mixedResolutions() []Resolution {
	return []Resolution{
		{Project: "ai-tutor-api", Var: "SPEAK_API_URL", Value: "https://dev-api.speak.com", Source: SourceOverride, Detail: "worktree override"},
		{Project: "ai-tutor-api", Var: "LIVEKIT_AGENT_NAME", Value: "wrk2", Source: SourceBinding, Detail: "{{worktree}}"},
		{Project: "ai-tutor-api", Var: "AI_TUTOR_API_URL", Source: SourceUnresolved, Detail: "speak-partner not in workspace"},
		{Project: "speak-api", Var: "TUTOR_URL", Value: "http://localhost:54088", Source: SourceBinding, Detail: "from ai-tutor-api"},
	}
}

// Successes collapse to a count and anomalies print in full: a wall of correct
// lines every start is where a wrong line hides.
func TestFormatResolutions_Golden(t *testing.T) {
	want := strings.Join([]string{
		"Resolved env  3 vars across 2 projects",
		"",
		"  ai-tutor-api",
		"    AI_TUTOR_API_URL  left alone — speak-partner not in workspace",
		"",
	}, "\n")

	if got := FormatResolutions(mixedResolutions()); got != want {
		t.Errorf("FormatResolutions =\n%q\nwant\n%q", got, want)
	}
}

func TestFormatResolutions_AllResolvedIsJustTheCount(t *testing.T) {
	rs := []Resolution{
		{Project: "p", Var: "A", Value: "1", Source: SourceBinding},
		{Project: "p", Var: "B", Value: "2", Source: SourceBinding},
	}

	want := "Resolved env  2 vars across 1 project\n"
	if got := FormatResolutions(rs); got != want {
		t.Errorf("FormatResolutions = %q, want %q", got, want)
	}
}

func TestFormatResolutions_Empty(t *testing.T) {
	if got := FormatResolutions(nil); got != "" {
		t.Errorf("FormatResolutions = %q, want empty", got)
	}
}

func TestFormatConflicts_Golden(t *testing.T) {
	conflicts := []Conflict{{
		Project: "ai-tutor-api",
		Var:     "AI_TUTOR_API_URL",
		Value:   "http://localhost:3000",
		Port:    3000,
		Owner:   PortOwner{Slug: "mumbo--main", Project: "mumbo", Server: "homepage"},
	}}

	want := strings.Join([]string{
		"",
		"  ! ai-tutor-api/.env: AI_TUTOR_API_URL=http://localhost:3000",
		"    :3000 is mumbo/homepage in worktree mumbo/main",
		"",
	}, "\n")

	if got := FormatConflicts(conflicts); got != want {
		t.Errorf("FormatConflicts =\n%q\nwant\n%q", got, want)
	}
}

func TestFormatConflicts_Empty(t *testing.T) {
	if got := FormatConflicts(nil); got != "" {
		t.Errorf("FormatConflicts = %q, want empty", got)
	}
}

func TestFormatEnvTable_Golden(t *testing.T) {
	rs := []Resolution{
		{Project: "ai-tutor-api", Var: "SPEAK_API_URL", Value: "http://localhost:54021", Source: SourceBinding},
		{Project: "ai-tutor-api", Var: "GONE", Source: SourceUnresolved, Detail: "not in workspace"},
	}

	want := strings.Join([]string{
		"  SPEAK_API_URL  http://localhost:54021",
		"  GONE           left alone — not in workspace",
		"",
	}, "\n")

	if got := FormatEnvTable(rs); got != want {
		t.Errorf("FormatEnvTable =\n%q\nwant\n%q", got, want)
	}
}

// `crew env` output is meant for eval, so only variables crew actually sets
// appear — an unresolved one is precisely a variable crew is not setting.
func TestEnvLines_OnlyResolvedAndSorted(t *testing.T) {
	got := EnvLines(mixedResolutions())

	want := []string{
		"LIVEKIT_AGENT_NAME=wrk2",
		"SPEAK_API_URL=https://dev-api.speak.com",
		"TUTOR_URL=http://localhost:54088",
	}
	if len(got) != len(want) {
		t.Fatalf("EnvLines = %q, want %q", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("line %d = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestGroupResolutions(t *testing.T) {
	byProject := GroupResolutions(mixedResolutions())

	if len(byProject["ai-tutor-api"]) != 3 {
		t.Errorf("ai-tutor-api has %d resolutions, want 3", len(byProject["ai-tutor-api"]))
	}
	if len(byProject["speak-api"]) != 1 {
		t.Errorf("speak-api has %d resolutions, want 1", len(byProject["speak-api"]))
	}
	// Order within a project has to survive: EnvPrefix depends on it.
	if byProject["ai-tutor-api"][0].Var != "SPEAK_API_URL" {
		t.Errorf("first var = %q, want SPEAK_API_URL", byProject["ai-tutor-api"][0].Var)
	}
}
