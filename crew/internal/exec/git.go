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
	args := []string{"worktree", "add", wtDir, "-b", branch}
	if fromBranch != "" {
		args = append(args, fromBranch)
	}
	msg, err := worktreeAdd(projectPath, args...)
	if err != nil {
		if strings.Contains(msg, "already exists") {
			debug.Log("git", "worktree add %s → branch exists, reusing", wtDir)
			return createWorktreeReuse(projectPath, wtDir, branch)
		}
		debug.Log("git", "worktree add %s → error: %s", wtDir, firstNonEmpty(msg, err.Error()))
		return worktreeError(msg, err)
	}
	return nil
}

func createWorktreeReuse(projectPath, wtDir, branch string) error {
	// A registration for a directory that is gone (a wiped ~/.crew) blocks
	// the add with "already registered"; prune is what git offers for it.
	PruneWorktrees(projectPath)
	msg, err := worktreeAdd(projectPath, "worktree", "add", wtDir, branch)
	if err != nil {
		debug.Log("git", "worktree add %s (reuse) → error: %s", wtDir, firstNonEmpty(msg, err.Error()))
		return worktreeError(msg, err)
	}
	return nil
}

// worktreeAdd runs one git worktree add with the repo's hooks off. A
// post-checkout hook is written for a user's checkout; whether crew's
// exists is not its call, and a hook that fails on the all-zeros ref git
// hands it here would otherwise fail every worktree creation. Returns
// stderr in full so the log keeps it all.
func worktreeAdd(projectPath string, args ...string) (string, error) {
	cmd := exec.Command("git", append([]string{"-c", "core.hooksPath=/dev/null"}, args...)...)
	cmd.Dir = projectPath
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	return strings.TrimSpace(stderr.String()), err
}

// worktreeError is what the user reads: git's "fatal:" or "error:" line —
// the first line is "Preparing worktree", progress; a hint ("use 'add -f'
// …") can trail the reason. Pure.
func worktreeError(stderr string, err error) error {
	if reason := gitReason(stderr); reason != "" {
		return fmt.Errorf("%s", reason)
	}
	return err
}

// gitReason is the last "fatal:"/"error:" line of git's stderr, else the
// last non-empty line.
func gitReason(stderr string) string {
	lines := strings.Split(strings.TrimSpace(stderr), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		l := strings.TrimSpace(lines[i])
		if strings.HasPrefix(l, "fatal:") || strings.HasPrefix(l, "error:") {
			return l
		}
	}
	return lastLine(stderr)
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if l := strings.TrimSpace(lines[i]); l != "" {
			return l
		}
	}
	return ""
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// IsGitURL: a remote git can clone, as opposed to a path on this machine.
// Full URLs only — `owner/repo` is not one, since it is also a relative
// path, and guessing GitHub from a typo would clone the wrong thing. Pure.
func IsGitURL(s string) bool {
	for _, prefix := range []string{"git@", "https://", "http://", "ssh://", "git://", "file://"} {
		if strings.HasPrefix(s, prefix) {
			return true
		}
	}
	return false
}

// OriginURL is the repo's origin URL, or "" — a plain repo has none, a
// path that is gone has none, and neither is an error to anyone asking.
func OriginURL(dir string) string {
	out, err := RunGitCommand(dir, "remote", "get-url", "origin")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// RepoKey is the repo a URL names with the transport stripped, so
// git@github.com:o/r.git and https://github.com/o/r are the same project:
// scheme, user@, a port, .git and a trailing / go; the scp form's ":"
// becomes "/"; the host is lower-cased (the path is not — only some hosts
// fold it). A file:// URL or a bare path keys as its cleaned path. Pure;
// "" for "".
func RepoKey(url string) string {
	s := strings.TrimSpace(url)
	if s == "" {
		return ""
	}
	if rest, ok := strings.CutPrefix(s, "file://"); ok {
		return trimRepo(rest)
	}
	if strings.HasPrefix(s, "/") || strings.HasPrefix(s, ".") {
		return trimRepo(s)
	}
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	} else if host, path, ok := strings.Cut(s, ":"); ok && !strings.Contains(host, "/") {
		// scp form: [user@]host:path — the ":" is the separator whatever
		// comes before it.
		s = host + "/" + strings.TrimPrefix(path, "/")
	}
	if at := strings.LastIndex(s, "@"); at >= 0 && !strings.Contains(s[:at], "/") {
		s = s[at+1:]
	}
	host, path, found := strings.Cut(s, "/")
	if h, _, ok := strings.Cut(host, ":"); ok {
		host = h // a port is transport, not identity
	}
	host = strings.ToLower(host)
	if !found {
		return host
	}
	return host + "/" + trimRepo(path)
}

// trimRepo drops what a remote's path carries that its identity does not.
func trimRepo(path string) string {
	return strings.TrimSuffix(strings.TrimSuffix(path, "/"), ".git")
}

// RedactURL is a remote with its userinfo gone — what a log may carry: a
// remote can hold a token, and CLAUDE.md's rule for bindings applies to it.
func RedactURL(url string) string {
	i := strings.Index(url, "://")
	if i < 0 {
		return url
	}
	rest := url[i+3:]
	if at := strings.Index(rest, "@"); at >= 0 && !strings.Contains(rest[:at], "/") {
		return url[:i+3] + rest[at+1:]
	}
	return url
}

// RemoteHeadBranch is the local name of the branch origin/HEAD points at —
// what a clone checked out, whatever the repo calls it. Empty without one.
func RemoteHeadBranch(dir string) string {
	out, err := RunGitCommand(dir, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")
	if err != nil {
		return ""
	}
	return strings.TrimPrefix(strings.TrimSpace(out), "refs/remotes/origin/")
}

// DeleteBranch removes a local branch, force — for the scratch branch of a
// check that is being replaced. A missing branch is not an error.
func DeleteBranch(dir, branch string) {
	if _, err := RunGitCommand(dir, "branch", "-D", branch); err != nil {
		debug.Log("git", "branch -D %s in %s → %v", branch, dir, err)
	}
}

// Clone runs git clone into a directory that does not exist yet, which is
// why RunGitCommand (which needs a cwd) is not used. Auth and network are
// the user's; git's first "fatal:" line names the cause (the lines after
// it are generic advice), the last line stands in when there is none.
func Clone(remote, target string) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	debug.Log("git", "clone %s %s", RedactURL(remote), target)
	cmd := exec.Command("git", "clone", "--quiet", remote, target)
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		debug.Log("git", "clone %s → error: %v: %s", RedactURL(remote), err, msg)
		if msg == "" {
			msg = err.Error()
		}
		lines := strings.Split(msg, "\n")
		reason := strings.TrimSpace(lines[len(lines)-1])
		for _, l := range lines {
			if strings.HasPrefix(strings.TrimSpace(l), "fatal:") {
				reason = strings.TrimSpace(l)
				break
			}
		}
		return fmt.Errorf("git clone: %s", reason)
	}
	return nil
}

// HasEnvFiles reports whether dir holds any .env* file.
func HasEnvFiles(dir string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, e := range entries {
		if !e.IsDir() && IsEnvFile(e.Name()) {
			return true
		}
	}
	return false
}

// IsEnvFile: the dotfiles a checkout's env lives in — `.env`, `.env.local`,
// and the `.local.env` / `.local-overrides.env` shape a get-env script
// merges its local overrides from. Those are gitignored in some repos and
// would otherwise be the one thing a new checkout lacks. Pure.
func IsEnvFile(name string) bool {
	if !strings.HasPrefix(name, ".") {
		return false
	}
	return strings.HasPrefix(name, ".env") || strings.HasSuffix(name, ".env")
}

// CopyEnvFiles copies .env* files from src to dst.
func CopyEnvFiles(srcDir, dstDir string) {
	entries, err := os.ReadDir(srcDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() && IsEnvFile(e.Name()) {
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
