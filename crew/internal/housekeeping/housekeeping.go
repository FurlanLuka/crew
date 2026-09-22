// Package housekeeping clears what crew leaves behind and nobody comes back
// for: failed checks past their keep time, the setup, log and route files of
// worktrees that no longer exist, lock files with no workspace, the trash.
// No daemon — a sweep on every start (at most once an hour) and `crew clean`
// on demand; the decision is a pure plan over collected facts, so what gets
// removed is a table, not a guess.
package housekeeping

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/trash"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

const (
	// KeepChecks is how long a failed check stays for someone to read its
	// evidence. Fixed until someone needs a knob.
	KeepChecks = 7 * 24 * time.Hour
	// lockGrace: a lock with no workspace file is also what creation looks
	// like for a moment (the lock is taken before the file is written).
	lockGrace = time.Hour
	// startInterval: the sweep on start is skipped while a stamp is younger.
	startInterval = time.Hour
)

// Kind is what an action removes.
type Kind string

const (
	KindCheck  Kind = "check"  // a failed check past its keep time, or a passed one nobody looked at
	KindSetup  Kind = "setup"  // runner files of a slug that no longer exists
	KindLogs   Kind = "logs"   // dev logs of a slug that no longer exists
	KindRoutes Kind = "routes" // a route file of a slug that no longer exists
	KindLock   Kind = "lock"   // a lock file with no workspace or check record behind it
	KindTrash  Kind = "trash"  // removed checkouts still in the trash
	KindPrune  Kind = "prune"  // git worktree prune on a pool repo (clean only)
)

// Action is one thing the sweep does. Path is what goes — for a check its
// target dir, the one `ls worktrees` shows; the record and branch go with
// it through workspace.RemoveCheck, keyed by project.
type Action struct {
	Kind Kind   `json:"kind"`
	Path string `json:"path"`
	// Removed: it happened — a prune ran, the trash's detached rm was
	// started; false on a dry run or a failure (Err says).
	Removed bool   `json:"removed"`
	Err     string `json:"error,omitempty"`
	project string
}

// CheckState is a check as the planner sees it.
type CheckState struct {
	Project string
	At      time.Time
	Failed  bool // health recorded, or a runner that vanished without a verdict
	Running bool // a runner is alive
	Passed  bool // done clean, target still there (nobody applied the verdict)
}

// State is every fact the plan decides over. Collected once; pure after.
type State struct {
	Checks    []CheckState
	LiveSlugs map[dev.Slug]bool // every worktree's and every kept check's slug
	SetupDirs []dev.Slug        // ~/.crew/setup/<slug>
	// SetupAges is when each setup dir was last written: a passed check
	// keeps no record, only its ✓ table there, and the table is kept as
	// long as a failed check would be.
	SetupAges map[dev.Slug]time.Time
	LogDirs   []dev.Slug // ~/.crew/logs/<slug>
	Routes    []dev.Slug // dev-routes-<slug>.json
	Locks     []Lock     // workspaces/*.json.lock, checks/*.json.lock
	Trash     int        // entries in the trash
	Repos     []string   // pool repo paths, for prune
}

// Lock is a record's lock file and whether the record is there.
type Lock struct {
	Path     string
	Orphan   bool // no <name>.json beside it
	Modified time.Time
}

// Options shapes one sweep.
type Options struct {
	DryRun bool
	// Prune runs `git worktree prune` on every pool repo — `crew clean`
	// only; a git spawn per repo on every start is not free, and metadata
	// in a user's repo is theirs.
	Prune bool
	Keep  time.Duration // zero → KeepChecks
	Now   time.Time     // zero → time.Now()
}

// plan is the decision: what to remove, given the facts and the clock.
// Pure; order is by kind then path so the report diffs.
func plan(s State, now time.Time, keep time.Duration) []Action {
	var out []Action
	for _, c := range s.Checks {
		switch {
		case c.Running:
		case c.Passed, c.Failed && now.Sub(c.At) > keep:
			out = append(out, Action{Kind: KindCheck, Path: workspace.WorktreeDir(workspace.CheckRef(c.Project)), project: c.Project})
		}
	}
	for _, slug := range s.SetupDirs {
		if s.LiveSlugs[slug] {
			continue
		}
		// A check's table with no record behind it is a passed check's
		// verdict; it stays for as long as a failed one is kept.
		if isCheckSlug(slug) && now.Sub(s.SetupAges[slug]) <= keep {
			continue
		}
		out = append(out, Action{Kind: KindSetup, Path: workspace.SetupDir(slug)})
	}
	for _, slug := range s.LogDirs {
		if !s.LiveSlugs[slug] {
			out = append(out, Action{Kind: KindLogs, Path: dev.LogDir(slug)})
		}
	}
	for _, slug := range s.Routes {
		if !s.LiveSlugs[slug] {
			out = append(out, Action{Kind: KindRoutes, Path: dev.RoutesFilePath(slug)})
		}
	}
	for _, l := range s.Locks {
		if l.Orphan && now.Sub(l.Modified) > lockGrace {
			out = append(out, Action{Kind: KindLock, Path: l.Path})
		}
	}
	if s.Trash > 0 {
		out = append(out, Action{Kind: KindTrash, Path: config.TrashDir})
	}
	for _, repo := range s.Repos {
		out = append(out, Action{Kind: KindPrune, Path: repo})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind < out[j].Kind
		}
		return out[i].Path < out[j].Path
	})
	return out
}

// collect reads the facts. Live slugs come from the records — every
// worktree of every workspace, every kept check — never from parsing a
// slug back into names; a slug whose dev or setup tmux session is alive is
// live whatever the records say (a route file alone is not: the file is
// what a crashed stop leaves behind).
func collect(prune bool) State {
	s := State{LiveSlugs: map[dev.Slug]bool{}}
	if names, err := workspace.List(); err == nil {
		for _, name := range names {
			ws, err := workspace.Load(name)
			if err != nil {
				continue
			}
			for _, ref := range workspace.Refs(ws) {
				s.LiveSlugs[ref.Slug()] = true
			}
		}
	}
	if checks, err := workspace.ListChecks(); err == nil {
		for _, c := range checks {
			ref := workspace.CheckRef(c.Project)
			s.LiveSlugs[ref.Slug()] = true
			st, _ := workspace.ReadStatus(ref)
			s.Checks = append(s.Checks, CheckState{
				Project: c.Project,
				At:      c.At,
				Failed:  c.Worktree.Health != nil || st.Failed(),
				Running: st.Running(),
				Passed:  c.Worktree.Health == nil && st.Passed(),
			})
		}
	}
	s.SetupAges = map[dev.Slug]time.Time{}
	for _, slug := range slugDirs(filepath.Join(config.ConfigDir, "setup")) {
		s.SetupDirs = append(s.SetupDirs, slug)
		if info, err := os.Stat(workspace.SetupDir(slug)); err == nil {
			s.SetupAges[slug] = info.ModTime()
		}
	}
	for _, slug := range slugDirs(filepath.Join(config.ConfigDir, "logs")) {
		s.LogDirs = append(s.LogDirs, slug)
	}
	// Every route file, empty or torn ones included — ListAllRoutes skips
	// those, and they are exactly what a crashed stop leaves.
	if files, err := filepath.Glob(dev.RoutesFilePath("*")); err == nil {
		for _, f := range files {
			s.Routes = append(s.Routes, dev.Slug(strings.TrimSuffix(strings.TrimPrefix(filepath.Base(f), "dev-routes-"), ".json")))
		}
	}
	// tmux is asked once per slug the records do not vouch for.
	asked := map[dev.Slug]bool{}
	for _, group := range [][]dev.Slug{s.SetupDirs, s.LogDirs, s.Routes} {
		for _, slug := range group {
			if s.LiveSlugs[slug] || asked[slug] {
				continue
			}
			asked[slug] = true
			if exec.TmuxSessionExists(dev.SessionName(slug)) || exec.TmuxSessionExists(dev.SetupSessionName(slug)) {
				s.LiveSlugs[slug] = true
			}
		}
	}
	s.Locks = append(locks(config.WorkspacesDir), locks(workspace.ChecksDir())...)
	s.Trash = trash.Entries()
	if prune {
		if pool, err := project.List(); err == nil {
			for _, p := range pool {
				if _, err := os.Stat(filepath.Join(p.Path, ".git")); err == nil {
					s.Repos = append(s.Repos, p.Path)
				}
			}
		}
	}
	return s
}

// locks is every <name>.json.lock in dir with whether <name>.json is there.
func locks(dir string) []Lock {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []Lock
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json.lock") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		_, statErr := os.Stat(filepath.Join(dir, strings.TrimSuffix(e.Name(), ".lock")))
		out = append(out, Lock{Path: filepath.Join(dir, e.Name()), Orphan: os.IsNotExist(statErr), Modified: info.ModTime()})
	}
	return out
}

// isCheckSlug: the slug is a check target's — check--<project>. The one
// place a slug is read by shape, and only to age it, never to name it.
func isCheckSlug(slug dev.Slug) bool {
	return strings.HasPrefix(string(slug), workspace.CheckWorkspace+"--")
}

func slugDirs(dir string) []dev.Slug {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []dev.Slug
	for _, e := range entries {
		if e.IsDir() {
			out = append(out, dev.Slug(e.Name()))
		}
	}
	return out
}

// Sweep collects, plans and applies. Every removal is a path under
// ConfigDir or it is refused — the plan is trusted, the filesystem is not.
func Sweep(o Options) []Action {
	if o.Now.IsZero() {
		o.Now = time.Now()
	}
	if o.Keep == 0 {
		o.Keep = KeepChecks
	}
	actions := plan(collect(o.Prune), o.Now, o.Keep)
	for i := range actions {
		apply(&actions[i], o.DryRun)
	}
	return actions
}

// apply does one action. A prune touches the user's repo, by git; every
// other path must be under ConfigDir or it is refused — a check's through
// the workspace package, which trashes the checkout and takes the branch
// and record with it; the trash's is the detached rm.
func apply(a *Action, dryRun bool) {
	if a.Kind != KindPrune && !config.Under(a.Path, config.ConfigDir) {
		a.Err = "outside " + config.ConfigDir + " — refused"
		debug.Log("housekeeping", "%s %s: %s", a.Kind, a.Path, a.Err)
		return
	}
	if dryRun {
		return
	}
	var err error
	switch a.Kind {
	case KindCheck:
		err = workspace.RemoveCheck(a.project)
	case KindPrune:
		exec.PruneWorktrees(a.Path)
	case KindTrash:
		trash.Sweep()
	default:
		err = os.RemoveAll(a.Path)
	}
	if err != nil {
		a.Err = err.Error()
		debug.Log("housekeeping", "%s %s: %v", a.Kind, a.Path, err)
		return
	}
	a.Removed = true
	debug.Log("housekeeping", "%s %s removed", a.Kind, a.Path)
}

// SweepOnStart is what every crew invocation runs first: the full sweep at
// most once an hour, otherwise just the trash — a rm an earlier run
// started may not have finished. Neither for the commands that must not
// (a runner starting, the proxy, clean itself, update), and uninstall
// gets nothing at all: its purge takes ~/.crew whole.
func SweepOnStart(args []string) {
	if len(args) > 0 && args[0] == "uninstall" {
		return
	}
	stamp := filepath.Join(config.ConfigDir, "housekeeping.json")
	info, err := os.Stat(stamp)
	fresh := err == nil && time.Since(info.ModTime()) < startInterval
	if !shouldSweepOnStart(args) || fresh {
		trash.Sweep()
		return
	}
	actions := Sweep(Options{})
	data, _ := json.Marshal(map[string]any{"at": time.Now(), "actions": len(actions)})
	os.WriteFile(stamp, data, 0o644)
}

// shouldSweepOnStart decides from the command line (args after the
// binary). Pure.
func shouldSweepOnStart(args []string) bool {
	if len(args) == 0 {
		return true
	}
	switch args[0] {
	case "_setup", "uninstall", "clean", "update":
		return false
	case "dev":
		return len(args) < 2 || args[1] != "_proxy"
	}
	return true
}

// RenderReport is `crew clean`'s output: one row per action. Pure.
func RenderReport(actions []Action, dryRun bool) string {
	if len(actions) == 0 {
		return "nothing to clean\n"
	}
	var b strings.Builder
	for _, a := range actions {
		outcome := "removed"
		switch {
		case a.Err != "":
			outcome = "failed: " + a.Err
		case dryRun && a.Kind == KindPrune:
			outcome = "would prune"
		case dryRun:
			outcome = "would remove"
		case a.Kind == KindPrune:
			outcome = "pruned"
		}
		fmt.Fprintf(&b, "%s\t%s\t%s\n", a.Kind, a.Path, outcome)
	}
	return b.String()
}
