package exec

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

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

// RunNpmInstall runs npm install in dir if package.json exists.
func RunNpmInstall(dir string) {
	if _, err := os.Stat(filepath.Join(dir, "package.json")); err != nil {
		return
	}
	debug.Log("git", "npm install --silent in %s", dir)
	cmd := exec.Command("npm", "install", "--silent")
	cmd.Dir = dir
	cmd.Run()
}

// GetCurrentBranch returns the current branch name for the given dir.
func GetCurrentBranch(dir string) string {
	cmd := exec.Command("git", "branch", "--show-current")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		debug.Log("git", "branch --show-current in %s → error: %v", dir, err)
		return ""
	}
	branch := strings.TrimSpace(string(out))
	debug.Log("git", "branch --show-current in %s → %s", dir, branch)
	return branch
}

// PushBranch pushes the current branch in dir.
func PushBranch(dir string) error {
	branch := GetCurrentBranch(dir)
	if branch == "" {
		return nil
	}
	debug.Log("git", "push -u origin %s in %s", branch, dir)
	cmd := exec.Command("git", "push", "-u", "origin", branch)
	cmd.Dir = dir
	if err := cmd.Run(); err != nil {
		debug.Log("git", "push -u origin %s → error: %v", branch, err)
		return err
	}
	return nil
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
