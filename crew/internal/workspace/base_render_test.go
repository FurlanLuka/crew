package workspace

import (
	"strings"
	"testing"
)

func TestRenderBaseTable(t *testing.T) {
	statuses := []BaseStatus{
		{Project: "store-front", Base: "main", Current: "main", Behind: 0, Ahead: 0},
		{Project: "store-api", Base: "develop", Current: "feature/x", Behind: 2, Ahead: 0},
	}
	got := stripANSI(RenderBaseTable(statuses, BaseReady, "⠋"))
	want := strings.Join([]string{
		"  Branching from",
		"  store-front  main        up to date",
		"  store-api    develop     2 behind origin/develop   (checkout is on feature/x)",
		"",
		"  ! store-api is behind origin — the worktree branches from the local base. Pull first for the latest.",
		"  ctrl+p pulls the latest into the local bases (fast-forward only)",
		"",
	}, "\n")
	if got != want {
		t.Errorf("ready:\n%s\nwant:\n%s", got, want)
	}
	if got := stripANSI(RenderBaseTable(nil, BaseLoading, "⠋")); got != "  Branching from\n  ⠋ checking base branches against origin…\n" {
		t.Errorf("loading:\n%s", got)
	}
	if got := stripANSI(RenderBaseTable(nil, BasePulling, "⠋")); !strings.Contains(got, "⠋ pulling the latest into the local bases…") {
		t.Errorf("pulling:\n%s", got)
	}
}

func TestSummariesOf(t *testing.T) {
	setupTestConfig(t)
	Save(&Workspace{Name: "a", Projects: []WorkspaceProject{{Name: "x"}}, Worktrees: []Worktree{{Name: "main"}, {Name: "wrk2"}}})
	Save(&Workspace{Name: "b", Worktrees: []Worktree{{Name: "main"}}})
	got, err := SummariesOf("a")
	if err != nil || len(got) != 2 || got[0].Name != "a/main" || got[1].Name != "a/wrk2" || got[0].ProjectCount != 1 {
		t.Errorf("SummariesOf(a) = %+v, %v", got, err)
	}
	if _, err := SummariesOf("nope"); err == nil {
		t.Error("an unknown workspace is an error")
	}
}
