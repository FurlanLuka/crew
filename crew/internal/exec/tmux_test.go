package exec

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// --- Integration tests (require tmux) ---
//
// These run against a private tmux server, never the developer's. The sweep
// under test kills by controlling tty, so a test that reached the real server
// could kill the terminal running `go test`. The isolation below is load
// bearing, not tidiness.

const (
	pollInterval = 20 * time.Millisecond
	pollDeadline = 5 * time.Second
)

// startPrivateTmux points tmux at a throwaway socket and HOME for this test.
//
// Clearing TMUX is the load-bearing line. A tmux client resolves its server
// from $TMUX first and ignores TMUX_TMPDIR when it is set, so running these
// tests from inside a tmux pane — the normal case for a tmux tool — would
// otherwise aim every command here, including the kill-server below, at the
// developer's real server. Production code strips it for the same reason
// (EnvWithoutTMUX), but only on the commands it owns.
//
// TMUX_TMPDIR isolates the server so no test can address a real session; HOME
// keeps the developer's ~/.tmux.conf out (a global `destroy-unattached on`
// would otherwise kill detached test sessions and flake permanently).
//
// The directory must live directly under /tmp: the socket path is
// $TMUX_TMPDIR/tmux-$UID/default and macOS caps sun_path at 104 bytes, which a
// t.TempDir() path under /var/folders would blow.
func startPrivateTmux(t *testing.T) string {
	t.Helper()

	dir, err := os.MkdirTemp("/tmp", "crewtmux")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Setenv("TMUX", "")
	t.Setenv("TMUX_TMPDIR", dir)
	t.Setenv("HOME", dir)
	t.Setenv("HISTFILE", "")

	t.Cleanup(func() {
		exec.Command("tmux", "kill-server").Run()
		// kill-server is asynchronous. A pane shell that outlives it writes
		// into $HOME on exit and recreates the directory, so wait for the
		// server to actually be gone before removing it.
		deadline := time.Now().Add(pollDeadline)
		for time.Now().Before(deadline) {
			if err := exec.Command("tmux", "has-session").Run(); err != nil {
				break
			}
			time.Sleep(pollInterval)
		}
		os.RemoveAll(dir)
	})
	return dir
}

// killByNonce best-effort reaps anything this test started, without depending
// on a pid file having been written. A regression test for a process leak must
// not leak processes itself, including when it is aborted mid-run.
func killByNonce(nonce string) {
	exec.Command("pkill", "-9", "-f", "sleeper-"+nonce).Run()
}

func requireTmux(t *testing.T) {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping tmux integration test")
	}
	if !HasTmux() {
		t.Skip("tmux not available")
	}
}

// paneTTYOf returns the pane's controlling tty and fails the test unless it is
// usable and distinct from the test process's own terminal.
//
// The invariant that actually contains the sweep is tty exclusivity: a live
// pane owns its /dev/ttysNNN device, so no other terminal can be sitting on it.
// The comparison below is a second line of defence for the case where the test
// runner does have a terminal; when it has none there is nothing to compare and
// exclusivity carries it alone.
func paneTTYOf(t *testing.T, session string) string {
	t.Helper()

	out, err := exec.Command("tmux", "list-panes", "-t", session, "-F", "#{pane_tty}").Output()
	if err != nil {
		t.Fatalf("list-panes: %v", err)
	}
	tty := normalizeTTY(strings.TrimSpace(string(out)))
	if tty == "" {
		t.Fatalf("pane has no usable tty (got %q)", string(out))
	}

	own, _ := exec.Command("ps", "-o", "tty=", "-p", strconv.Itoa(os.Getpid())).Output()
	if ownTTY := normalizeTTY(strings.TrimSpace(string(own))); ownTTY != "" && ownTTY == tty {
		t.Fatalf("pane tty %q is the test's own terminal — refusing to sweep it", tty)
	}
	return tty
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(pollDeadline)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(pollInterval)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// procPPID reports a live process's parent pid.
func procPPID(pid int) (int, bool) {
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

// aliveWithNonce reports whether pid is still a running process belonging to
// this test. A zombie counts as gone (SIGKILL is asynchronous and PID 1 has not
// reaped it yet), and so does a recycled pid running something else.
func aliveWithNonce(pid int, nonce string) bool {
	out, err := exec.Command("ps", "-o", "stat=,command=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return false
	}
	line := strings.TrimSpace(string(out))
	if line == "" || strings.HasPrefix(line, "Z") {
		return false
	}
	return strings.Contains(line, nonce)
}

// writeSleeper writes a long-running script whose argv is unique to this test,
// so "is it gone" can never be answered by a recycled pid.
//
// The loop is bounded rather than infinite: the orphan test deliberately
// reparents this process to PID 1, so an aborted run (SIGINT, test timeout)
// skips t.Cleanup and would otherwise strand exactly the kind of immortal
// tty-holding orphan this whole change exists to kill.
func writeSleeper(t *testing.T, dir, nonce string) string {
	t.Helper()
	path := filepath.Join(dir, "sleeper-"+nonce+".sh")
	script := "i=0\nwhile [ $i -lt 120 ]; do sleep 1; i=$((i+1)); done\n"
	if err := os.WriteFile(path, []byte(script), 0o644); err != nil {
		t.Fatalf("write sleeper: %v", err)
	}
	return path
}

func readPIDFile(t *testing.T, path string) (int, bool) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return 0, false
	}
	return pid, true
}

// TestKillTmuxSession_KillsOrphanedGrandchild is the regression test for the
// leak: a dev-server wrapper exits, its child reparents to PID 1, and the ppid
// walk can no longer see it. Before the tty sweep this process survived every
// stop and start, accumulating until the per-user process limit was hit.
func TestKillTmuxSession_KillsOrphanedGrandchild(t *testing.T) {
	requireTmux(t)
	dir := startPrivateTmux(t)

	nonce := fmt.Sprintf("orphan%d", os.Getpid())
	session := "crew-test-" + nonce
	sleeper := writeSleeper(t, dir, nonce)
	pidFile := filepath.Join(dir, "orphan.pid")

	var orphan int
	t.Cleanup(func() {
		if orphan > 0 {
			syscall.Kill(orphan, syscall.SIGKILL)
		}
		killByNonce(nonce)
	})

	if err := CreateTmuxSession(session, dir); err != nil {
		t.Fatalf("CreateTmuxSession: %v", err)
	}
	paneTTYOf(t, session)

	// The inner shell backgrounds the sleeper and exits, so the sleeper is
	// reparented to PID 1 while keeping the pane's controlling tty.
	cmd := fmt.Sprintf("sh -c 'sh %s & echo $! > %s'", sleeper, pidFile)
	if err := TmuxSendKeys(session, cmd); err != nil {
		t.Fatalf("TmuxSendKeys: %v", err)
	}

	waitFor(t, "orphan pid file", func() bool {
		pid, ok := readPIDFile(t, pidFile)
		if ok {
			orphan = pid
		}
		return ok
	})

	// Assert the precondition rather than assume it. If the wrapper has not
	// exited yet the process is still ppid-reachable and the OLD code would
	// pass this test too — a false green on the exact bug being fixed.
	waitFor(t, "orphan to be reparented to PID 1", func() bool {
		ppid, ok := procPPID(orphan)
		return ok && ppid == 1
	})

	if !aliveWithNonce(orphan, nonce) {
		t.Fatalf("orphan %d died before the teardown ran", orphan)
	}

	KillTmuxSession(session)

	waitFor(t, "orphan to be killed", func() bool {
		return !aliveWithNonce(orphan, nonce)
	})

	if TmuxSessionExists(session) {
		t.Error("session still exists after KillTmuxSession")
	}
}

// TestKillTmuxSession_LeavesOtherSessionsAlone pins the blast radius. The
// orphan test alone cannot tell a correct fix from one that kills every process
// it can find; this can.
func TestKillTmuxSession_LeavesOtherSessionsAlone(t *testing.T) {
	requireTmux(t)
	dir := startPrivateTmux(t)

	nonce := fmt.Sprintf("blast%d", os.Getpid())
	sleeper := writeSleeper(t, dir, nonce)

	start := func(name string) string {
		session := "crew-test-" + nonce + "-" + name
		if err := CreateTmuxSession(session, dir); err != nil {
			t.Fatalf("CreateTmuxSession(%s): %v", session, err)
		}
		paneTTYOf(t, session)
		pidFile := filepath.Join(dir, name+".pid")
		if err := TmuxSendKeys(session, fmt.Sprintf("sh %s & echo $! > %s", sleeper, pidFile)); err != nil {
			t.Fatalf("TmuxSendKeys(%s): %v", session, err)
		}
		return pidFile
	}

	t.Cleanup(func() { killByNonce(nonce) })

	victimFile := start("victim")
	bystanderFile := start("bystander")

	var victim, bystander int
	waitFor(t, "both sleepers to start", func() bool {
		v, okV := readPIDFile(t, victimFile)
		b, okB := readPIDFile(t, bystanderFile)
		victim, bystander = v, b
		return okV && okB
	})
	KillTmuxSession("crew-test-" + nonce + "-victim")

	waitFor(t, "victim to be killed", func() bool {
		return !aliveWithNonce(victim, nonce)
	})
	if !aliveWithNonce(bystander, nonce) {
		t.Errorf("bystander %d in another session was killed — sweep is too broad", bystander)
	}
	// The test runner has no pane tty and is not descended from the pane, so a
	// sweep that widened to "every tty-less process" would take it out too.
	if err := syscall.Kill(os.Getpid(), 0); err != nil {
		t.Errorf("test process was signalled by the sweep: %v", err)
	}
}

// TestTmuxRestartLastCommand_PreservesPaneShell guards the one exclusion that
// keeps the pane shell out of the tty sweep. If it regresses, `crew dev
// restart` silently stops restarting: the pane dies, servers never come back,
// and nothing fails loudly.
func TestTmuxRestartLastCommand_PreservesPaneShell(t *testing.T) {
	requireTmux(t)
	dir := startPrivateTmux(t)

	nonce := fmt.Sprintf("restart%d", os.Getpid())
	session := "crew-test-" + nonce
	marker := filepath.Join(dir, "runs.log")

	if err := CreateTmuxSession(session, dir); err != nil {
		t.Fatalf("CreateTmuxSession: %v", err)
	}
	paneTTYOf(t, session)

	panePID := func() string {
		out, err := exec.Command("tmux", "list-panes", "-t", session, "-F", "#{pane_pid}").Output()
		if err != nil {
			t.Fatalf("list-panes: %v", err)
		}
		return strings.TrimSpace(string(out))
	}

	before := panePID()

	if err := TmuxSendKeys(session, fmt.Sprintf("echo run >> %s; sleep 300", marker)); err != nil {
		t.Fatalf("TmuxSendKeys: %v", err)
	}
	waitFor(t, "command to run once", func() bool {
		data, err := os.ReadFile(marker)
		return err == nil && strings.Count(string(data), "run") == 1
	})

	TmuxRestartLastCommand(session)

	waitFor(t, "command to re-run", func() bool {
		data, err := os.ReadFile(marker)
		return err == nil && strings.Count(string(data), "run") >= 2
	})

	if after := panePID(); after != before {
		t.Errorf("pane shell was replaced: pane_pid %s -> %s", before, after)
	}
}

// TestTmuxRestartLastCommand_PreservesPipePane locks in that the log-capture
// helper survives a restart. It is forked from the tmux server rather than the
// pane shell and carries no controlling tty, so the tty sweep must not match
// it — otherwise `crew dev logs` goes silently dead after any restart.
func TestTmuxRestartLastCommand_PreservesPipePane(t *testing.T) {
	requireTmux(t)
	dir := startPrivateTmux(t)

	nonce := fmt.Sprintf("pipe%d", os.Getpid())
	session := "crew-test-" + nonce
	logFile := filepath.Join(dir, "pane.log")

	if err := CreateTmuxSession(session, dir); err != nil {
		t.Fatalf("CreateTmuxSession: %v", err)
	}
	paneTTYOf(t, session)

	TmuxPipePaneToFile(session, "", logFile)

	if err := TmuxSendKeys(session, "echo before-restart"); err != nil {
		t.Fatalf("TmuxSendKeys: %v", err)
	}
	waitFor(t, "first output to reach the log", func() bool {
		data, err := os.ReadFile(logFile)
		return err == nil && strings.Contains(string(data), "before-restart")
	})

	TmuxRestartLastCommand(session)

	if err := TmuxSendKeys(session, "echo after-restart"); err != nil {
		t.Fatalf("TmuxSendKeys: %v", err)
	}
	waitFor(t, "output after restart to still reach the log", func() bool {
		data, err := os.ReadFile(logFile)
		return err == nil && strings.Contains(string(data), "after-restart")
	})
}

func TestKillTmuxSession_NonexistentSessionIsNoOp(t *testing.T) {
	requireTmux(t)
	startPrivateTmux(t)

	// Must not panic or fail when there is nothing to kill.
	KillTmuxSession("crew-test-does-not-exist")
}
