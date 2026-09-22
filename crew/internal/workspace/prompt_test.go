package workspace

import (
	"strings"
	"testing"
)

func mixedResolved() *Resolved {
	ref := Ref{Workspace: "store-front", Worktree: "wrk2"}
	return &Resolved{
		Ref:  ref,
		Slug: ref.Slug(),
		Dir:  "/w/store-front/wrk2",
		Projects: []ResolvedProject{
			{Name: "api", Role: "backend", Path: "/w/store-front/wrk2/api"},
			{Name: "infra", Role: "", Direct: true, Path: "/repos/infra"},
		},
	}
}

func TestRenderPrompt_Golden(t *testing.T) {
	got := RenderPrompt(mixedResolved(), map[string]string{"infra": "main"})

	want := strings.Join([]string{
		"You are working in the `store-front/wrk2` workspace.",
		"",
		"It contains the following projects:",
		"",
		"- **api** [worktree] (/w/store-front/wrk2/api): backend",
		"- **infra** [direct] (/repos/infra): (no role specified)",
		"",
		"IMPORTANT: `[worktree]` projects are git worktrees — isolated working copies with their own branches.",
		"All changes in worktree projects stay isolated from the main codebase until explicitly merged.",
		"",
		"CAUTION: `[direct]` projects point at the canonical repository — changes are NOT isolated. Confirm with the user before committing or switching branches in a direct project.",
		"  - **infra** is currently on branch `main` at /repos/infra.",
		"",
		"## crew",
		"",
		"This worktree is managed by crew (`crew` on PATH; ref `store-front/wrk2`, also in `$CREW_REF`). Drive the dev servers and their env through it — never start a server by hand:",
		"",
		"- `crew dev status store-front/wrk2` · `crew dev start store-front/wrk2` · `crew dev restart store-front/wrk2` · `crew dev stop store-front/wrk2` — servers on stable ports, bindings exported; read the `!` lines it prints",
		"- `crew dev check store-front/wrk2` — a few seconds after a start: which server died or never listened",
		"- `crew dev logs store-front/wrk2 <server> --lines=50` — a server's output (never `-f`, it follows forever)",
		"- `crew env store-front/wrk2 <project>` · `crew run store-front/wrk2 <project> -- <cmd>` — the resolved env; run tests, scripts and evals through `crew run` so they see the same URLs the servers got",
		"- `crew fix store-front/wrk2 --print` — when something is recorded as failed: every issue with its evidence",
		"- `crew help <command>` for the rest; the `crew` skill if your agent has it (`/crew:crew` in Claude Code)",
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

	if !strings.Contains(got, "`store-front/wrk2` workspace") {
		t.Errorf("header should carry the ref:\n%s", got)
	}
	if strings.Contains(got, "store-front--wrk2") {
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

// The crew section names the ref in every command, so Claude can paste
// them; the ref, never the slug.
func TestRenderPrompt_CrewSection(t *testing.T) {
	got := RenderPrompt(mixedResolved(), nil)
	for _, want := range []string{
		"## crew",
		"ref `store-front/wrk2`, also in `$CREW_REF`",
		"`crew dev check store-front/wrk2`",
		"`crew run store-front/wrk2 <project> -- <cmd>`",
		"`crew fix store-front/wrk2 --print`",
		"never `-f`",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("prompt lacks %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "store-front--wrk2") {
		t.Error("the slug leaked into the prompt")
	}
}

// crew fix check/<name> --print hands this to an agent: a check is a scratch
// checkout, and the fix belongs in the project's config.
func TestRenderPrompt_Check(t *testing.T) {
	ref := CheckRef("api")
	res := &Resolved{Ref: ref, Slug: ref.Slug(), Projects: []ResolvedProject{{Name: "api", Path: "/w/check/api/api", Role: "the project under check"}}}
	got := RenderPrompt(res, nil)
	want := "You are working in crew's check of `api` (ref `check/api`): a fresh checkout made to prove the project installs and its servers start from nothing. Fix the project's config — its setup command, env command, dev server command — not this checkout alone; it is thrown away once the check passes.\n\nIt contains the following projects:\n\n- **api** [worktree] (/w/check/api/api): the project under check\n"
	if !strings.HasPrefix(got, want) {
		t.Errorf("RenderPrompt(check) =\n%s\nwant prefix\n%s", got, want)
	}
	if strings.Contains(got, "workspace.") {
		t.Error("a check is not called a workspace")
	}
}
