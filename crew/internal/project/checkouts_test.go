package project

import (
	"io/fs"
	"os"
	osexec "os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"testing/fstest"

	"github.com/FurlanLuka/crew/crew/internal/exec"
)

func repoAt(dir string) fstest.MapFS {
	return fstest.MapFS{dir + "/.git/HEAD": {Data: []byte("ref: refs/heads/main\n")}}
}

func merge(parts ...fstest.MapFS) fstest.MapFS {
	out := fstest.MapFS{}
	for _, p := range parts {
		for k, v := range p {
			out[k] = v
		}
	}
	return out
}

func TestClassifyCheckout(t *testing.T) {
	fsys := merge(repoAt("code/store-api"), fstest.MapFS{
		"code/wt/.git":       {Data: []byte("gitdir: /x/.git/worktrees/wt\n")},
		"code/plain/main.go": {Data: []byte("package main\n")},
	})
	for dir, want := range map[string]checkoutKind{
		"code/store-api": repoRoot,
		"code/wt":        linkedWorktree,
		"code/plain":     notCheckout,
		"code/missing":   notCheckout,
	} {
		if got := classifyCheckout(fsys, dir); got != want {
			t.Errorf("classifyCheckout(%s) = %v, want %v", dir, got, want)
		}
	}
}

// Every rule of the walk on one tree: repos listed and not entered, depth
// three at most, hidden dirs, node_modules and the never-scan names skipped
// at any depth, a linked worktree passed over, crew's own dir skipped.
func TestScanFS(t *testing.T) {
	fsys := merge(
		repoAt("code/store-api"),
		repoAt("code/store-api/vendor/inner"), // inside a repo: never reached
		repoAt("code/acme/checkout-api"),
		repoAt("code/acme/team/signals"),
		repoAt("code/a/b/c/too-deep"),
		repoAt("code/.hidden/admin"),
		repoAt("code/node_modules/pkg"),
		repoAt("code/Downloads/infra-ops"),
		repoAt("code/acme/Desktop/store-front"),
		repoAt("projects/infra-ops"),
		repoAt("Documents/secret"), // not a root
		repoAt("code/.crew/projects/store-api"),
		fstest.MapFS{
			"code/wt/.git":       {Data: []byte("gitdir: /x\n")},
			"code/notes/todo.md": {Data: []byte("x")},
		},
	)
	got := scanFS(fsys, []string{"code", "projects", "dev"}, "code/.crew")
	want := []string{"code/acme/checkout-api", "code/acme/team/signals", "code/store-api", "projects/infra-ops"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("scanFS =\n%v\nwant\n%v", got, want)
	}
}

// crew's config dir is skipped even where it is not hidden.
func TestScanFS_SkipsConfigDir(t *testing.T) {
	fsys := merge(repoAt("code/crew-home/projects/store-api"), repoAt("code/store-front"))
	got := scanFS(fsys, []string{"code"}, "code/crew-home")
	if !reflect.DeepEqual(got, []string{"code/store-front"}) {
		t.Errorf("scanFS = %v", got)
	}
}

// A root that is missing or a file is passed over; a symlink (a loop, say)
// is never followed.
func TestScanFS_MissingRootAndSymlink(t *testing.T) {
	fsys := merge(repoAt("repos/store-api"), fstest.MapFS{
		"code":       {Data: []byte("a file, not a dir")},
		"repos/loop": {Mode: fs.ModeSymlink, Data: []byte("../repos")},
	})
	got := scanFS(fsys, []string{"src", "code", "repos"}, "")
	if !reflect.DeepEqual(got, []string{"repos/store-api"}) {
		t.Errorf("scanFS = %v", got)
	}
}

// failingFS refuses to list one directory, the way a dir without read
// permission does.
type failingFS struct {
	fstest.MapFS
	deny string
}

func (f failingFS) ReadDir(name string) ([]fs.DirEntry, error) {
	if name == f.deny {
		return nil, &fs.PathError{Op: "readdir", Path: name, Err: fs.ErrPermission}
	}
	return f.MapFS.ReadDir(name)
}

func TestScanFS_UnreadableDirSkipped(t *testing.T) {
	fsys := failingFS{MapFS: merge(repoAt("code/locked/store-api"), repoAt("code/store-front")), deny: "code/locked"}
	got := scanFS(fsys, []string{"code"}, "")
	if !reflect.DeepEqual(got, []string{"code/store-front"}) {
		t.Errorf("scanFS = %v", got)
	}
}

func TestScanFS_EntryCap(t *testing.T) {
	prev := ScanEntryCap
	ScanEntryCap = 3
	t.Cleanup(func() { ScanEntryCap = prev })
	fsys := merge(repoAt("code/a"), repoAt("code/b"), repoAt("code/c"), repoAt("code/d"), repoAt("projects/e"))
	got := scanFS(fsys, []string{"code", "projects"}, "")
	if !reflect.DeepEqual(got, []string{"code/a", "code/b"}) {
		t.Errorf("the cap should stop the walk early: %v", got)
	}
}

func TestKnownCheckout(t *testing.T) {
	paths := map[string]bool{"/h/code/store-api": true}
	repos := map[string]bool{exec.RepoKey("git@github.com:example/signals.git"): true}
	for _, tt := range []struct {
		dir, remote string
		want        bool
	}{
		{"/h/code/store-api", "", true},
		{"/h/code/signals", "https://github.com/example/signals", true}, // same repo, another transport
		{"/h/code/admin", "git@github.com:example/admin.git", false},
		{"/h/code/plain", "", false},
	} {
		if got := knownCheckout(tt.dir, tt.remote, paths, repos); got != tt.want {
			t.Errorf("knownCheckout(%s, %s) = %v, want %v", tt.dir, tt.remote, got, tt.want)
		}
	}
}

// One real tree: a clone with a remote the pool has, a plain repo, and a
// worktree of it that is never offered.
func TestScanCheckouts_RealGit(t *testing.T) {
	if _, err := osexec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	setupTestConfig(t)
	home := t.TempDir()
	git := func(dir string, args ...string) {
		t.Helper()
		if _, err := exec.RunGitCommand(dir, args...); err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
	}
	seed := filepath.Join(home, "seed-remote")
	os.MkdirAll(seed, 0o755)
	git(seed, "init", "-q", "-b", "main")
	git(seed, "-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
	clone := filepath.Join(home, "code", "store-api")
	if err := exec.Clone("file://"+seed, clone); err != nil {
		t.Fatal(err)
	}
	plain := filepath.Join(home, "repos", "acme", "signals")
	os.MkdirAll(plain, 0o755)
	git(plain, "init", "-q", "-b", "main")
	git(plain, "-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
	git(plain, "worktree", "add", "-q", filepath.Join(home, "repos", "acme", "signals-wt"))

	pool := []Project{{Name: "api", Path: filepath.Join(t.TempDir(), "elsewhere")}}
	// The pool's project shares the clone's remote: known by repo, not path.
	other := filepath.Join(t.TempDir(), "other-clone")
	if err := exec.Clone("file://"+seed, other); err != nil {
		t.Fatal(err)
	}
	pool[0].Path = other

	got := ScanCheckouts(os.DirFS(home), home, filepath.Join(home, ".crew"), pool)
	want := []Checkout{
		{Name: "store-api", Path: clone, Remote: "file://" + seed, Known: true},
		{Name: "signals", Path: plain, Remote: "", Known: false},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("ScanCheckouts =\n%+v\nwant\n%+v", got, want)
	}
	if empty := ScanCheckouts(os.DirFS(t.TempDir()), "/nowhere", "", nil); empty == nil || len(empty) != 0 {
		t.Errorf("nothing found is an empty list, never null: %#v", empty)
	}
}
