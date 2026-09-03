package exec

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/debug"
)

// CreateGitWorktree creates a git worktree at wtDir with the given branch.
// If fromBranch is non-empty, it bases the new branch on that.
// If the branch already exists, it falls back to reusing it.
func CreateGitWorktree(projectPath, wtDir, branch, fromBranch string) error {
	debug.Log("git", "worktree add %s -b %s (from: %s)", wtDir, branch, fromBranch)
	var cmd *exec.Cmd
	if fromBranch != "" {
		cmd = exec.Command("git", "worktree", "add", wtDir, "-b", branch, fromBranch)
	} else {
		cmd = exec.Command("git", "worktree", "add", wtDir, "-b", branch)
	}
	cmd.Dir = projectPath

	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if strings.Contains(msg, "already exists") {
			debug.Log("git", "worktree add %s → branch exists, reusing", wtDir)
			return createWorktreeReuse(projectPath, wtDir, branch)
		}
		if msg != "" {
			debug.Log("git", "worktree add %s → error: %s", wtDir, msg)
			return fmt.Errorf("%s", msg)
		}
		debug.Log("git", "worktree add %s → error: %v", wtDir, err)
		return err
	}
	return nil
}

func createWorktreeReuse(projectPath, wtDir, branch string) error {
	cmd := exec.Command("git", "worktree", "add", wtDir, branch)
	cmd.Dir = projectPath
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return fmt.Errorf("%s", msg)
		}
		return err
	}
	return nil
}

// RemoveGitWorktree removes a git worktree.
func RemoveGitWorktree(projectPath, wtDir string) {
	debug.Log("git", "worktree remove %s --force", wtDir)
	cmd := exec.Command("git", "worktree", "remove", wtDir, "--force")
	cmd.Dir = projectPath
	cmd.Run()
}

// HasEnvFiles reports whether dir holds any .env* file.
func HasEnvFiles(dir string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, e := range entries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), ".env") {
			return true
		}
	}
	return false
}

// CopyEnvFiles copies .env* files from src to dst.
func CopyEnvFiles(srcDir, dstDir string) {
	entries, err := os.ReadDir(srcDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), ".env") {
			data, err := os.ReadFile(filepath.Join(srcDir, e.Name()))
			if err == nil {
				os.WriteFile(filepath.Join(dstDir, e.Name()), data, 0o644)
			}
		}
	}
}

// RunGitCommand runs an arbitrary git command in the given directory and returns stdout.
func RunGitCommand(dir string, args ...string) (string, error) {
	debug.Log("git", "git %s in %s", strings.Join(args, " "), dir)
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		debug.Log("git", "git %s → error: %v", strings.Join(args, " "), err)
		return "", err
	}
	return string(out), nil
}

// PruneWorktrees runs git worktree prune in the given directory.
func PruneWorktrees(dir string) {
	debug.Log("git", "worktree prune in %s", dir)
	cmd := exec.Command("git", "worktree", "prune")
	cmd.Dir = dir
	cmd.Run()
}

// MoveGitWorktree relocates a checked-out worktree, keeping git's gitdir
// pointer valid.
//
// The caller must create the destination's PARENT and leave the leaf absent:
// `git worktree move` onto an existing directory nests inside it and exits 0,
// producing a wrong path with a success code.
//
// `git worktree move` refuses locked worktrees and worktrees containing
// submodules, so a plain rename plus `git worktree repair` is the fallback —
// repair rewrites the pointers a rename leaves stale.
func MoveGitWorktree(projectPath, oldPath, newPath string) error {
	debug.Log("git", "worktree move %s → %s", oldPath, newPath)

	cmd := exec.Command("git", "worktree", "move", oldPath, newPath)
	cmd.Dir = projectPath
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err == nil {
		return nil
	}

	msg := strings.TrimSpace(stderr.String())
	debug.Log("git", "worktree move failed (%s) — falling back to rename + repair", msg)

	if err := os.Rename(oldPath, newPath); err != nil {
		return fmt.Errorf("%s (rename fallback: %w)", msg, err)
	}

	repair := exec.Command("git", "worktree", "repair", newPath)
	repair.Dir = projectPath
	var repairErr bytes.Buffer
	repair.Stderr = &repairErr
	if err := repair.Run(); err != nil {
		return fmt.Errorf("moved %s but `git worktree repair` failed: %s", newPath, strings.TrimSpace(repairErr.String()))
	}
	return nil
}

// RenameGitBranch renames the branch checked out at wtDir. Best-effort: a
// worktree on a detached HEAD or an unexpected branch is left as it is.
func RenameGitBranch(wtDir, oldName, newName string) {
	if oldName == newName {
		return
	}

	current, err := RunGitCommand(wtDir, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil || strings.TrimSpace(current) != oldName {
		debug.Log("git", "branch rename skipped in %s (on %q, expected %q)", wtDir, strings.TrimSpace(current), oldName)
		return
	}

	debug.Log("git", "branch -m %s %s in %s", oldName, newName, wtDir)
	cmd := exec.Command("git", "branch", "-m", newName)
	cmd.Dir = wtDir
	cmd.Run()
}

// RunGitCommandTimeout is RunGitCommand with a deadline, for anything that
// touches the network. A fetch against an unreachable remote must not hang
// the TUI.
func RunGitCommandTimeout(dir string, timeout time.Duration, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	debug.Log("git", "git %s in %s (timeout %s)", strings.Join(args, " "), dir, timeout)
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		debug.Log("git", "git %s → error: %v", strings.Join(args, " "), err)
		return "", err
	}
	return string(out), nil
}
