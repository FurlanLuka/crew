package workspace

import (
	"fmt"
	"os"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/exec"
)

// currentBranch returns the current branch name at path, or "" if it cannot be
// determined (detached HEAD, missing repo, etc.).
func currentBranch(path string) string {
	out, err := exec.RunGitCommand(path, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return ""
	}
	branch := strings.TrimSpace(out)
	if branch == "HEAD" {
		return ""
	}
	return branch
}

// directBranches reads the current branch of every direct-mode project. This is
// the only impure part of prompt generation, hoisted out so RenderPrompt stays
// a pure function of data.
func directBranches(res *Resolved) map[string]string {
	branches := make(map[string]string)
	for _, p := range res.Projects {
		if p.Direct {
			branches[p.Name] = currentBranch(p.Path)
		}
	}
	return branches
}

// RenderPrompt builds the orientation prompt text. It orients a single Claude
// instance to every project in the worktree by listing names, working
// directories, and roles.
//
// Projects are labelled [worktree] or [direct] because the distinction changes
// what is safe to do: worktree projects are isolated copies, while direct
// projects point at the canonical repository, so a mistaken commit or branch
// switch there lands in the user's real repo. Both launch modes run Claude with
// permissions skipped, which makes this framing the only thing warning it off
// the user's working tree.
func RenderPrompt(res *Resolved, branches map[string]string) string {
	var b strings.Builder
	if IsCheck(res.Ref) {
		// A check is a scratch checkout crew made to prove the project's
		// config; the agent is here to make that config pass, not to build.
		fmt.Fprintf(&b, "You are working in crew's check of `%s` (ref `%s`): a fresh checkout made to prove the project installs and its servers start from nothing. Fix the project's config — its setup command, env command, dev server command — not this checkout alone; it is thrown away once the check passes.\n\n", res.Ref.Worktree, res.Ref)
	} else {
		fmt.Fprintf(&b, "You are working in the `%s` workspace.\n\n", res.Ref)
	}
	b.WriteString("It contains the following projects:\n\n")

	hasWorktree := false
	hasDirect := false
	for _, p := range res.Projects {
		role := p.Role
		if role == "" {
			role = "(no role specified)"
		}
		modeLabel := "worktree"
		if p.Direct {
			modeLabel = "direct"
			hasDirect = true
		} else {
			hasWorktree = true
		}
		fmt.Fprintf(&b, "- **%s** [%s] (%s): %s\n", p.Name, modeLabel, p.Path, role)
	}
	b.WriteString("\n")

	if hasWorktree {
		b.WriteString("IMPORTANT: `[worktree]` projects are git worktrees — isolated working copies with their own branches.\n")
		b.WriteString("All changes in worktree projects stay isolated from the main codebase until explicitly merged.\n\n")
	}

	if hasDirect {
		b.WriteString("CAUTION: `[direct]` projects point at the canonical repository — changes are NOT isolated. ")
		b.WriteString("Confirm with the user before committing or switching branches in a direct project.\n")
		for _, p := range res.Projects {
			if !p.Direct {
				continue
			}
			if branch := branches[p.Name]; branch == "" {
				fmt.Fprintf(&b, "  - **%s** is on a detached HEAD or unknown branch at %s.\n", p.Name, p.Path)
			} else {
				fmt.Fprintf(&b, "  - **%s** is currently on branch `%s` at %s.\n", p.Name, branch, p.Path)
			}
		}
		b.WriteString("\n")
	}

	b.WriteString(renderCrewSection(res.Ref))

	b.WriteString("cd into the relevant project's directory before running commands or editing files there.\n")
	b.WriteString("Wait for my instructions on what to build.\n")

	return b.String()
}

// renderCrewSection tells Claude it is inside a crew worktree and that the
// servers, their env and their logs are crew's to drive — the session was
// opened by crew, so the CLI is there and `CREW_REF` names the worktree.
func renderCrewSection(ref Ref) string {
	var b strings.Builder
	b.WriteString("## crew\n\n")
	fmt.Fprintf(&b, "This worktree is managed by crew (`crew` on PATH; ref `%s`, also in `$CREW_REF`). Drive the dev servers and their env through it — never start a server by hand:\n\n", ref)
	fmt.Fprintf(&b, "- `crew dev status %s` · `crew dev start %s` · `crew dev restart %s` · `crew dev stop %s` — servers on stable ports, bindings exported; read the `!` lines it prints\n", ref, ref, ref, ref)
	fmt.Fprintf(&b, "- `crew dev check %s` — a few seconds after a start: which server died or never listened\n", ref)
	fmt.Fprintf(&b, "- `crew dev logs %s <server> --lines=50` — a server's output (never `-f`, it follows forever)\n", ref)
	fmt.Fprintf(&b, "- `crew env %s <project>` · `crew run %s <project> -- <cmd>` — the resolved env; run tests, scripts and evals through `crew run` so they see the same URLs the servers got\n", ref, ref)
	fmt.Fprintf(&b, "- `crew fix %s --print` — when something is recorded as failed: every issue with its evidence\n", ref)
	b.WriteString("- `crew help <command>` for the rest; the `crew` skill if your agent has it (`/crew:crew` in Claude Code)\n\n")
	return b.String()
}

// GeneratePrompt renders the orientation prompt and writes it to disk.
func GeneratePrompt(res *Resolved) (string, error) {
	text := RenderPrompt(res, directBranches(res))
	if err := os.WriteFile(PromptFilePath(res.Ref), []byte(text), 0o644); err != nil {
		return "", err
	}
	return text, nil
}
