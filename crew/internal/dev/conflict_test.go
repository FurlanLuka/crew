package dev

import "testing"

func TestParseLocalhostPort(t *testing.T) {
	tests := []struct {
		value string
		want  int
		ok    bool
	}{
		{"http://localhost:3000", 3000, true},
		{"http://127.0.0.1:3000", 3000, true},
		{"ws://localhost:7880", 7880, true},
		{"https://localhost:8443", 8443, true},
		{"http://localhost:3000/path?q=1", 3000, true},
		{"localhost:3000", 3000, true},
		{"127.0.0.1:5432", 5432, true},
		{"  http://localhost:3000  ", 3000, true},

		// 0.0.0.0 is a bind address, not something a client is pointed at.
		{"http://0.0.0.0:3000", 0, false},
		{"http://localhost", 0, false},
		{"http://otherhost:3000", 0, false},
		{"https://dev-api.speak.com", 0, false},
		{"postgres://speak:speak@db.internal:5432/speak", 0, false},
		{"sk-not-a-url", 0, false},
		{"", 0, false},
		{"localhost:notaport", 0, false},
		{"localhost:0", 0, false},
		{"localhost:99999", 0, false},
	}

	for _, tt := range tests {
		t.Run(tt.value, func(t *testing.T) {
			got, ok := ParseLocalhostPort(tt.value)
			if ok != tt.ok || got != tt.want {
				t.Errorf("ParseLocalhostPort(%q) = (%d, %v), want (%d, %v)", tt.value, got, ok, tt.want, tt.ok)
			}
		})
	}
}

func allocatedFixture() map[int]PortOwner {
	return map[int]PortOwner{
		3000: {Slug: "mumbo--main", Project: "mumbo", Server: "homepage"},
		8000: {Slug: "phone-speak--wrk2", Project: "ai-tutor-api", Server: "ai-tutor-api"},
	}
}

// The bug this exists for: an env file pointing at localhost:3000, which on
// this machine is another project's homepage. It returned real HTTP, so nothing
// errored — the variable had no binding at all.
func TestDetectPortConflicts_NamesTheRealOwner(t *testing.T) {
	conflicts := DetectPortConflicts(DetectParams{
		Project:   "ai-tutor-api",
		Slug:      "phone-speak--wrk2",
		EnvValues: map[string]string{"SPEAK_API_URL": "http://localhost:3000"},
		Allocated: allocatedFixture(),
	})

	if len(conflicts) != 1 {
		t.Fatalf("got %d conflicts, want 1", len(conflicts))
	}
	c := conflicts[0]
	if c.Var != "SPEAK_API_URL" || c.Port != 3000 {
		t.Errorf("conflict = %+v, want SPEAK_API_URL on 3000", c)
	}
	if c.Owner.Project != "mumbo" || c.Owner.Server != "homepage" {
		t.Errorf("owner = %+v, want mumbo/homepage", c.Owner)
	}
	if c.Owner.Slug != "mumbo--main" {
		t.Errorf("owner slug = %q, want mumbo--main", c.Owner.Slug)
	}
}

func TestDetectPortConflicts_UnallocatedPortIsNotAConflict(t *testing.T) {
	conflicts := DetectPortConflicts(DetectParams{
		Project:   "ai-tutor-api",
		Slug:      "phone-speak--wrk2",
		EnvValues: map[string]string{"OTHER_URL": "http://localhost:9999"},
		Allocated: allocatedFixture(),
	})

	if len(conflicts) != 0 {
		t.Errorf("got %+v, want none — crew never allocated 9999", conflicts)
	}
}

// Pointing at your own dev server is correct, not a conflict.
func TestDetectPortConflicts_OwnPortIsNotAConflict(t *testing.T) {
	conflicts := DetectPortConflicts(DetectParams{
		Project:   "ai-tutor-api",
		Slug:      "phone-speak--wrk2",
		EnvValues: map[string]string{"SELF_URL": "http://localhost:8000"},
		Allocated: allocatedFixture(),
	})

	if len(conflicts) != 0 {
		t.Errorf("got %+v, want none — 8000 belongs to this project", conflicts)
	}
}

// A sibling project in the same worktree is the expected topology — it is
// what a binding formalises. In no-proxy mode every correct cross-project URL
// looks like this, so treating it as a conflict would fire on every start.
func TestDetectPortConflicts_SiblingInSameWorktreeIsNotAConflict(t *testing.T) {
	allocated := map[int]PortOwner{
		3000: {Slug: "phone-speak--wrk2", Project: "speak-api", Server: "speak-api"},
	}
	conflicts := DetectPortConflicts(DetectParams{
		Project:   "ai-tutor-api",
		Slug:      "phone-speak--wrk2",
		EnvValues: map[string]string{"SPEAK_API_URL": "http://localhost:3000"},
		Allocated: allocated,
	})

	if len(conflicts) != 0 {
		t.Errorf("got %+v, want none — speak-api is a sibling in the same worktree", conflicts)
	}
}

// Crew has already replaced the value, so whatever the file says about it never
// reaches the process.
func TestDetectPortConflicts_InjectedVarIsSkipped(t *testing.T) {
	conflicts := DetectPortConflicts(DetectParams{
		Project:   "ai-tutor-api",
		Slug:      "phone-speak--wrk2",
		EnvValues: map[string]string{"SPEAK_API_URL": "http://localhost:3000"},
		Injected: []Resolution{
			{Project: "ai-tutor-api", Var: "SPEAK_API_URL", Value: "http://localhost:54021", Source: SourceBinding},
		},
		Allocated: allocatedFixture(),
	})

	if len(conflicts) != 0 {
		t.Errorf("got %+v, want none — crew is injecting this variable", conflicts)
	}
}

// An unresolved binding does not count as injected: the file's value is exactly
// what still reaches the process, which is when the warning matters most.
func TestDetectPortConflicts_UnresolvedVarStillWarns(t *testing.T) {
	conflicts := DetectPortConflicts(DetectParams{
		Project:   "ai-tutor-api",
		Slug:      "phone-speak--wrk2",
		EnvValues: map[string]string{"SPEAK_API_URL": "http://localhost:3000"},
		Injected: []Resolution{
			{Project: "ai-tutor-api", Var: "SPEAK_API_URL", Source: SourceUnresolved},
		},
		Allocated: allocatedFixture(),
	})

	if len(conflicts) != 1 {
		t.Fatalf("got %d conflicts, want 1 — the file value still reaches the process", len(conflicts))
	}
}

func TestDetectPortConflicts_NonLocalValuesIgnored(t *testing.T) {
	conflicts := DetectPortConflicts(DetectParams{
		Project: "ai-tutor-api",
		Slug:    "phone-speak--wrk2",
		EnvValues: map[string]string{
			"BRAINTRUST_API_KEY": "sk-abcdef",
			"DEPLOYED_URL":       "https://dev-api.speak.com",
			"DB":                 "postgres://user:pw@db:5432/x",
		},
		Allocated: allocatedFixture(),
	})

	if len(conflicts) != 0 {
		t.Errorf("got %+v, want none", conflicts)
	}
}

func TestDetectPortConflicts_SortedByVar(t *testing.T) {
	conflicts := DetectPortConflicts(DetectParams{
		Project: "ai-tutor-api",
		Slug:    "phone-speak--wrk2",
		EnvValues: map[string]string{
			"Z_URL": "http://localhost:3000",
			"A_URL": "http://localhost:3000",
		},
		Allocated: allocatedFixture(),
	})

	if len(conflicts) != 2 {
		t.Fatalf("got %d conflicts, want 2", len(conflicts))
	}
	if conflicts[0].Var != "A_URL" || conflicts[1].Var != "Z_URL" {
		t.Errorf("order = %s, %s — want stable output, not map order",
			conflicts[0].Var, conflicts[1].Var)
	}
}

// Today's failure: speak-api's .env said :8000, ai-tutor-api's configured
// port, while ai-tutor-api was actually allocated :53778 in the same
// worktree. Crew knows both facts and has to say so.
func TestDetectPortConflicts_StaleConfiguredPortOfSibling(t *testing.T) {
	siblings := []PlannedServer{
		{Project: "ai-tutor-api", Server: DevServerConfig{Name: "ai-tutor-api", Port: 8000}, Route: Route{InternalPort: 53778}},
		{Project: "speak-api", Server: DevServerConfig{Name: "speak-api", Port: 3000}, Route: Route{InternalPort: 53776}},
	}
	conflicts := DetectPortConflicts(DetectParams{
		Project:   "speak-api",
		Slug:      "phone-speak--wrk1",
		EnvValues: map[string]string{"AI_TUTOR_API_URL": "http://localhost:8000"},
		Siblings:  siblings,
	})

	if len(conflicts) != 1 {
		t.Fatalf("got %d conflicts, want 1", len(conflicts))
	}
	c := conflicts[0]
	if c.Stale == nil || c.Stale.Project != "ai-tutor-api" || c.Stale.ActualPort != 53778 {
		t.Errorf("conflict = %+v, want the stale sibling named with its real port", c)
	}

	want := "\n  ! speak-api/.env: AI_TUTOR_API_URL=http://localhost:8000\n" +
		"    :8000 is ai-tutor-api/ai-tutor-api's configured port, but it is running on :53778 — crew add binding speak-api --scan\n"
	if got := FormatConflicts(conflicts); got != want {
		t.Errorf("FormatConflicts =\n%q\nwant\n%q", got, want)
	}
}

// A project's env pointing at its own configured port is not stale — that is
// its own server, and $PORT is what it should read anyway.
func TestDetectPortConflicts_OwnConfiguredPortIsNotStale(t *testing.T) {
	conflicts := DetectPortConflicts(DetectParams{
		Project:   "speak-api",
		Slug:      "phone-speak--wrk1",
		EnvValues: map[string]string{"HOST": "http://localhost:3000"},
		Siblings: []PlannedServer{
			{Project: "speak-api", Server: DevServerConfig{Name: "speak-api", Port: 3000}, Route: Route{InternalPort: 53776}},
		},
	})
	if len(conflicts) != 0 {
		t.Errorf("got %+v, want none", conflicts)
	}
}

// A sibling that really is on its configured port (nothing to warn about) —
// the stale check compares against where it actually runs.
func TestDetectPortConflicts_SiblingOnItsConfiguredPortIsFine(t *testing.T) {
	conflicts := DetectPortConflicts(DetectParams{
		Project:   "speak-api",
		Slug:      "phone-speak--wrk1",
		EnvValues: map[string]string{"AI_TUTOR_API_URL": "http://localhost:8000"},
		Siblings: []PlannedServer{
			{Project: "ai-tutor-api", Server: DevServerConfig{Name: "ai-tutor-api", Port: 8000}, Route: Route{InternalPort: 8000}},
		},
	})
	if len(conflicts) != 0 {
		t.Errorf("got %+v, want none", conflicts)
	}
}
