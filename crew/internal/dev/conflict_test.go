package dev

import (
	"os"
	"path/filepath"
	"testing"
)

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
		{"https://dev-api.store.com", 0, false},
		{"postgres://store:store@db.internal:5432/store", 0, false},
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
		3000: {Slug: "admin--main", Project: "admin", Server: "homepage"},
		8000: {Slug: "store-front--wrk2", Project: "checkout-api", Server: "checkout-api"},
	}
}

// The bug this exists for: an env file pointing at localhost:3000, which on
// this machine is another project's homepage. It returned real HTTP, so nothing
// errored — the variable had no binding at all.
func TestDetectPortConflicts_NamesTheRealOwner(t *testing.T) {
	conflicts := DetectPortConflicts(DetectParams{
		Project:   "checkout-api",
		Slug:      "store-front--wrk2",
		EnvValues: map[string]string{"STORE_API_URL": "http://localhost:3000"},
		Allocated: allocatedFixture(),
	})

	if len(conflicts) != 1 {
		t.Fatalf("got %d conflicts, want 1", len(conflicts))
	}
	c := conflicts[0]
	if c.Var != "STORE_API_URL" || c.Port != 3000 {
		t.Errorf("conflict = %+v, want STORE_API_URL on 3000", c)
	}
	if c.Owner.Project != "admin" || c.Owner.Server != "homepage" {
		t.Errorf("owner = %+v, want admin/homepage", c.Owner)
	}
	if c.Owner.Slug != "admin--main" {
		t.Errorf("owner slug = %q, want admin--main", c.Owner.Slug)
	}
}

func TestDetectPortConflicts_UnallocatedPortIsNotAConflict(t *testing.T) {
	conflicts := DetectPortConflicts(DetectParams{
		Project:   "checkout-api",
		Slug:      "store-front--wrk2",
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
		Project:   "checkout-api",
		Slug:      "store-front--wrk2",
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
		3000: {Slug: "store-front--wrk2", Project: "store-api", Server: "store-api"},
	}
	conflicts := DetectPortConflicts(DetectParams{
		Project:   "checkout-api",
		Slug:      "store-front--wrk2",
		EnvValues: map[string]string{"STORE_API_URL": "http://localhost:3000"},
		Allocated: allocated,
	})

	if len(conflicts) != 0 {
		t.Errorf("got %+v, want none — store-api is a sibling in the same worktree", conflicts)
	}
}

// Crew has already replaced the value, so whatever the file says about it never
// reaches the process.
func TestDetectPortConflicts_InjectedVarIsSkipped(t *testing.T) {
	conflicts := DetectPortConflicts(DetectParams{
		Project:   "checkout-api",
		Slug:      "store-front--wrk2",
		EnvValues: map[string]string{"STORE_API_URL": "http://localhost:3000"},
		Injected: []Resolution{
			{Project: "checkout-api", Var: "STORE_API_URL", Value: "http://localhost:54021", Source: SourceBinding},
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
		Project:   "checkout-api",
		Slug:      "store-front--wrk2",
		EnvValues: map[string]string{"STORE_API_URL": "http://localhost:3000"},
		Injected: []Resolution{
			{Project: "checkout-api", Var: "STORE_API_URL", Source: SourceUnresolved},
		},
		Allocated: allocatedFixture(),
	})

	if len(conflicts) != 1 {
		t.Fatalf("got %d conflicts, want 1 — the file value still reaches the process", len(conflicts))
	}
}

func TestDetectPortConflicts_NonLocalValuesIgnored(t *testing.T) {
	conflicts := DetectPortConflicts(DetectParams{
		Project: "checkout-api",
		Slug:    "store-front--wrk2",
		EnvValues: map[string]string{
			"BRAINTRUST_API_KEY": "sk-abcdef",
			"DEPLOYED_URL":       "https://dev-api.store.com",
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
		Project: "checkout-api",
		Slug:    "store-front--wrk2",
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

// Today's failure: store-api's .env said :8000, checkout-api's configured
// port, while checkout-api was actually allocated :53778 in the same
// worktree. Crew knows both facts and has to say so.
func TestDetectPortConflicts_StaleConfiguredPortOfSibling(t *testing.T) {
	siblings := []PlannedServer{
		{Project: "checkout-api", Server: DevServerConfig{Name: "checkout-api", Port: 8000}, Route: Route{InternalPort: 53778}},
		{Project: "store-api", Server: DevServerConfig{Name: "store-api", Port: 3000}, Route: Route{InternalPort: 53776}},
	}
	conflicts := DetectPortConflicts(DetectParams{
		Project:   "store-api",
		Slug:      "store-front--wrk1",
		EnvValues: map[string]string{"CHECKOUT_API_URL": "http://localhost:8000"},
		Siblings:  siblings,
	})

	if len(conflicts) != 1 {
		t.Fatalf("got %d conflicts, want 1", len(conflicts))
	}
	c := conflicts[0]
	if c.Stale == nil || c.Stale.Project != "checkout-api" || c.Stale.ActualPort != 53778 {
		t.Errorf("conflict = %+v, want the stale sibling named with its real port", c)
	}

	want := "\n  ! store-api/.env: CHECKOUT_API_URL=http://localhost:8000\n" +
		"    :8000 is checkout-api/checkout-api's configured port, but it is running on :53778 — crew add binding store-api --scan\n"
	if got := FormatConflicts(conflicts); got != want {
		t.Errorf("FormatConflicts =\n%q\nwant\n%q", got, want)
	}
}

// A project's env pointing at its own configured port is not stale — that is
// its own server, and $PORT is what it should read anyway.
func TestDetectPortConflicts_OwnConfiguredPortIsNotStale(t *testing.T) {
	conflicts := DetectPortConflicts(DetectParams{
		Project:   "store-api",
		Slug:      "store-front--wrk1",
		EnvValues: map[string]string{"HOST": "http://localhost:3000"},
		Siblings: []PlannedServer{
			{Project: "store-api", Server: DevServerConfig{Name: "store-api", Port: 3000}, Route: Route{InternalPort: 53776}},
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
		Project:   "store-api",
		Slug:      "store-front--wrk1",
		EnvValues: map[string]string{"CHECKOUT_API_URL": "http://localhost:8000"},
		Siblings: []PlannedServer{
			{Project: "checkout-api", Server: DevServerConfig{Name: "checkout-api", Port: 8000}, Route: Route{InternalPort: 8000}},
		},
	})
	if len(conflicts) != 0 {
		t.Errorf("got %+v, want none", conflicts)
	}
}

// The conflict scan's "injected" set is per project but must hold for every
// server: a var bound for web alone still reaches worker from the env file,
// so a foreign port there is reported; bound project-wide it is skipped.
func TestInspectEnvConflicts_ScopedVarIsNotInjectedEverywhere(t *testing.T) {
	tmp := setupTestConfig(t)
	saveRoutes("admin--main", []Route{{Project: "admin", ServerName: "homepage", InternalPort: 3000}})
	dir := filepath.Join(tmp, "mono")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, ".env"), []byte("API_URL=http://localhost:3000\n"), 0o644)
	mono := DevProject{Name: "mono", Path: dir, DevServers: []DevServerConfig{{Name: "web"}, {Name: "worker"}}}

	scoped := []Resolution{{Project: "mono", Var: "API_URL", Server: "web", Value: "x", Source: SourceBinding}}
	if got := InspectEnvConflicts("ws--wrk1", []DevProject{mono}, nil, scoped); len(got) != 1 || got[0].Var != "API_URL" {
		t.Errorf("web-only binding leaves worker on the file value: %+v", got)
	}
	pw := []Resolution{{Project: "mono", Var: "API_URL", Value: "x", Source: SourceBinding}}
	if got := InspectEnvConflicts("ws--wrk1", []DevProject{mono}, nil, pw); len(got) != 0 {
		t.Errorf("project-wide binding covers every server: %+v", got)
	}
}
