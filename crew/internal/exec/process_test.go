package exec

import (
	"os"
	"reflect"
	"testing"
)

func TestNormalizeTTY(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"/dev/ttys002", "ttys002"},
		{"ttys002", "ttys002"},
		{"??", ""},
		{"?", ""},
		{"", ""},
		{"/dev/", ""},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			if got := normalizeTTY(tt.input); got != tt.want {
				t.Errorf("normalizeTTY(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestParseProcRows(t *testing.T) {
	out := "  PID  PPID TTY\n" +
		" 7711  7707 ttys002\n" +
		" 7720  7711 ttys002\n" +
		" 7723     1 ttys002\n" +
		"27231 27228 ??\n" +
		"garbage line\n"

	want := []procRow{
		{pid: 7711, ppid: 7707, tty: "ttys002"},
		{pid: 7720, ppid: 7711, tty: "ttys002"},
		{pid: 7723, ppid: 1, tty: "ttys002"},
		{pid: 27231, ppid: 27228, tty: ""},
	}

	if got := parseProcRows(out); !reflect.DeepEqual(got, want) {
		t.Errorf("parseProcRows =\n%+v\nwant\n%+v", got, want)
	}
}

func TestAncestorPIDs(t *testing.T) {
	rows := []procRow{
		{pid: 1, ppid: 0},
		{pid: 100, ppid: 1},
		{pid: 200, ppid: 100},
		{pid: 300, ppid: 200},
	}

	want := []int{200, 100, 1}
	if got := ancestorPIDs(300, rows); !reflect.DeepEqual(got, want) {
		t.Errorf("ancestorPIDs(300) = %v, want %v", got, want)
	}
}

func TestAncestorPIDs_CycleTerminates(t *testing.T) {
	rows := []procRow{
		{pid: 10, ppid: 20},
		{pid: 20, ppid: 10},
	}

	// A malformed snapshot must terminate, not spin.
	want := []int{20, 10}
	if got := ancestorPIDs(10, rows); !reflect.DeepEqual(got, want) {
		t.Errorf("ancestorPIDs(10) = %v, want %v", got, want)
	}
}

func TestSelectVictims(t *testing.T) {
	// Mirrors the reproduced failure: pane shell 7711 on ttys002, a live child
	// tree, and 7723 orphaned to PID 1 but still holding the pane tty.
	rows := []procRow{
		{pid: 1, ppid: 0, tty: ""},
		{pid: 7707, ppid: 1, tty: ""},           // tmux server
		{pid: 7711, ppid: 7707, tty: "ttys002"}, // pane shell
		{pid: 7720, ppid: 7711, tty: "ttys002"}, // dev server wrapper
		{pid: 7722, ppid: 7720, tty: "ttys002"}, // its child
		{pid: 7723, ppid: 1, tty: "ttys002"},    // ORPHAN — invisible to ppid walk
		{pid: 7777, ppid: 7720, tty: ""},        // setsid'd off the tty, parent alive
		{pid: 9000, ppid: 1, tty: "ttys009"},    // unrelated pane
		{pid: 27231, ppid: 7707, tty: ""},       // pipe-pane helper, no tty
	}

	tests := []struct {
		name      string
		pane      paneRef
		protected []int
		want      []int
	}{
		{
			name:    "orphan on pane tty is caught, other panes untouched",
			pane:    paneRef{pid: 7711, tty: "ttys002"},
			want:    []int{7720, 7722, 7723, 7777},
		},
		{
			name:    "no tty falls back to the ppid graph only",
			pane:    paneRef{pid: 7711},
			want:    []int{7720, 7722, 7777},
		},
		{
			name:      "protected pids are never returned",
			pane:      paneRef{pid: 7711, tty: "ttys002"},
			protected: []int{7722, 7723},
			want:      []int{7720, 7777},
		},
		{
			name:    "unrelated pane sweeps only its own tty",
			pane:    paneRef{pid: 9000, tty: "ttys009"},
			want:    nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := selectVictims(rows, tt.pane, tt.protected)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("selectVictims = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestSelectVictims_NeverReturnsPaneShellOrInitOrSelf(t *testing.T) {
	rows := []procRow{
		{pid: 1, ppid: 0, tty: "ttys002"},
		{pid: 500, ppid: 1, tty: "ttys002"}, // crew itself
		{pid: 7711, ppid: 1, tty: "ttys002"},
		{pid: 7720, ppid: 7711, tty: "ttys002"},
	}

	got := selectVictims(rows, paneRef{pid: 7711, tty: "ttys002"}, []int{500})

	for _, pid := range got {
		if pid == 1 || pid == 500 || pid == 7711 {
			t.Errorf("selectVictims returned protected pid %d (got %v)", pid, got)
		}
	}
	if !reflect.DeepEqual(got, []int{7720}) {
		t.Errorf("selectVictims = %v, want [7720]", got)
	}
}

// A process sharing neither the pane tty nor a ppid link with the pane must
// never be swept. (This same shape is why a process that both setsid()s off the
// tty and loses its parent is not reachable — see selectVictims' doc comment.)
func TestSelectVictims_IgnoresUnrelatedTTYLessProcess(t *testing.T) {
	rows := []procRow{
		{pid: 7711, ppid: 1, tty: "ttys002"},
		{pid: 8888, ppid: 1, tty: ""}, // setsid'd and orphaned
	}

	if got := selectVictims(rows, paneRef{pid: 7711, tty: "ttys002"}, nil); len(got) != 0 {
		t.Errorf("unrelated tty-less process must not be swept, got %v", got)
	}
}

func TestParsePaneRefs(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  []paneRef
	}{
		{
			name:  "pid and tty per line",
			input: "7711 /dev/ttys002\n7811 /dev/ttys003\n",
			want:  []paneRef{{pid: 7711, tty: "ttys002"}, {pid: 7811, tty: "ttys003"}},
		},
		{
			name:  "pane with unusable tty keeps the ppid sweep",
			input: "1234 ?\n",
			want:  []paneRef{{pid: 1234, tty: ""}},
		},
		{
			name:  "missing tty field is not dropped",
			input: "1234\n",
			want:  []paneRef{{pid: 1234, tty: ""}},
		},
		{
			name:  "non-numeric and non-positive pids are skipped",
			input: "abc /dev/ttys002\n0 /dev/ttys003\n-1 /dev/ttys004\n",
			want:  nil,
		},
		{
			name:  "blank lines and extra whitespace",
			input: "\n  7711   /dev/ttys002  \n\n",
			want:  []paneRef{{pid: 7711, tty: "ttys002"}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parsePaneRefs(tt.input)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("parsePaneRefs = %+v, want %+v", got, tt.want)
			}
		})
	}
}

// snapshotProcs is the one place the real `ps` output format is trusted. If it
// ever drifts, the parser silently yields nothing, selectVictims finds no
// victims, and the sweep quietly no-ops — so this runs everywhere, with no tmux
// and no privileges, rather than only in the skippable integration tests.
func TestSnapshotProcs_ParsesRealPSOutput(t *testing.T) {
	rows, err := snapshotProcs()
	if err != nil {
		t.Fatalf("snapshotProcs: %v", err)
	}

	self := os.Getpid()
	for _, r := range rows {
		if r.pid == self {
			if r.ppid != os.Getppid() {
				t.Errorf("ppid for self = %d, want %d", r.ppid, os.Getppid())
			}
			return
		}
	}
	t.Errorf("snapshot of %d rows did not include the test process (pid %d)", len(rows), self)
}

// protectedPIDs must cover the whole chain above crew, not just crew: when crew
// runs inside the pane being torn down, every intervening shell shares the
// doomed tty.
func TestProtectedPIDs_CoversAncestorChain(t *testing.T) {
	rows, err := snapshotProcs()
	if err != nil {
		t.Fatalf("snapshotProcs: %v", err)
	}

	protected := protectedPIDs(rows)
	for _, want := range []int{os.Getpid(), os.Getppid()} {
		found := false
		for _, p := range protected {
			if p == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("protectedPIDs missing pid %d (got %v)", want, protected)
		}
	}
}

// The dangerous shape from protectedPIDs' doc comment: crew invoked from inside
// the pane being torn down, so the pane shell, the shell between, and crew all
// share one tty. Everything on the protected chain must survive; the pane's
// other children must not.
func TestSelectVictims_SpareCrewsAncestorChainOnThePaneTTY(t *testing.T) {
	rows := []procRow{
		{pid: 100, ppid: 1, tty: "ttys002"},   // pane shell
		{pid: 200, ppid: 100, tty: "ttys002"}, // intervening shell
		{pid: 300, ppid: 200, tty: "ttys002"}, // crew itself
		{pid: 400, ppid: 100, tty: "ttys002"}, // unrelated dev-server child
	}

	got := selectVictims(rows, paneRef{pid: 100, tty: "ttys002"}, []int{200, 300})

	if !reflect.DeepEqual(got, []int{400}) {
		t.Errorf("selectVictims = %v, want [400] (crew and its ancestors must survive)", got)
	}
}
