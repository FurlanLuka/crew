package workspace

import (
	"fmt"
	"os"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/exec"
)

// needsPrompt reports whether a launch should inject the orientation prompt.
//
// Multi-project workspaces need it to find their projects. A workspace holding
// any direct-mode project needs it for the CAUTION framing regardless of size:
// both launch modes skip permissions, so a lone direct project would otherwise
// drop Claude into the user's canonical repo with no warning at all.
func needsPrompt(ws *Workspace) bool {
	if len(ws.Projects) > 1 {
		return true
	}
	for _, wp := range ws.Projects {
		if IsDirect(wp) {
			return true
		}
	}
	return false
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

// GeneratePrompt writes the workspace orientation prompt and returns its text.
// It orients a single Claude instance to every project in the workspace by
// listing names, working directories, and roles.
//
// Projects are labelled `[worktree]` or `[direct]` because the distinction
// changes what is safe to do: worktree projects are isolated copies, while
// direct projects point at the canonical repository, so a mistaken commit or
// branch switch there lands in the user's real repo. Both launch modes run
// Claude with permissions skipped, which makes this framing the only thing
// warning it off the user's working tree.
func GeneratePrompt(ws *Workspace) (string, error) {
	var b strings.Builder
	fmt.Fprintf(&b, "You are working in the `%s` workspace.\n\n", ws.Name)
	b.WriteString("It contains the following projects:\n\n")

	hasWorktree := false
	hasDirect := false
	for _, wp := range ws.Projects {
		path := ResolvePath(ws.Name, wp)
		role := wp.Role
		if role == "" {
			role = "(no role specified)"
		}
		modeLabel := "worktree"
		if IsDirect(wp) {
			modeLabel = "direct"
			hasDirect = true
		} else {
			hasWorktree = true
		}
		fmt.Fprintf(&b, "- **%s** [%s] (%s): %s\n", wp.Name, modeLabel, path, role)
	}
	b.WriteString("\n")

	if hasWorktree {
		b.WriteString("IMPORTANT: `[worktree]` projects are git worktrees — isolated working copies with their own branches.\n")
		b.WriteString("All changes in worktree projects stay isolated from the main codebase until explicitly merged.\n\n")
	}

	if hasDirect {
		b.WriteString("CAUTION: `[direct]` projects point at the canonical repository — changes are NOT isolated. ")
		b.WriteString("Confirm with the user before committing or switching branches in a direct project.\n")
		for _, wp := range ws.Projects {
			if !IsDirect(wp) {
				continue
			}
			path := ResolvePath(ws.Name, wp)
			branch := currentBranch(path)
			if branch == "" {
				fmt.Fprintf(&b, "  - **%s** is on a detached HEAD or unknown branch at %s.\n", wp.Name, path)
			} else {
				fmt.Fprintf(&b, "  - **%s** is currently on branch `%s` at %s.\n", wp.Name, branch, path)
			}
		}
		b.WriteString("\n")
	}

	b.WriteString("cd into the relevant project's directory before running commands or editing files there.\n")
	b.WriteString("Wait for my instructions on what to build.\n")

	text := b.String()
	if err := os.WriteFile(PromptFilePath(ws.Name), []byte(text), 0o644); err != nil {
		return "", err
	}
	return text, nil
}
