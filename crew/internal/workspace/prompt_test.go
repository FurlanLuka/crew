package workspace

import (
	"strings"
	"testing"
)

func mixedResolved() *Resolved {
	ref := Ref{Workspace: "phone-speak", Worktree: "wrk2"}
	return &Resolved{
		Ref:  ref,
		Slug: ref.Slug(),
		Dir:  "/w/phone-speak/wrk2",
		Projects: []ResolvedProject{
			{Name: "api", Role: "backend", Path: "/w/phone-speak/wrk2/api"},
			{Name: "infra", Role: "", Direct: true, Path: "/repos/infra"},
		},
	}
}

func TestRenderPrompt_Golden(t *testing.T) {
	got := RenderPrompt(mixedResolved(), map[string]string{"infra": "main"})

	want := strings.Join([]string{
		"You are working in the `phone-speak/wrk2` workspace.",
		"",
		"It contains the following projects:",
		"",
		"- **api** [worktree] (/w/phone-speak/wrk2/api): backend",
		"- **infra** [direct] (/repos/infra): (no role specified)",
		"",
		"IMPORTANT: `[worktree]` projects are git worktrees — isolated working copies with their own branches.",
		"All changes in worktree projects stay isolated from the main codebase until explicitly merged.",
		"",
		"CAUTION: `[direct]` projects point at the canonical repository — changes are NOT isolated. Confirm with the user before committing or switching branches in a direct project.",
		"  - **infra** is currently on branch `main` at /repos/infra.",
		"",
		"cd into the relevant project's directory before running commands or editing files there.",
		"Wait for my instructions on what to build.",
		"",
	}, "\n")

	if got != want {
		t.Errorf("RenderPrompt =\n%s\nwant\n%s", got, want)
	}
}

// Unreachable through GeneratePrompt without a repo on a detached HEAD.
func TestRenderPrompt_DetachedHeadDirectProject(t *testing.T) {
	got := RenderPrompt(mixedResolved(), map[string]string{"infra": ""})

	if !strings.Contains(got, "**infra** is on a detached HEAD or unknown branch at /repos/infra.") {
		t.Errorf("detached HEAD line missing:\n%s", got)
	}
}

// The header is the ref, never the slug — "/" is what the user reads.
func TestRenderPrompt_HeaderUsesTheRef(t *testing.T) {
	got := RenderPrompt(mixedResolved(), nil)

	if !strings.Contains(got, "`phone-speak/wrk2` workspace") {
		t.Errorf("header should carry the ref:\n%s", got)
	}
	if strings.Contains(got, "phone-speak--wrk2") {
		t.Errorf("slug leaked into a human-facing prompt:\n%s", got)
	}
}

func TestRenderPrompt_WorktreeOnlyHasNoCaution(t *testing.T) {
	res := &Resolved{
		Ref:      Ref{Workspace: "ws", Worktree: "main"},
		Projects: []ResolvedProject{{Name: "api", Path: "/w/api"}},
	}
	got := RenderPrompt(res, nil)

	if strings.Contains(got, "CAUTION") {
		t.Errorf("worktree-only prompt should have no CAUTION block:\n%s", got)
	}
	if !strings.Contains(got, "IMPORTANT: `[worktree]`") {
		t.Errorf("worktree framing missing:\n%s", got)
	}
}

func TestNeedsPrompt(t *testing.T) {
	tests := []struct {
		name     string
		projects []ResolvedProject
		want     bool
	}{
		{"single worktree", []ResolvedProject{{Name: "api"}}, false},
		{"single direct", []ResolvedProject{{Name: "api", Direct: true}}, true},
		{"multi worktree", []ResolvedProject{{Name: "api"}, {Name: "web"}}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := NeedsPrompt(&Resolved{Projects: tt.projects}); got != tt.want {
				t.Errorf("NeedsPrompt = %v, want %v", got, tt.want)
			}
		})
	}
}
