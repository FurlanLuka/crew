package exec

import (
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/debug"
)

// procRow is one row of a process-table snapshot.
type procRow struct {
	pid  int
	ppid int
	tty  string // normalized ("ttys002"); empty when the process has no controlling terminal
}

// snapshotProcs captures the whole process table in a single ps call.
//
// One snapshot rather than a fork per tree node: walking the tree with repeated
// pgrep calls races against the very thing this package is fixing — a process
// can exit between two calls, reparenting its children to PID 1 and dropping
// them out of the walk mid-traversal. A single snapshot is also the only
// responsible shape for a fix aimed at process exhaustion.
//
// It does not make the kill atomic: pids are signalled from a snapshot taken
// beforehand, so a pid that exits and is recycled in between still takes the
// signal. That exposure is unchanged from the previous implementation.
func snapshotProcs() ([]procRow, error) {
	debug.Log("tmux", "ps -axo pid,ppid,tty")
	out, err := exec.Command("ps", "-axo", "pid,ppid,tty").Output()
	if err != nil {
		debug.Log("tmux", "ps -axo pid,ppid,tty → error: %v", err)
		return nil, err
	}
	return parseProcRows(string(out)), nil
}

// parseProcRows parses `ps -axo pid,ppid,tty` output. The header row and any
// line that doesn't yield two numeric ids are skipped.
func parseProcRows(out string) []procRow {
	var rows []procRow
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		ppid, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		rows = append(rows, procRow{pid: pid, ppid: ppid, tty: normalizeTTY(fields[2])})
	}
	return rows
}

// normalizeTTY reduces a tty to its bare device name so values from ps and from
// tmux's #{pane_tty} compare equal. ps writes "??" (and tmux can write "?") for
// a process with no controlling terminal; both normalize to "".
func normalizeTTY(tty string) string {
	name := strings.TrimPrefix(tty, "/dev/")
	if strings.Trim(name, "?") == "" {
		return ""
	}
	return name
}

// selectVictims returns the pids to kill for a pane, sorted.
//
// Victims are the union of two lookups, because neither is complete alone:
//
//   - descendants of the pane shell in the ppid graph — catches processes that
//     detached from the pane tty, since setsid() changes session and process
//     group but leaves ppid intact
//   - processes holding the pane's controlling tty — catches processes whose
//     intermediate parent already exited, reparenting them to PID 1 and cutting
//     them out of the ppid graph entirely. These survived every previous
//     teardown and accumulated until the per-user process limit was hit.
//
// The union is broader than the graph walk alone, not complete: a process that
// both setsid()s off the tty and loses its parent is invisible to both lookups.
// macOS exposes no third handle — `ps -o sess=` returns 0 and SIP blocks reading
// other processes' environments — so that case is knowingly uncovered.
//
// protected pids and the pane shell are never returned. The pane shell must
// survive so TmuxRestartLastCommand has a shell to re-run the command in.
func selectVictims(rows []procRow, pane paneRef, protected []int) []int {
	children := make(map[int][]int, len(rows))
	for _, r := range rows {
		children[r.ppid] = append(children[r.ppid], r.pid)
	}

	victims := make(map[int]struct{})

	seen := map[int]bool{pane.pid: true}
	for frontier := []int{pane.pid}; len(frontier) > 0; {
		parent := frontier[0]
		frontier = frontier[1:]
		for _, child := range children[parent] {
			if seen[child] {
				continue
			}
			seen[child] = true
			victims[child] = struct{}{}
			frontier = append(frontier, child)
		}
	}

	if pane.tty != "" {
		for _, r := range rows {
			if r.tty == pane.tty {
				victims[r.pid] = struct{}{}
			}
		}
	}

	delete(victims, pane.pid)
	for _, p := range protected {
		delete(victims, p)
	}

	var pids []int
	for pid := range victims {
		if pid > 1 {
			pids = append(pids, pid)
		}
	}
	sort.Ints(pids)
	return pids
}

// protectedPIDs returns the pids that must never be swept: crew itself and
// every process above it. Keeping this next to selectVictims means a caller
// cannot get the safety-critical set wrong by re-deriving it from prose.
func protectedPIDs(rows []procRow) []int {
	self := os.Getpid()
	return append(ancestorPIDs(self, rows), self)
}

// ancestorPIDs returns every ancestor of pid, walking up the snapshot.
//
// The tty sweep is what widens this package's blast radius, so crew's own
// ancestors have to be protected too, not just crew itself: if crew is ever run
// from inside the pane being torn down, every shell between the pane shell and
// crew shares that tty and would otherwise be killed.
func ancestorPIDs(pid int, rows []procRow) []int {
	parent := make(map[int]int, len(rows))
	for _, r := range rows {
		parent[r.pid] = r.ppid
	}

	var ancestors []int
	seen := map[int]bool{}
	for cur := pid; cur > 1 && !seen[cur]; {
		seen[cur] = true
		p, ok := parent[cur]
		if !ok {
			break
		}
		ancestors = append(ancestors, p)
		cur = p
	}
	return ancestors
}
