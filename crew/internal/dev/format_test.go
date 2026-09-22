package dev

import (
	"strings"
	"testing"
)

// One worktree covering every outcome at once: an override, a resolved
// binding, an identity token, and one variable left alone.
func mixedResolutions() []Resolution {
	return []Resolution{
		{Project: "checkout-api", Var: "STORE_API_URL", Value: "https://dev-api.store.com", Source: SourceOverride, Detail: "worktree override"},
		{Project: "checkout-api", Var: "SIGNALS_AGENT_NAME", Value: "wrk2", Source: SourceBinding, Detail: "{{worktree}}"},
		{Project: "checkout-api", Var: "CHECKOUT_API_URL", Source: SourceUnresolved, Detail: "store-partner not in workspace"},
		{Project: "store-api", Var: "TUTOR_URL", Value: "http://localhost:54088", Source: SourceBinding, Detail: "from checkout-api"},
	}
}

// Successes collapse to a count and anomalies print in full: a wall of correct
// lines every start is where a wrong line hides.
func TestFormatResolutions_Golden(t *testing.T) {
	want := strings.Join([]string{
		"Resolved env  3 vars across 2 projects",
		"",
		"  checkout-api",
		"    CHECKOUT_API_URL  left alone — store-partner not in workspace",
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
		Project: "checkout-api",
		Var:     "CHECKOUT_API_URL",
		Value:   "http://localhost:3000",
		Port:    3000,
		Owner:   PortOwner{Slug: "admin--main", Project: "admin", Server: "homepage"},
	}}

	want := strings.Join([]string{
		"",
		"  ! checkout-api/.env: CHECKOUT_API_URL=http://localhost:3000",
		"    :3000 is admin/homepage in worktree admin/main",
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
		{Project: "checkout-api", Var: "STORE_API_URL", Value: "http://localhost:54021", Source: SourceBinding},
		{Project: "checkout-api", Var: "GONE", Source: SourceUnresolved, Detail: "not in workspace"},
	}

	want := strings.Join([]string{
		"  STORE_API_URL  http://localhost:54021",
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
		"SIGNALS_AGENT_NAME=wrk2",
		"STORE_API_URL=https://dev-api.store.com",
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

	if len(byProject["checkout-api"]) != 3 {
		t.Errorf("checkout-api has %d resolutions, want 3", len(byProject["checkout-api"]))
	}
	if len(byProject["store-api"]) != 1 {
		t.Errorf("store-api has %d resolutions, want 1", len(byProject["store-api"]))
	}
	// Order within a project has to survive: EnvPrefix depends on it.
	if byProject["checkout-api"][0].Var != "STORE_API_URL" {
		t.Errorf("first var = %q, want STORE_API_URL", byProject["checkout-api"][0].Var)
	}
}

// A scoped row is labelled VAR (server) wherever a var is shown, and the
// column is as wide as the label.
func TestFormat_ScopedRowsAreLabelled(t *testing.T) {
	rs := append(mixedResolutions(), Resolution{Project: "checkout-api", Var: "Q", Server: "worker", Source: SourceUnresolved, Detail: "queue not in workspace"})
	want := strings.Join([]string{
		"Resolved env  3 vars across 2 projects",
		"",
		"  checkout-api",
		"    CHECKOUT_API_URL  left alone — store-partner not in workspace",
		"    Q (worker)        left alone — queue not in workspace",
		"",
	}, "\n")
	if got := FormatResolutions(rs); got != want {
		t.Errorf("FormatResolutions =\n%q\nwant\n%q", got, want)
	}
	if got := FormatAnomalies(rs); !strings.Contains(got, "    Q (worker)        left alone") {
		t.Errorf("FormatAnomalies =\n%q", got)
	}

	table := []Resolution{
		{Project: "mono", Var: "A", Value: "1", Source: SourceBinding},
		{Project: "mono", Var: "A", Server: "web", Value: "2", Source: SourceBinding},
	}
	wantTable := strings.Join([]string{
		"  A        1",
		"  A (web)  2",
		"",
	}, "\n")
	if got := FormatEnvTable(table); got != wantTable {
		t.Errorf("FormatEnvTable =\n%q\nwant\n%q", got, wantTable)
	}
}
