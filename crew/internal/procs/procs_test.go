package procs

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

// Tests in this package must never run in parallel: config.WorkspacesDir is a
// process-wide global, and one test reading the real value while another
// computes a kill set is exactly the accident this package is built to avoid.

// useTempWorkspaces points the scan at a throwaway tree and refuses to run if
// that somehow resolves to the user's real one. Every test that computes a kill
// set goes through it.
func useTempWorkspaces(t *testing.T) string {
	t.Helper()

	dir := filepath.Join(t.TempDir(), "workspaces")
	real, err := realWorkspacesDir()
	if err == nil && (dir == real || underDir(dir, real)) {
		t.Fatalf("refusing to run: temp workspaces dir %q is inside the real one %q", dir, real)
	}

	prev := config.WorkspacesDir
	config.WorkspacesDir = dir
	t.Cleanup(func() { config.WorkspacesDir = prev })
	return dir
}

func realWorkspacesDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".crew", "workspaces"), nil
}

func TestWorkspacesRoot_RefusesDangerousValues(t *testing.T) {
	// An unset or too-broad value would make "under this directory" true for
	// most of the machine, so the scan must refuse rather than return a set.
	home, _ := os.UserHomeDir()
	for _, dir := range []string{"", "/", "/Users", "relative/path", "/tmp", home} {
		t.Run(dir, func(t *testing.T) {
			prev := config.WorkspacesDir
			config.WorkspacesDir = dir
			t.Cleanup(func() { config.WorkspacesDir = prev })

			if got, err := workspacesRoot(); err == nil {
				t.Errorf("workspacesRoot(%q) = %q, want refusal", dir, got)
			}
		})
	}
}

// The returned path must be the kernel-resolved one, since that is what lsof
// reports. On macOS a temp dir lives under /var, which resolves to /private/var
// — the exact mismatch that once made the scan match nothing at all.
func TestWorkspacesRoot_ResolvesSymlinks(t *testing.T) {
	dir := useTempWorkspaces(t)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	want, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatalf("EvalSymlinks: %v", err)
	}

	got, err := workspacesRoot()
	if err != nil {
		t.Fatalf("workspacesRoot: %v", err)
	}
	if got != want {
		t.Errorf("workspacesRoot = %q, want the resolved path %q", got, want)
	}
}

// A directory that does not exist yet is not an error: no workspaces have been
// created. Anything else that blocks resolution is.
func TestWorkspacesRoot_MissingDirIsNotAnError(t *testing.T) {
	dir := useTempWorkspaces(t)
	got, err := workspacesRoot()
	if err != nil {
		t.Fatalf("workspacesRoot: %v", err)
	}
	if got != filepath.Clean(dir) {
		t.Errorf("workspacesRoot = %q, want %q", got, dir)
	}
}

func TestUnderDir(t *testing.T) {
	dir := "/Users/luka/.crew/workspaces"
	tests := []struct {
		path string
		want bool
	}{
		{"/Users/luka/.crew/workspaces", true},
		{"/Users/luka/.crew/workspaces/ws/api", true},
		// A sibling directory must not match on prefix alone.
		{"/Users/luka/.crew/workspaces-backup/ws", false},
		{"/Users/luka/.crew/workspacesX", false},
		{"/Users/luka/Documents/crew", false},
		{"", false},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			if got := underDir(tt.path, dir); got != tt.want {
				t.Errorf("underDir(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

// Rows copied verbatim from this machine, captured with:
//
//	ps -axww -o pid=,ppid=,pgid=,tty=,command=
//
// while a crew workspace was open in an editor with a Claude session running.
// Hand-written fixtures are what let a classifier keep passing years after real
// process shapes have moved on, so these stay as they came out.
const wsRoot = "/Users/luka/.crew/workspaces"

func liveMachineRows() ([]crewExec.ProcRow, map[int]string) {
	rows := []crewExec.ProcRow{
		{PID: 1, PPID: 0, Command: "/sbin/launchd"},
		{PID: 8030, PPID: 1, Command: "/Applications/Cursor.app/Contents/MacOS/Cursor"},
		{PID: 8119, PPID: 8030, Command: "Cursor Helper: terminal pty-host"},
		{PID: 89947, PPID: 8030, Command: "Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)"},
		{PID: 68397, PPID: 8119, TTY: "ttys014", Command: "claude --dangerously-skip-permissions --add-dir " + wsRoot + "/phone-speak-wrk1/speak-api"},
		{PID: 93389, PPID: 68397, Command: "/bin/zsh -c source /Users/luka/.claude/shell-snapshots/snapshot-zsh.sh"},
		{PID: 93391, PPID: 93389, Command: "uv run python -m pytest apps/livekit_worker/tests/unit/phone_speak/ -q"},
		{PID: 93394, PPID: 93391, Command: wsRoot + "/phone-speak-wrk1/ai-tutor-api/.venv/bin/python3 -m pytest"},
		{PID: 68011, PPID: 8119, TTY: "ttys010", Command: "/opt/homebrew/bin/zsh -i"},
		{PID: 80489, PPID: 8119, TTY: "ttys024", Command: "/opt/homebrew/bin/zsh -i"},
		{PID: 90514, PPID: 89947, Command: wsRoot + "/phone-speak-wrk1/speak-api/node_modules/@biomejs/cli-darwin-arm64/biome lsp-proxy --stdio"},
		// The genuine leak: parent exited, still holding a workspace directory.
		{PID: 77001, PPID: 1, Command: "node " + wsRoot + "/phone-speak-wrk1/speak-app/node_modules/.bin/next dev"},
		// A child of that leak. Its own parent is alive, but that parent is the leak.
		{PID: 77002, PPID: 77001, Command: "node next-server worker"},
	}

	cwds := map[int]string{}
	for _, r := range rows {
		if r.PID == 1 || r.PID == 8030 || r.PID == 8119 || r.PID == 89947 {
			continue
		}
		cwds[r.PID] = wsRoot + "/phone-speak-wrk1/speak-api"
	}
	return rows, cwds
}

// The one that matters: every live, attached process in the workspace tree is
// spared, and only the genuinely abandoned tree is reclaimed.
func TestPartition_SparesLiveWorkAndReclaimsLeaks(t *testing.T) {
	rows, cwds := liveMachineRows()

	orphans, attached := partition(rows, cwds, wsRoot, map[int]bool{})

	gotOrphans := map[int]bool{}
	for _, o := range orphans {
		gotOrphans[o.PID] = true
	}

	// A live Claude session, its shell, its in-flight test run, the user's
	// editor terminals, and a language server all sit in the workspace tree.
	// None of them may ever be reclaimed.
	for _, pid := range []int{68397, 93389, 93391, 93394, 68011, 80489, 90514} {
		if gotOrphans[pid] {
			t.Errorf("pid %d is live work and must never be an orphan", pid)
		}
	}

	want := []int{77001, 77002}
	got := []int{}
	for _, o := range orphans {
		got = append(got, o.PID)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("orphans = %v, want %v", got, want)
	}

	if len(attached) != 7 {
		t.Errorf("attached = %d processes, want 7 reported as spared", len(attached))
	}
}

func TestPartition_SessionProcessesAreNotAlsoOrphans(t *testing.T) {
	rows, cwds := liveMachineRows()

	orphans, _ := partition(rows, cwds, wsRoot, map[int]bool{77001: true})

	for _, o := range orphans {
		if o.PID == 77001 {
			t.Error("a pid already claimed by a session must not be listed as loose")
		}
	}
}

func TestPartition_EmptyTreeYieldsNothing(t *testing.T) {
	rows, _ := liveMachineRows()

	orphans, attached := partition(rows, map[int]string{}, wsRoot, map[int]bool{})

	if len(orphans) != 0 || len(attached) != 0 {
		t.Errorf("orphans=%d attached=%d, want both empty", len(orphans), len(attached))
	}
}

// The tmux server daemonizes: ppid 1, and it inherits the working directory
// crew was launched from. Start a session from inside a workspace and it looks
// exactly like an abandoned workspace process — while being the parent of every
// pane, so a descendant walk never sees it. Killing it would take down every
// tmux session on the machine.
func TestPartition_NeverReclaimsTheTmuxServer(t *testing.T) {
	const server, pane, devServer = 5000, 5001, 5002

	rows := []crewExec.ProcRow{
		{PID: 1, PPID: 0},
		{PID: server, PPID: 1, Command: "tmux new-session -d -s crew-dev-ws"},
		{PID: pane, PPID: server, Command: "-zsh"},
		{PID: devServer, PPID: pane, Command: "npm run dev"},
	}
	cwds := map[int]string{
		server:    wsRoot + "/ws/api",
		pane:      wsRoot + "/ws/api",
		devServer: wsRoot + "/ws/api",
	}

	sessions := []Session{{Name: "crew-dev-ws", Procs: []Proc{{PID: pane}, {PID: devServer}}}}
	orphans, _ := partition(rows, cwds, wsRoot, claimedPIDs(sessions, rows))

	for _, o := range orphans {
		if o.PID == server {
			t.Fatal("the tmux server was classified as an orphan — reclaiming it would kill every session on the machine")
		}
	}
	if len(orphans) != 0 {
		t.Errorf("orphans = %v, want none: every process here belongs to a live session", orphans)
	}
}

func TestClaimedPIDs_CoversAncestorsOfPanes(t *testing.T) {
	rows := []crewExec.ProcRow{
		{PID: 100, PPID: 1},
		{PID: 200, PPID: 100},
		{PID: 300, PPID: 200},
	}

	claimed := claimedPIDs([]Session{{Procs: []Proc{{PID: 300}}}}, rows)

	for _, pid := range []int{100, 200, 300} {
		if !claimed[pid] {
			t.Errorf("pid %d should be claimed: it is a pane or an ancestor of one", pid)
		}
	}
}

// ps is not atomic and pids get reused, so a cycle in the parent graph is
// possible. It must not wedge the scan.
func TestPartition_CycleInParentGraphTerminates(t *testing.T) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		rows := []crewExec.ProcRow{
			{PID: 500, PPID: 501},
			{PID: 501, PPID: 500},
			{PID: 502, PPID: 1},
		}
		cwds := map[int]string{500: wsRoot + "/a", 501: wsRoot + "/a", 502: wsRoot + "/a"}
		partition(rows, cwds, wsRoot, map[int]bool{})
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("partition did not terminate on a cyclic parent graph")
	}
}
