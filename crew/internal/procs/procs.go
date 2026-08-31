// Package procs takes inventory of the processes crew is responsible for and
// reclaims them.
//
// It exists because leaked dev-server processes accumulated until the per-user
// process limit was reached and no new terminals could open. Sessions crew
// still tracks are torn down by their owning packages; this package's own job
// is the tier those owners cannot reach — processes whose tmux session is long
// gone.
//
// Everything here is shaped by one hazard: a crew-launched Claude session runs
// with its working directory inside the workspace tree, as do the shells,
// language servers, and test runs beneath it. Killing by directory alone
// destroys live work. See killable for the gate that prevents it.
package procs

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/config"
	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

// Session is a crew-owned tmux session and the processes running in it.
type Session struct {
	Name  string `json:"name"`
	Procs []Proc `json:"procs"`
}

// Proc is one process found holding a working directory inside the workspace
// tree.
type Proc struct {
	PID     int    `json:"pid"`
	PPID    int    `json:"ppid"`
	Command string `json:"command"`
	CWD     string `json:"cwd"`
}

// Inventory is what crew is currently responsible for.
//
// Orphans and Attached partition the processes found in the workspace tree:
// Orphans lost their parent and are reclaimable, Attached still belong to
// something running and are reported so it is visible that they were spared.
type Inventory struct {
	Sessions []Session `json:"sessions"`
	Orphans  []Proc    `json:"orphans"`
	Attached []Proc    `json:"attached"`

	// ScanNote is non-empty when the orphan scan could not run. Callers must
	// render it instead of reporting zero orphans — "none found" and "did not
	// look" are different answers and only one of them is ever true here.
	ScanNote string `json:"scan_note,omitempty"`

	UserProcs int `json:"user_procs"`
	MaxProcs  int `json:"max_procs"`
}

// Collect builds the inventory from a single ps snapshot plus one lsof scan.
func Collect() (Inventory, error) {
	rows, err := crewExec.Snapshot()
	if err != nil {
		return Inventory{}, fmt.Errorf("read process table: %w", err)
	}

	inv := Inventory{
		Sessions:  collectSessions(rows),
		UserProcs: len(rows),
		MaxProcs:  maxProcsPerUID(),
	}

	dir, err := workspacesRoot()
	if err != nil {
		inv.ScanNote = "orphan scan unavailable: " + err.Error()
		return inv, nil
	}

	cwds, err := processCWDs()
	if err != nil {
		inv.ScanNote = fmt.Sprintf("orphan scan unavailable: %v", err)
		return inv, nil
	}

	claimed := claimedPIDs(inv.Sessions, rows)

	inv.Orphans, inv.Attached = partition(rows, cwds, dir, claimed)
	return inv, nil
}

// JSONSlices replaces nil slices with empty ones so --json emits [] rather than
// null, matching the other list commands.
func (inv *Inventory) JSONSlices() {
	if inv.Sessions == nil {
		inv.Sessions = []Session{}
	}
	if inv.Orphans == nil {
		inv.Orphans = []Proc{}
	}
	if inv.Attached == nil {
		inv.Attached = []Proc{}
	}
}

// workspacesRoot returns the workspace tree to scan, or an error explaining why
// no scan may run.
//
// The validation is the most important code in this package. config.ConfigDir
// and its derivatives are package globals set in config.Init; before that they
// are "". Since the orphan rule is "working directory under this path", an
// empty value makes every process on the machine a match, and the reclaim would
// SIGKILL the user's entire session. Refusing to scan is always the safe
// answer — a missed cleanup costs a reboot, a wrong one costs the user's work.
func workspacesRoot() (string, error) {
	dir := config.WorkspacesDir
	if dir == "" {
		return "", fmt.Errorf("workspaces directory is not configured")
	}
	if !filepath.IsAbs(dir) {
		return "", fmt.Errorf("workspaces directory %q is not absolute", dir)
	}
	clean := filepath.Clean(dir)
	if len(strings.Split(strings.Trim(clean, string(os.PathSeparator)), string(os.PathSeparator))) < 2 {
		return "", fmt.Errorf("workspaces directory %q is too broad to scan safely", clean)
	}
	// The home directory itself, or anything containing it, is a
	// misconfiguration one level off from the real value — scanning it would
	// sweep the user's whole account rather than crew's workspaces.
	if home, err := os.UserHomeDir(); err == nil && (clean == home || underDir(home, clean)) {
		return "", fmt.Errorf("workspaces directory %q is too broad to scan safely", clean)
	}

	// Compare against the kernel's resolved path. lsof reports the real path,
	// while this one is built from the home directory, and on macOS those differ
	// wherever a firmlink or symlink sits in between (/var vs /private/var being
	// the common case). A textual mismatch would not error — it would silently
	// match nothing and report zero orphans forever.
	resolved, err := filepath.EvalSymlinks(clean)
	if err != nil {
		if os.IsNotExist(err) {
			// No workspaces created yet: nothing to scan, and nothing to warn
			// about either.
			return clean, nil
		}
		return "", fmt.Errorf("cannot resolve workspaces directory %q: %w", clean, err)
	}
	return resolved, nil
}

// claimedPIDs is the set of processes a live crew session accounts for.
//
// It covers each session's processes and everything ABOVE them. The ancestors
// matter because the tmux server daemonizes: it runs with ppid 1 and inherits
// the working directory crew was launched from, so starting a session from
// inside a workspace makes the server itself look exactly like an abandoned
// process. It is every pane's parent and never a descendant, so walking down
// from panes cannot see it — and killing it would destroy every tmux session on
// the machine, crew's and the user's alike. Sparing whole ancestor chains
// covers any supervisor whose children are still running.
func claimedPIDs(sessions []Session, rows []crewExec.ProcRow) map[int]bool {
	parent := make(map[int]int, len(rows))
	for _, r := range rows {
		parent[r.PID] = r.PPID
	}

	claimed := map[int]bool{}
	for _, s := range sessions {
		for _, p := range s.Procs {
			for cur := p.PID; cur > 1 && !claimed[cur]; cur = parent[cur] {
				claimed[cur] = true
				if _, ok := parent[cur]; !ok {
					break
				}
			}
		}
	}
	return claimed
}

// underDir reports whether path is dir itself or lies beneath it. The separator
// is required so that a sibling like "…/workspaces-backup" cannot match
// "…/workspaces".
func underDir(path, dir string) bool {
	if path == dir {
		return true
	}
	return strings.HasPrefix(path, dir+string(os.PathSeparator))
}

// partition splits the processes living in the workspace tree into the ones
// safe to reclaim and the ones that must be spared.
func partition(rows []crewExec.ProcRow, cwds map[int]string, dir string, claimed map[int]bool) (orphans, attached []Proc) {
	byPID := make(map[int]crewExec.ProcRow, len(rows))
	for _, r := range rows {
		byPID[r.PID] = r
	}

	roots := map[int]bool{}
	inTree := map[int]crewExec.ProcRow{}
	for _, r := range rows {
		cwd, ok := cwds[r.PID]
		if !ok || !underDir(cwd, dir) {
			continue
		}
		inTree[r.PID] = r
		if r.PPID == 1 {
			roots[r.PID] = true
		}
	}

	// An orphan root's descendants are reclaimable with it even though their own
	// parent is alive — that parent is the orphan.
	reclaimable := map[int]bool{}
	for pid := range roots {
		reclaimable[pid] = true
	}
	for pid := range inTree {
		// seen guards against a cycle in the ppid graph. ps is not atomic and
		// pids are reused, so a self-parenting or mutually-parenting pair is
		// possible, and without this the scan spins forever with no output.
		seen := map[int]bool{}
		for cur := pid; !seen[cur]; {
			seen[cur] = true
			r, ok := byPID[cur]
			if !ok || r.PPID <= 1 {
				break
			}
			if reclaimable[r.PPID] {
				reclaimable[pid] = true
				break
			}
			cur = r.PPID
		}
	}

	for pid, r := range inTree {
		p := Proc{PID: r.PID, PPID: r.PPID, Command: r.Command, CWD: cwds[pid]}
		if reclaimable[pid] && !claimed[pid] {
			orphans = append(orphans, p)
			continue
		}
		attached = append(attached, p)
	}

	sortProcs(orphans)
	sortProcs(attached)
	return orphans, attached
}
