package voice

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

// logsHome copies testdata/logs into a fresh ~/.crew/voiceos/logs, every file
// written now (tests set older mtimes themselves).
func logsHome(t *testing.T) string {
	t.Helper()
	isolateConfig(t)
	dir := filepath.Dir(LogFile())
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir("testdata/logs")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		data, err := os.ReadFile(filepath.Join("testdata/logs", e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, e.Name()), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func isolateConfig(t *testing.T) {
	saved := config.ConfigDir
	config.ConfigDir = t.TempDir()
	t.Cleanup(func() { config.ConfigDir = saved })
}

func msgs(lines []LogLine) []string {
	out := []string{}
	for _, l := range lines {
		out = append(out, l.Msg)
	}
	return out
}

func TestRotatedFiles(t *testing.T) {
	got := RotatedFiles("/x/voiceos.log")
	want := []string{"/x/voiceos.log", "/x/voiceos.log.1", "/x/voiceos.log.2", "/x/voiceos.log.3", "/x/voiceos.log.4", "/x/voiceos.log.5"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}

func TestReadLogAcrossRotations(t *testing.T) {
	logsHome(t)
	read, err := ReadLog(RotatedFiles(LogFile()), LogFilter{}, 0, "main")
	if err != nil {
		t.Fatal(err)
	}
	// Oldest file first, forward; the malformed line and the half-written last one are skipped.
	want := []string{"listening", "partial", "slow reply", "routed", "session died", "final", "no session"}
	if got := msgs(read.Lines); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if read.Files != 3 || read.KeptFrom != "2026-09-30T08:00:00.000Z" || read.Lines[0].Machine != "main" {
		t.Fatalf("read %+v", read)
	}

	// --lines counts across files: the newest 4 reach back into .1.
	tail, err := ReadLog(RotatedFiles(LogFile()), LogFilter{}, 4, "main")
	if err != nil {
		t.Fatal(err)
	}
	if got := msgs(tail.Lines); !reflect.DeepEqual(got, []string{"routed", "session died", "final", "no session"}) {
		t.Fatalf("tail %v", got)
	}

	warn, _ := ReadLog(RotatedFiles(LogFile()), LogFilter{Level: "warn"}, 0, "main")
	if got := msgs(warn.Lines); !reflect.DeepEqual(got, []string{"slow reply", "session died", "no session"}) {
		t.Fatalf("warn %v", got)
	}
}

func TestReadLogSkipsAFileByItsMtime(t *testing.T) {
	dir := logsHome(t)
	old := time.Date(2026, 9, 30, 8, 0, 30, 0, time.UTC)
	// .2 was last written before the window: never read. A bad line planted
	// in it would show if it were.
	oldest := filepath.Join(dir, "voiceos.log.2")
	if err := os.WriteFile(oldest, []byte(`{"ts":"2026-09-30T09:00:00.000Z","level":"info","cat":"x","msg":"planted"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(oldest, old, old); err != nil {
		t.Fatal(err)
	}
	since := time.Date(2026, 9, 30, 8, 1, 0, 0, time.UTC)
	read, err := ReadLog(RotatedFiles(LogFile()), LogFilter{Since: since}, 0, "main")
	if err != nil {
		t.Fatal(err)
	}
	if got := msgs(read.Lines); !reflect.DeepEqual(got, []string{"routed", "session died", "final", "no session"}) {
		t.Fatalf("got %v", got)
	}
	// The log reaches further back than asked: nothing rotated out.
	if read.KeptFrom != "" || read.RotatedOut(since) != "" {
		t.Fatalf("kept from %q", read.KeptFrom)
	}
}

func TestReadLogEmptyAndMissing(t *testing.T) {
	logsHome(t)
	read, err := ReadLog(RotatedFiles(RemoteLogFile()), LogFilter{}, 10, "main")
	if err != nil || len(read.Lines) != 0 || read.Lines == nil {
		t.Fatalf("missing log: %+v, %v", read, err)
	}
	if read.RotatedOut(time.Now()) != "no Voice OS log on this machine" {
		t.Fatalf("no log must say so")
	}
	empty := filepath.Join(filepath.Dir(LogFile()), "voiceos-remote.log")
	read, err = ReadLog([]string{empty}, LogFilter{}, 10, "main")
	if err != nil || len(read.Lines) != 0 || read.Files != 1 || read.KeptFrom != "" {
		t.Fatalf("empty log: %+v, %v", read, err)
	}
}

func TestReadLogOpensEveryFileBeforeReading(t *testing.T) {
	dir := logsHome(t)
	// Voice OS rotates mid-query: every file moves up one and a fresh log starts.
	afterOpen = func() {
		for i := 2; i >= 1; i-- {
			os.Rename(filepath.Join(dir, "voiceos.log."+string(rune('0'+i))), filepath.Join(dir, "voiceos.log."+string(rune('0'+i+1))))
		}
		os.Rename(filepath.Join(dir, "voiceos.log"), filepath.Join(dir, "voiceos.log.1"))
		os.WriteFile(filepath.Join(dir, "voiceos.log"), []byte(`{"ts":"2026-09-30T08:03:00.000Z","level":"info","cat":"x","msg":"after"}`+"\n"), 0o600)
	}
	t.Cleanup(func() { afterOpen = func() {} })
	read, err := ReadLog(RotatedFiles(LogFile()), LogFilter{}, 0, "main")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"listening", "partial", "slow reply", "routed", "session died", "final", "no session"}
	if got := msgs(read.Lines); !reflect.DeepEqual(got, want) {
		t.Fatalf("a rotation during the read skipped or repeated lines: %v", got)
	}
}

func TestRotatedOutOnlyWhenRotationDroppedLines(t *testing.T) {
	early := time.Date(2026, 9, 30, 7, 59, 59, 0, time.UTC)
	cases := []struct {
		name  string
		read  LogRead
		start time.Time
		want  string
	}{
		{"a log that never rotated just starts there", LogRead{Files: 1, Slots: 6, KeptFrom: "2026-09-30T08:00:00.000Z"}, early, ""},
		{"a free slot: nothing dropped", LogRead{Files: 5, Slots: 6, KeptFrom: "2026-09-30T08:00:00.000Z"}, early, ""},
		{"every slot full, window before the oldest line", LogRead{Files: 6, Slots: 6, KeptFrom: "2026-09-30T08:00:00.000Z"}, early, "the log before 2026-09-30T08:00:00.000Z has rotated out; showing what is kept"},
		{"every slot full, window at the oldest line", LogRead{Files: 6, Slots: 6, KeptFrom: "2026-09-30T08:00:00.000Z"}, time.Date(2026, 9, 30, 8, 0, 0, 0, time.UTC), ""},
		{"no log", LogRead{Slots: 6}, early, "no Voice OS log on this machine"},
	}
	for _, c := range cases {
		if got := c.read.RotatedOut(c.start); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestLocalLogsMergesBothLogs(t *testing.T) {
	logsHome(t)
	remote := RemoteLogFile()
	if err := os.MkdirAll(filepath.Dir(remote), 0o700); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(remote, []byte(`{"ts":"2026-09-30T08:01:30.000Z","level":"info","cat":"remote","msg":"daemon"}`+"\n"), 0o600)
	lines, err := LocalLogs(LogFilter{}, 3, "vm1")
	if err != nil {
		t.Fatal(err)
	}
	if got := msgs(lines); !reflect.DeepEqual(got, []string{"daemon", "final", "no session"}) {
		t.Fatalf("got %v", got)
	}
}

func TestReadNotes(t *testing.T) {
	isolateConfig(t)
	os.MkdirAll(NotesDir(), 0o700)
	os.WriteFile(filepath.Join(NotesDir(), "store-front.md"), []byte("- 2026-09-30 09:58 — sizes\n"), 0o600)
	os.WriteFile(filepath.Join(NotesDir(), "_general.md"), []byte("- 2026-09-30 09:00 — tone\n"), 0o600)
	os.WriteFile(filepath.Join(NotesDir(), "stray.txt"), []byte("- no\n"), 0o600)

	all, keys, err := ReadNotes(nil)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(keys, []string{GeneralNotes, "store-front"}) || all["store-front"][0].Text != "sizes" || all[GeneralNotes][0].Workspace != "general" {
		t.Fatalf("all %v %+v", keys, all)
	}
	one, _, err := ReadNotes([]string{ToNotesKey("Checkout API")})
	if err != nil || one["checkout-api"] == nil || len(one["checkout-api"]) != 0 {
		t.Fatalf("a workspace without notes is an empty list: %+v %v", one, err)
	}
}

// Voice OS writes ts first with no spaces; a line spelled otherwise is still a
// line, only a slower one to read.
func TestLeadingTSReadsAnySpellingOfALine(t *testing.T) {
	cases := map[string]string{
		`{"ts":"2026-09-30T08:00:00.000Z","msg":"m"}`:    "2026-09-30T08:00:00.000Z",
		`{"ts": "2026-09-30T08:00:00.000Z", "msg": "m"}`: "2026-09-30T08:00:00.000Z",
		`{"msg":"m","ts":"2026-09-30T08:00:00.000Z"}`:    "2026-09-30T08:00:00.000Z",
		`not json`:          "",
		`{"msg":"no time"}`: "",
	}
	for raw, want := range cases {
		got, ok := leadingTS([]byte(raw))
		if got != want || ok != (want != "") {
			t.Errorf("%s: got (%q, %v), want %q", raw, got, ok, want)
		}
	}
}
