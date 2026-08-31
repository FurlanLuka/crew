package procs

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

func TestParseCWDs(t *testing.T) {
	// Shape of `lsof -a -d cwd -Fpn`: p/f/n triplets.
	out := "p91036\n" +
		"fcwd\n" +
		"n/Users/luka/Documents/crew\n" +
		"p91040\n" +
		"fcwd\n" +
		"n/Users/luka/.crew/workspaces/ws/a path with spaces\n" +
		// Directory could not be read: p with no n. Must not inherit the next
		// record's path.
		"p91041\n" +
		"fcwd\n" +
		"p91042\n" +
		"fcwd\n" +
		"n/tmp\n" +
		// Truncated trailing record.
		"p91043\n"

	want := map[int]string{
		91036: "/Users/luka/Documents/crew",
		91040: "/Users/luka/.crew/workspaces/ws/a path with spaces",
		91042: "/tmp",
	}

	if got := parseCWDs(out); !reflect.DeepEqual(got, want) {
		t.Errorf("parseCWDs = %v, want %v", got, want)
	}
}

func TestParseCWDs_IgnoresJunk(t *testing.T) {
	out := "n/orphaned/path/before/any/pid\n" +
		"pnotanumber\n" +
		"n/should/not/attach\n" +
		"p0\n" +
		"n/pid/zero\n" +
		"\n"

	if got := parseCWDs(out); len(got) != 0 {
		t.Errorf("parseCWDs = %v, want empty", got)
	}
}

// The only test that proves the real lsof format is still what the parser
// expects. If it drifts, every fixture test above stays green while the scan
// silently reports zero orphans forever.
//
// It also covers path normalization: config paths are built from
// os.UserHomeDir, lsof returns the kernel's resolved path, and if those differ
// textually (firmlinks, a symlinked home) prefix matching never matches.
func TestProcessCWDs_ReadsRealLsofOutput(t *testing.T) {
	cwds, err := processCWDs()
	if err != nil {
		t.Skipf("lsof unavailable: %v", err)
	}

	got, ok := cwds[os.Getpid()]
	if !ok {
		t.Fatalf("real lsof scan of %d processes did not include the test process", len(cwds))
	}

	want, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	if got != want {
		t.Errorf("cwd for self = %q, want %q — paths from lsof and the runtime do not agree, "+
			"so prefix matching against config paths would never match", got, want)
	}
}

// End-to-end on the real machine: a child process parked inside a workspace
// tree must actually be found by the real ps + lsof collection.
func TestPartition_FindsRealProcessInWorkspaceTree(t *testing.T) {
	dir := useTempWorkspaces(t)
	projectDir := filepath.Join(dir, "ws", "project")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	cmd := exec.Command("sh", "-c", "sleep 30")
	cmd.Dir = projectDir
	if err := cmd.Start(); err != nil {
		t.Fatalf("start child: %v", err)
	}
	t.Cleanup(func() {
		cmd.Process.Kill()
		cmd.Wait()
	})

	rows, err := crewExec.Snapshot()
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	cwds, err := processCWDs()
	if err != nil {
		t.Skipf("lsof unavailable: %v", err)
	}

	root, err := workspacesRoot()
	if err != nil {
		t.Fatalf("workspacesRoot: %v", err)
	}

	orphans, attached := partition(rows, cwds, root, map[int]bool{})

	found := false
	for _, p := range append(append([]Proc{}, orphans...), attached...) {
		if p.PID == cmd.Process.Pid {
			found = true
		}
	}
	if !found {
		t.Errorf("child %d in %s was not found by the real collection", cmd.Process.Pid, projectDir)
	}

	// Its parent (the test binary) is alive, so it is attached, not reclaimable.
	for _, o := range orphans {
		if o.PID == cmd.Process.Pid {
			t.Error("a child with a living parent must not be classified as an orphan")
		}
	}
}

func TestCollect_ReportsScanNoteInsteadOfZeroOrphans(t *testing.T) {
	prev := config.WorkspacesDir
	config.WorkspacesDir = ""
	t.Cleanup(func() { config.WorkspacesDir = prev })

	inv, err := Collect()
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if inv.ScanNote == "" {
		t.Error("an unconfigured workspaces dir must report why the scan did not run")
	}
	if len(inv.Orphans) != 0 {
		t.Errorf("orphans = %v, want none when the scan could not run", inv.Orphans)
	}
}

func TestMaxProcsPerUID(t *testing.T) {
	got := maxProcsPerUID()
	if got <= 0 {
		t.Skip("kern.maxprocperuid unavailable")
	}

	out, err := exec.Command("sysctl", "-n", "kern.maxprocperuid").Output()
	if err != nil {
		t.Skip("sysctl unavailable")
	}
	want, _ := strconv.Atoi(string(out[:len(out)-1]))
	if got != want {
		t.Errorf("maxProcsPerUID = %d, want %d", got, want)
	}
}

func parsePID(s string) (int, error) {
	return strconv.Atoi(strings.TrimSpace(s))
}

// ppidOf reports a live process's parent pid, and whether it is alive at all.
func ppidOf(pid int) (int, bool) {
	out, err := exec.Command("ps", "-o", "ppid=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0, false
	}
	ppid, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		return 0, false
	}
	return ppid, true
}
