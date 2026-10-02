package project

import (
	"errors"
	"io/fs"
	"path"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/exec"
)

// The first-run checkout list: where a developer keeps code, walked shallow
// and listed — never analyzed, never added. Adding is crew add project.

// ScanRoots are the folders under home a checkout is looked for in. Never
// Documents, Desktop or Downloads: macOS asks the user before any process
// reads them, and a first run must not open with three permission dialogs.
var ScanRoots = []string{"code", "projects", "dev", "src", "Developer", "work", "repos"}

// neverScan are folder names skipped at any depth, for the same reason as
// the roots' list and because they are never where a repo lives.
var neverScan = map[string]bool{"Documents": true, "Desktop": true, "Downloads": true, "node_modules": true, "Library": true}

// scanDepth is how deep under a root a checkout is looked for:
// ~/code/<org>/<group>/<repo> at most.
const scanDepth = 3

// ScanEntryCap bounds the walk: a root holding a huge tree that is not a
// repo (a data dir, a vendored monorepo) must not keep a first run waiting.
// A var so tests reach it.
var ScanEntryCap = 20000

// Checkout is one row of crew add project --scan.
type Checkout struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	Remote string `json:"remote"`
	// Known: the pool has it already — by path, or by the same remote.
	Known bool `json:"known"`
}

// checkoutKind is what a directory's .git says about it.
type checkoutKind int

const (
	notCheckout    checkoutKind = iota
	repoRoot                    // .git is a directory: a checkout
	linkedWorktree              // .git is a file: a git worktree of another checkout
)

// classifyCheckout reads dir/.git in fsys. A linked worktree is someone's
// working copy of a repo listed elsewhere, so it is never offered. Pure over
// fsys.
func classifyCheckout(fsys fs.FS, dir string) checkoutKind {
	info, err := fs.Stat(fsys, path.Join(dir, ".git"))
	switch {
	case err != nil:
		return notCheckout
	case info.IsDir():
		return repoRoot
	}
	return linkedWorktree
}

// scanStep is what the walk does with one directory.
type scanStep int

const (
	stepDescend scanStep = iota
	stepSkip             // never look inside
	stepList             // a checkout: list it, look no deeper
)

// scanAction decides one directory: depth is how far below its root it is
// (the root is 0), skipDir is a path never to enter (crew's own config dir,
// relative to the walk). Pure.
func scanAction(fsys fs.FS, dir string, depth int, skipDir string) scanStep {
	base := path.Base(dir)
	if depth > 0 && (strings.HasPrefix(base, ".") || neverScan[base]) {
		return stepSkip
	}
	if skipDir != "" && (dir == skipDir || strings.HasPrefix(dir, skipDir+"/")) {
		return stepSkip
	}
	switch classifyCheckout(fsys, dir) {
	case repoRoot:
		return stepList
	case linkedWorktree:
		return stepSkip
	}
	if depth >= scanDepth {
		return stepSkip
	}
	return stepDescend
}

// scanFS walks each root of fsys and returns the checkouts' directories in
// walk order. A missing root, an unreadable directory and a symlink (never
// followed: fs.WalkDir does not) are passed over; the walk stops at
// ScanEntryCap entries. Pure over fsys.
func scanFS(fsys fs.FS, roots []string, skipDir string) []string {
	var found []string
	seen := 0
	for _, root := range roots {
		if info, err := fs.Stat(fsys, root); err != nil || !info.IsDir() {
			continue
		}
		err := fs.WalkDir(fsys, root, func(p string, d fs.DirEntry, err error) error {
			seen++
			if seen > ScanEntryCap {
				return fs.SkipAll
			}
			if err != nil {
				// An unreadable directory: what it holds is not ours to list.
				if d != nil && d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			if !d.IsDir() {
				return nil
			}
			switch scanAction(fsys, p, depthBelow(root, p), skipDir) {
			case stepList:
				found = append(found, p)
				return fs.SkipDir
			case stepSkip:
				return fs.SkipDir
			}
			return nil
		})
		if errors.Is(err, fs.SkipAll) || seen > ScanEntryCap {
			break
		}
	}
	return found
}

func depthBelow(root, p string) int {
	if p == root {
		return 0
	}
	return strings.Count(strings.TrimPrefix(p, root+"/"), "/") + 1
}

// knownCheckout: the pool has this checkout — the same path, or a project
// whose remote is the same repo. Pure.
func knownCheckout(dir, remote string, poolPaths, poolRepos map[string]bool) bool {
	if poolPaths[dir] {
		return true
	}
	return remote != "" && poolRepos[exec.RepoKey(remote)]
}

// ScanCheckouts lists the checkouts under home's ScanRoots, each with its
// remote and whether the pool knows it. skipDir is crew's config dir.
func ScanCheckouts(fsys fs.FS, home, skipDir string, pool []Project) []Checkout {
	rel := ""
	if r, ok := strings.CutPrefix(skipDir, strings.TrimSuffix(home, "/")+"/"); ok {
		rel = r
	}
	poolPaths, poolRepos := map[string]bool{}, map[string]bool{}
	for _, p := range pool {
		poolPaths[p.Path] = true
		if remote := RemoteOf(p); remote != "" {
			poolRepos[exec.RepoKey(remote)] = true
		}
	}
	rows := []Checkout{}
	for _, dir := range scanFS(fsys, ScanRoots, rel) {
		abs := path.Join(home, dir)
		remote := exec.OriginURL(abs)
		rows = append(rows, Checkout{Name: path.Base(dir), Path: abs, Remote: remote, Known: knownCheckout(abs, remote, poolPaths, poolRepos)})
	}
	return rows
}
