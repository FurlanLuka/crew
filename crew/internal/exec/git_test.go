package exec

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestCopyEnvFiles(t *testing.T) {
	src := t.TempDir()
	dst := t.TempDir()

	// Create source files
	os.WriteFile(filepath.Join(src, ".env"), []byte("KEY=val"), 0o644)
	os.WriteFile(filepath.Join(src, ".env.local"), []byte("LOCAL=1"), 0o644)
	os.WriteFile(filepath.Join(src, ".local.env"), []byte("OVR=1"), 0o644)
	os.WriteFile(filepath.Join(src, "example.local.env"), []byte("X=1"), 0o644)
	os.WriteFile(filepath.Join(src, "README.md"), []byte("# hi"), 0o644)

	CopyEnvFiles(src, dst)

	// A get-env script's local override file comes along; a tracked example
	// (not a dotfile) does not need to.
	if _, err := os.Stat(filepath.Join(dst, ".local.env")); err != nil {
		t.Error(".local.env not copied")
	}
	if _, err := os.Stat(filepath.Join(dst, "example.local.env")); !os.IsNotExist(err) {
		t.Error("example.local.env should not be copied")
	}

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

	removeGitWorktree(dir, wtDir)
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
	removeGitWorktree(dir, wtDir)

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
	removeGitWorktree(dir, wtDir2)
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

	removeGitWorktree(dir, wtDir)
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

// removeGitWorktree is test teardown; production code trashes and prunes.
func removeGitWorktree(projectPath, wtDir string) {
	cmd := exec.Command("git", "worktree", "remove", wtDir, "--force")
	cmd.Dir = projectPath
	cmd.Run()
}

// A repo hook that fails on the all-zeros ref git hands it under worktree
// add (the shape of a checked-in check-dependencies hook) must not fail
// crew's checkout — the hook is for the user's checkout, not crew's.
func TestCreateGitWorktree_SurvivesFailingHook(t *testing.T) {
	if !hasGit() {
		t.Skip("git not available")
	}
	dir := initGitRepo(t)
	hooks := filepath.Join(dir, ".githooks")
	os.MkdirAll(hooks, 0o755)
	os.WriteFile(filepath.Join(hooks, "post-checkout"), []byte("#!/bin/sh\nexit 1\n"), 0o755)
	cmd := exec.Command("git", "config", "core.hooksPath", ".githooks")
	cmd.Dir = dir
	cmd.Run()

	wtDir := filepath.Join(dir, "worktrees", "hooked")
	if err := CreateGitWorktree(dir, wtDir, "wt-hooked", ""); err != nil {
		t.Fatalf("CreateGitWorktree under a failing hook: %v", err)
	}
	if _, err := os.Stat(filepath.Join(wtDir, "README.md")); err != nil {
		t.Error("the checkout should be there")
	}
}

// The user reads git's last line, where the reason is.
func TestCreateGitWorktree_ErrorIsTheLastLine(t *testing.T) {
	if !hasGit() {
		t.Skip("git not available")
	}
	dir := initGitRepo(t)
	err := CreateGitWorktree(dir, filepath.Join(dir, "worktrees", "x"), "wt-x", "no-such-branch")
	if err == nil || strings.HasPrefix(err.Error(), "Preparing") || !strings.Contains(err.Error(), "fatal:") {
		t.Errorf("err = %v, want git's fatal line", err)
	}
}

func TestGitReason(t *testing.T) {
	for in, want := range map[string]string{
		"Preparing worktree (new branch 'x')\nfatal: bad object 0000\n":                                                                              "fatal: bad object 0000",
		"Preparing worktree\nfatal: '/x' is a missing but already registered worktree;\nuse 'add -f' to override, or 'prune' or 'remove' to clear\n": "fatal: '/x' is a missing but already registered worktree;",
		"just a line\n": "just a line",
	} {
		if got := gitReason(in); got != want {
			t.Errorf("gitReason(%q) = %q, want %q", in, got, want)
		}
	}
}

// A registration left over from a deleted directory must not block a
// second checkout of the same branch.
func TestCreateGitWorktree_ReuseAfterDirectoryGone(t *testing.T) {
	if !hasGit() {
		t.Skip("git not available")
	}
	dir := initGitRepo(t)
	wtDir := filepath.Join(dir, "worktrees", "again")
	if err := CreateGitWorktree(dir, wtDir, "wt-again", ""); err != nil {
		t.Fatal(err)
	}
	os.RemoveAll(wtDir) // the wiped ~/.crew case: git still has it registered
	if err := CreateGitWorktree(dir, wtDir, "wt-again", ""); err != nil {
		t.Fatalf("second checkout after the directory vanished: %v", err)
	}
}

func TestLastLine(t *testing.T) {
	for in, want := range map[string]string{
		"Preparing worktree (new branch 'x')\nfatal: bad object 0000\n": "fatal: bad object 0000",
		"one\n\n  \n": "one",
		"":            "",
	} {
		if got := lastLine(in); got != want {
			t.Errorf("lastLine(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestTrustMise_NoConfigIsNoop(t *testing.T) {
	TrustMise(t.TempDir()) // nothing to trust: no mise call, no panic
	if HasMiseConfig(t.TempDir()) {
		t.Error("an empty dir has no mise config")
	}
}

// A checkout with a mise.toml on a machine without mise is still a fine
// checkout; both spellings of the config count.
func TestTrustMise_WithoutMiseOnPath(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	for _, name := range []string{"mise.toml", ".mise.toml"} {
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, name), []byte(""), 0o644)
		if !HasMiseConfig(dir) {
			t.Errorf("%s should count as mise config", name)
		}
		TrustMise(dir) // must not panic or fail without the binary
	}
}

func TestIsEnvFile(t *testing.T) {
	for name, want := range map[string]bool{
		".env": true, ".env.local": true, ".env.phone-speak-evals": true,
		".local.env": true, ".local-overrides.env": true, ".development.env": true,
		"example.local.env": false, "local.env": false, ".envrc": true, ".sops.yaml": false, "README.md": false,
	} {
		if got := IsEnvFile(name); got != want {
			t.Errorf("IsEnvFile(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestIsGitURL(t *testing.T) {
	for s, want := range map[string]bool{
		"git@github.com:o/r.git": true, "https://github.com/o/r": true, "http://x/r.git": true,
		"ssh://git@x/r.git": true, "git://x/r": true, "file:///tmp/r.git": true,
		"/abs/path": false, "./x": false, "../x": false, "~/x": false, "name": false, "o/r": false, "a/b/c": false, "github.com/o/r": false,
	} {
		if got := IsGitURL(s); got != want {
			t.Errorf("IsGitURL(%q) = %v, want %v", s, got, want)
		}
	}
}

// Clone from a file:// remote lands a working copy whose origin/HEAD names
// the remote's branch; a bad remote leaves nothing behind and git's last
// line in the error. DeleteBranch tolerates a branch that is not there.
func TestClone_RemoteHeadBranch_DeleteBranch(t *testing.T) {
	if !hasGit() {
		t.Skip("git not available")
	}
	seed := initGitRepo(t)
	RunGitCommand(seed, "branch", "-M", "master")
	target := filepath.Join(t.TempDir(), "clones", "api")
	if err := Clone("file://"+seed, target); err != nil {
		t.Fatalf("Clone: %v", err)
	}
	if _, err := os.Stat(filepath.Join(target, "README.md")); err != nil {
		t.Error("the clone should have the seed's files")
	}
	if got := RemoteHeadBranch(target); got != "master" {
		t.Errorf("RemoteHeadBranch = %q, want master", got)
	}
	if got := RemoteHeadBranch(seed); got != "" {
		t.Errorf("no origin: %q", got)
	}
	RunGitCommand(target, "branch", "scratch")
	DeleteBranch(target, "scratch")
	DeleteBranch(target, "scratch")
	if out, _ := RunGitCommand(target, "branch", "--list", "scratch"); strings.TrimSpace(out) != "" {
		t.Errorf("scratch should be deleted: %q", out)
	}

	bad := filepath.Join(t.TempDir(), "nope")
	err := Clone("file://"+filepath.Join(t.TempDir(), "missing.git"), bad)
	if err == nil || !strings.HasPrefix(err.Error(), "git clone: fatal:") || !strings.Contains(err.Error(), "missing.git") {
		t.Errorf("bad remote: the first fatal line names the cause, got %v", err)
	}
	if _, statErr := os.Stat(bad); !os.IsNotExist(statErr) {
		t.Error("a failed clone leaves no directory")
	}
}

// RepoKey folds the transports one repo can be named by into one key, so
// import matches a clone made over ssh against a bundle written over https.
func TestRepoKey(t *testing.T) {
	same := []string{
		"git@github.com:o/r.git",
		"https://github.com/o/r",
		"https://github.com/o/r.git",
		"ssh://git@github.com/o/r.git",
		"https://GitHub.com/o/r/",
		"https://user:token@github.com/o/r.git",
	}
	for _, u := range same {
		if got := RepoKey(u); got != "github.com/o/r" {
			t.Errorf("RepoKey(%q) = %q", u, got)
		}
	}
	if RepoKey("https://github.com/o/R") == RepoKey("https://github.com/o/r") {
		t.Error("the path keeps its case")
	}
	// A port is transport; the scp form needs no user; an absolute scp path
	// keeps one slash.
	for _, pair := range [][2]string{
		{"ssh://git@h:2222/o/r.git", "git@h:o/r.git"},
		{"h:o/r.git", "git@h:o/r.git"},
		{"git@h:/srv/repo.git", "ssh://h/srv/repo"},
	} {
		if RepoKey(pair[0]) != RepoKey(pair[1]) {
			t.Errorf("RepoKey(%q)=%q != RepoKey(%q)=%q", pair[0], RepoKey(pair[0]), pair[1], RepoKey(pair[1]))
		}
	}
	if got := RepoKey("https://user@host"); got != "host" {
		t.Errorf("userinfo without a path = %q", got)
	}
	if got := RedactURL("https://user:token@github.com/o/r.git"); got != "https://github.com/o/r.git" {
		t.Errorf("RedactURL = %q", got)
	}
	if got := RedactURL("git@github.com:o/r.git"); got != "git@github.com:o/r.git" {
		t.Errorf("RedactURL leaves the scp form: %q", got)
	}
	if got := RepoKey("file:///tmp/x.git"); got != "/tmp/x" {
		t.Errorf("file url = %q", got)
	}
	if got := RepoKey("/tmp/bare.git"); got != "/tmp/bare" {
		t.Errorf("bare path = %q", got)
	}
	if got := RepoKey(""); got != "" {
		t.Errorf("empty = %q", got)
	}
}

func TestOriginURL(t *testing.T) {
	if !hasGit() {
		t.Skip("git not available")
	}
	seed := initGitRepo(t)
	if got := OriginURL(seed); got != "" {
		t.Errorf("a plain repo has no origin: %q", got)
	}
	clone := filepath.Join(t.TempDir(), "clone")
	if err := Clone("file://"+seed, clone); err != nil {
		t.Fatal(err)
	}
	if got := OriginURL(clone); got != "file://"+seed {
		t.Errorf("origin = %q", got)
	}
	if got := OriginURL(filepath.Join(t.TempDir(), "missing")); got != "" {
		t.Errorf("a missing dir has no origin: %q", got)
	}
}
