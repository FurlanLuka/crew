package procs

import (
	"fmt"
	"sort"
	"strings"
	"syscall"

	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

// Report is what a reclaim actually did.
type Report struct {
	Sessions []string
	Killed   []int
	Restore  []string
}

// killable is the single definition of what may be signalled, shared by every
// caller so there is one place to get it right.
//
// The inventory has already applied the gate that matters: a process is only an
// orphan if it lost its parent (or descends from one that did) while holding a
// working directory inside the workspace tree. Anything still attached to a
// living process was classified as Attached and never reaches here — which is
// what spares a running Claude session, the shells and language servers beneath
// it, and an editor's integrated terminal sitting in a worktree. Naming
// processes would not have done this: crew starts Claude via `sh -c`, so the
// process the kernel shows is a shell, and its children are ordinary
// interpreters.
//
// protected additionally excludes crew and its ancestors, so a reclaim run from
// inside a workspace directory cannot kill the shell that launched it.
func killable(orphans []Proc, protected []int) []int {
	skip := map[int]bool{}
	for _, pid := range protected {
		skip[pid] = true
	}

	var pids []int
	for _, o := range orphans {
		if o.PID > 1 && !skip[o.PID] {
			pids = append(pids, o.PID)
		}
	}
	sort.Ints(pids)
	return pids
}

// Killable returns the pids a reclaim would signal for this inventory.
func Killable(inv Inventory) ([]int, error) {
	rows, err := crewExec.Snapshot()
	if err != nil {
		return nil, err
	}
	return killable(inv.Orphans, crewExec.ProtectedPIDs(rows)), nil
}

// Reclaim tears down crew's tracked sessions and kills the loose processes in
// inv. Both the TUI and the CLI route through it, so neither can drift into its
// own idea of what is safe to kill.
//
// Teardown is delegated to the packages that own each kind of session: they
// also clear routes files, which killing the tmux session directly would
// strand — leaving the proxy forwarding to a dead upstream.
func Reclaim(inv Inventory) (Report, error) {
	report := Report{Sessions: stopSessions(inv)}

	killed, err := killOrphans(inv.Orphans)
	if err != nil {
		return report, err
	}
	report.Killed = killed
	report.Restore = restoreCommands(inv)
	return report, nil
}

// stopSessions tears down crew's tracked tmux sessions and reports the ones
// that are actually gone afterwards.
//
// Teardown is delegated to the packages that own each kind of session: they
// also clear routes files, which killing the tmux session directly would
// strand, leaving the proxy forwarding to a dead upstream.
func stopSessions(inv Inventory) []string {
	if len(inv.Sessions) == 0 {
		return nil
	}

	debug.Log("procs", "reclaim: stopping dev sessions and proxy")
	dev.StopAll("")

	// Report what is gone rather than what was asked to stop, so the count
	// cannot claim a teardown that silently failed.
	remaining := map[string]bool{}
	for _, name := range crewExec.ListTmuxSessions() {
		remaining[name] = true
	}
	var stopped []string
	for _, s := range inv.Sessions {
		if !remaining[s.Name] {
			stopped = append(stopped, s.Name)
		}
	}
	sort.Strings(stopped)
	return stopped
}

// killOrphans signals the abandoned processes in orphans and returns the ones
// that are gone afterwards.
//
// It touches no tmux session and no config state, which is what lets it be
// exercised directly by a test without disturbing anything the developer is
// running.
func killOrphans(orphans []Proc) ([]int, error) {
	if len(orphans) == 0 {
		return nil, nil
	}

	// Re-read the process table rather than trusting the inventory: it may have
	// been on screen for minutes, and a pid that exited in the meantime can have
	// been reused by something unrelated.
	rows, err := crewExec.Snapshot()
	if err != nil {
		return nil, fmt.Errorf("re-read process table: %w", err)
	}
	live := make(map[int]string, len(rows))
	for _, r := range rows {
		live[r.PID] = r.Command
	}

	targets := killable(orphans, crewExec.ProtectedPIDs(rows))

	// Deepest first: killing a parent can free a pid that a later target would
	// otherwise be matched against after reuse.
	depth := processDepths(rows)
	sort.SliceStable(targets, func(i, j int) bool { return depth[targets[i]] > depth[targets[j]] })

	byPID := make(map[int]string, len(orphans))
	for _, o := range orphans {
		byPID[o.PID] = o.Command
	}

	for _, pid := range targets {
		if cmd, alive := live[pid]; !alive || cmd != byPID[pid] {
			debug.Log("procs", "skip %d: gone or recycled since the scan", pid)
			continue
		}
		debug.Log("procs", "reclaim SIGKILL %d (%s)", pid, byPID[pid])
		if err := syscall.Kill(pid, syscall.SIGKILL); err != nil {
			debug.Log("procs", "kill %d → %v", pid, err)
		}
	}

	return reclaimed(orphans), nil
}

// processDepths reports how far each process sits below init, so a kill sweep
// can start at the leaves.
func processDepths(rows []crewExec.ProcRow) map[int]int {
	parent := make(map[int]int, len(rows))
	for _, r := range rows {
		parent[r.PID] = r.PPID
	}

	depth := make(map[int]int, len(rows))
	for _, r := range rows {
		n, seen := 0, map[int]bool{}
		for cur := r.PID; cur > 1 && !seen[cur]; cur = parent[cur] {
			seen[cur] = true
			if _, ok := parent[cur]; !ok {
				break
			}
			n++
		}
		depth[r.PID] = n
	}
	return depth
}

// reclaimed returns the listed orphans that are no longer running.
func reclaimed(orphans []Proc) []int {
	rows, err := crewExec.Snapshot()
	if err != nil {
		return nil
	}
	alive := map[int]bool{}
	for _, r := range rows {
		alive[r.PID] = true
	}

	var gone []int
	for _, o := range orphans {
		if !alive[o.PID] {
			gone = append(gone, o.PID)
		}
	}
	sort.Ints(gone)
	return gone
}

// restoreCommands lists what to run to bring back what was stopped, so recovery
// does not depend on remembering.
func restoreCommands(inv Inventory) []string {
	seen := map[string]bool{}
	var cmds []string
	for _, s := range inv.Sessions {
		ws := strings.TrimPrefix(s.Name, "crew-dev-")
		if ws == s.Name || ws == "proxy" || seen[ws] {
			continue
		}
		seen[ws] = true
		cmds = append(cmds, "crew dev start "+ws)
	}
	sort.Strings(cmds)
	return cmds
}

// Summary is the one line that matters when deciding whether to reclaim: how
// close the machine is to the per-user process ceiling that crew's leaks used
// to exhaust.
func Summary(inv Inventory) string {
	crew := 0
	for _, s := range inv.Sessions {
		crew += len(s.Procs)
	}
	crew += len(inv.Orphans)

	if inv.MaxProcs > 0 {
		return fmt.Sprintf("crew: %d processes · user total %d/%d", crew, inv.UserProcs, inv.MaxProcs)
	}
	return fmt.Sprintf("crew: %d processes · user total %d", crew, inv.UserProcs)
}
