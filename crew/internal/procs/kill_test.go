package procs

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"syscall"
	"testing"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

func TestKillable_ExcludesProtectedAndInit(t *testing.T) {
	inv := Inventory{Orphans: []Proc{
		{PID: 1}, {PID: 0}, {PID: 500}, {PID: 600}, {PID: 700},
	}}

	got := killable(inv.Orphans, []int{600})

	if want := []int{500, 700}; !reflect.DeepEqual(got, want) {
		t.Errorf("killable = %v, want %v", got, want)
	}
}

func TestKillable_AttachedProcessesAreNeverTargets(t *testing.T) {
	rows, cwds := liveMachineRows()
	orphans, attached := partition(rows, cwds, wsRoot, map[int]bool{})

	got := killable(orphans, nil)

	targets := map[int]bool{}
	for _, pid := range got {
		targets[pid] = true
	}
	for _, a := range attached {
		if targets[a.PID] {
			t.Errorf("pid %d was reported as spared but is in the kill set", a.PID)
		}
	}
}

// The kill set produced for the real machine must never contain this process,
// anything above it, or init. Read-only: nothing is signalled.
func TestKillable_NeverTargetsSelfOrAncestors(t *testing.T) {
	rows, err := crewExec.Snapshot()
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	protected := crewExec.ProtectedPIDs(rows)

	// Every ancestor is claimed as an orphan to prove the exclusion holds even
	// when the classifier has gone completely wrong.
	var orphans []Proc
	for _, pid := range append(protected, 1) {
		orphans = append(orphans, Proc{PID: pid})
	}

	if got := killable(orphans, protected); len(got) != 0 {
		t.Errorf("killable = %v, want empty — self, ancestors and init must never be targets", got)
	}
}

// Runs the real collection against the user's actual workspace tree, computes
// what a reclaim would target, and never signals anything.
//
// On a machine with a crew workspace open in an editor this is exercised
// against the live Claude session and the editor's terminals, which is the
// scenario that matters and which no fixture can fully stand in for.
func TestReclaimTargets_OnRealMachine_SpareEverythingAttached(t *testing.T) {
	// Point at the user's real workspace tree deliberately. config.Init never
	// runs in a test binary, and skipping for that reason would mean this check
	// never runs on the one machine it is meant to protect. Nothing here
	// signals — the assertions are all on the computed target set.
	real, err := realWorkspacesDir()
	if err != nil {
		t.Skipf("cannot resolve the real workspaces dir: %v", err)
	}
	if _, err := os.Stat(real); err != nil {
		t.Skipf("no real workspace tree on this machine: %v", err)
	}
	prev := config.WorkspacesDir
	config.WorkspacesDir = real
	t.Cleanup(func() { config.WorkspacesDir = prev })

	inv, err := Collect()
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if inv.ScanNote != "" {
		t.Skipf("orphan scan did not run: %s", inv.ScanNote)
	}
	if len(inv.Orphans)+len(inv.Attached) == 0 {
		t.Skip("no processes are running inside the workspace tree")
	}

	targets, err := Killable(inv)
	if err != nil {
		t.Fatalf("Killable: %v", err)
	}
	target := map[int]bool{}
	for _, pid := range targets {
		target[pid] = true
	}

	for _, a := range inv.Attached {
		if target[a.PID] {
			t.Errorf("pid %d (%s) still has a live parent but is a kill target", a.PID, a.Command)
		}
	}
	if target[os.Getpid()] {
		t.Error("the running process is a kill target")
	}

	// Every target must genuinely be abandoned: ppid 1, or descended from
	// something that is.
	rows, err := crewExec.Snapshot()
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	byPID := map[int]crewExec.ProcRow{}
	for _, r := range rows {
		byPID[r.PID] = r
	}
	for _, pid := range targets {
		ppid := byPID[pid].PPID
		if ppid > 1 && !target[ppid] {
			t.Errorf("pid %d is a target but its parent %d is alive and untargeted — "+
				"only abandoned processes and their descendants may be reclaimed", pid, ppid)
		}
	}
}

// The one test that signals. Everything it kills is a process it started
// itself, in a temporary workspace tree, and it asserts that before signalling.
func TestReclaim_KillsOnlyItsOwnOrphan(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping process-signalling test")
	}

	dir := useTempWorkspaces(t)
	projectDir := filepath.Join(dir, "ws", "project")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	// The wrapper exits immediately, so the sleeper is reparented to PID 1 while
	// keeping its working directory — the exact shape of a leaked dev server.
	pidFile := filepath.Join(dir, "orphan.pid")
	starter := exec.Command("sh", "-c", "sleep 45 & echo $! > "+pidFile)
	starter.Dir = projectDir
	if err := starter.Run(); err != nil {
		t.Fatalf("start orphan: %v", err)
	}

	var orphan int
	t.Cleanup(func() {
		if orphan > 0 {
			syscall.Kill(orphan, syscall.SIGKILL)
		}
	})

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(pidFile)
		if err == nil {
			if n, err := parsePID(string(data)); err == nil {
				if ppid, ok := ppidOf(n); ok && ppid == 1 {
					orphan = n
					break
				}
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if orphan == 0 {
		t.Fatal("orphan never appeared with ppid 1 — precondition not met")
	}

	inv, err := Collect()
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}

	targets, err := Killable(inv)
	if err != nil {
		t.Fatalf("Killable: %v", err)
	}

	// Nothing may be signalled that this test did not create.
	for _, pid := range targets {
		if pid != orphan {
			t.Fatalf("refusing to reclaim: pid %d was not started by this test", pid)
		}
	}
	if len(targets) != 1 {
		t.Fatalf("targets = %v, want just the orphan %d", targets, orphan)
	}

	// killOrphans, not Reclaim: Reclaim also calls dev.StopAll and plans.Stop,
	// which are scoped to the real machine rather than this test's temp
	// workspaces dir and would stop the developer's running dev servers.
	if config.WorkspacesDir != dir {
		t.Fatalf("workspaces dir drifted to %q before signalling", config.WorkspacesDir)
	}
	if _, err := killOrphans(inv.Orphans); err != nil {
		t.Fatalf("killOrphans: %v", err)
	}

	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, alive := ppidOf(orphan); !alive {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Errorf("orphan %d survived the reclaim", orphan)
}
