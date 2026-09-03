package workspace

import (
	"fmt"
	"os"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/exec"
)

// NeedsPrompt reports whether a launch should inject the orientation prompt.
//
// Multi-project worktrees need it to find their projects. A worktree holding
// any direct-mode project needs it for the CAUTION framing regardless of size:
// both launch modes skip permissions, so a lone direct project would otherwise
// drop Claude into the user's canonical repo with no warning at all.
func NeedsPrompt(res *Resolved) bool {
	return res.MultiProject() || res.HasDirect()
}

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
	fmt.Fprintf(&b, "You are working in the `%s` workspace.\n\n", res.Ref)
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

	b.WriteString("cd into the relevant project's directory before running commands or editing files there.\n")
	b.WriteString("Wait for my instructions on what to build.\n")

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
