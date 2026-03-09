package exec

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestCopyEnvFiles(t *testing.T) {
	src := t.TempDir()
	dst := t.TempDir()

	// Create source files
	os.WriteFile(filepath.Join(src, ".env"), []byte("KEY=val"), 0o644)
	os.WriteFile(filepath.Join(src, ".env.local"), []byte("LOCAL=1"), 0o644)
	os.WriteFile(filepath.Join(src, "README.md"), []byte("# hi"), 0o644)

	CopyEnvFiles(src, dst)

	// .env and .env.local should be copied
	if _, err := os.Stat(filepath.Join(dst, ".env")); err != nil {
		t.Error(".env not copied")
	}
	if _, err := os.Stat(filepath.Join(dst, ".env.local")); err != nil {
		t.Error(".env.local not copied")
	}
	// README.md should NOT be copied
	if _, err := os.Stat(filepath.Join(dst, "README.md")); !os.IsNotExist(err) {
		t.Error("README.md should not be copied")
	}

	// Verify content
	data, _ := os.ReadFile(filepath.Join(dst, ".env"))
	if string(data) != "KEY=val" {
		t.Errorf(".env content = %q, want %q", string(data), "KEY=val")
	}
}

func TestCopyEnvFiles_EmptyDir(t *testing.T) {
	src := t.TempDir()
	dst := t.TempDir()

	// Should not panic on empty dir
	CopyEnvFiles(src, dst)

	entries, _ := os.ReadDir(dst)
	if len(entries) != 0 {
		t.Errorf("dst should be empty, got %d files", len(entries))
	}
}

// --- Integration tests (require git) ---

func hasGit() bool {
	_, err := exec.LookPath("git")
	return err == nil
}

func initGitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	cmd := exec.Command("git", "init")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	// Create initial commit so we have a branch
	os.WriteFile(filepath.Join(dir, "README.md"), []byte("init"), 0o644)
	cmd = exec.Command("git", "add", ".")
	cmd.Dir = dir
	cmd.Run()
	cmd = exec.Command("git", "commit", "-m", "init", "--allow-empty")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=test",
		"GIT_AUTHOR_EMAIL=test@test.com",
		"GIT_COMMITTER_NAME=test",
		"GIT_COMMITTER_EMAIL=test@test.com",
	)
	cmd.Run()
	return dir
}

func TestCreateAndRemoveWorktree(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping git integration test")
	}
	if !hasGit() {
		t.Skip("git not available")
	}

	dir := initGitRepo(t)
	wtDir := filepath.Join(dir, "worktrees", "test-wt")

	err := CreateGitWorktree(dir, wtDir, "wt-test-branch", "")
	if err != nil {
		t.Fatalf("CreateGitWorktree: %v", err)
	}
	if _, err := os.Stat(wtDir); err != nil {
		t.Error("worktree dir should exist after create")
	}

	RemoveGitWorktree(dir, wtDir)
	if _, err := os.Stat(wtDir); !os.IsNotExist(err) {
		t.Error("worktree dir should be gone after remove")
	}
}

func TestCreateWorktree_BranchExists(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping git integration test")
	}
	if !hasGit() {
		t.Skip("git not available")
	}

	dir := initGitRepo(t)
	wtDir := filepath.Join(dir, "worktrees", "reuse-wt")

	// First create
	err := CreateGitWorktree(dir, wtDir, "wt-reuse-branch", "")
	if err != nil {
		t.Fatalf("first CreateGitWorktree: %v", err)
	}

	// Remove the directory but branch still exists in git
	RemoveGitWorktree(dir, wtDir)

	// Second create should fall back to reusing the branch
	wtDir2 := filepath.Join(dir, "worktrees", "reuse-wt2")
	err = CreateGitWorktree(dir, wtDir2, "wt-reuse-branch", "")
	if err != nil {
		t.Fatalf("second CreateGitWorktree: %v", err)
	}
	if _, err := os.Stat(wtDir2); err != nil {
		t.Error("worktree dir should exist after reuse create")
	}

	// Cleanup
	RemoveGitWorktree(dir, wtDir2)
}

func TestCreateGitWorktree_WithFromBranch(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping git integration test")
	}
	if !hasGit() {
		t.Skip("git not available")
	}

	dir := initGitRepo(t)
	wtDir := filepath.Join(dir, "worktrees", "from-branch-wt")

	err := CreateGitWorktree(dir, wtDir, "from-branch-test", "main")
	if err != nil {
		t.Fatalf("CreateGitWorktree with fromBranch: %v", err)
	}
	if _, err := os.Stat(wtDir); err != nil {
		t.Error("worktree dir should exist after create with fromBranch")
	}

	RemoveGitWorktree(dir, wtDir)
}

func TestPruneWorktrees(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping git integration test")
	}
	if !hasGit() {
		t.Skip("git not available")
	}

	dir := initGitRepo(t)
	PruneWorktrees(dir) // should not panic on clean repo
}

func TestRunGitCommand(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping git integration test")
	}
	if !hasGit() {
		t.Skip("git not available")
	}

	dir := initGitRepo(t)

	out, err := RunGitCommand(dir, "status")
	if err != nil {
		t.Fatalf("RunGitCommand: %v", err)
	}
	if out == "" {
		t.Error("RunGitCommand returned empty string")
	}
}
