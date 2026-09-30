package voice

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"
)

// now is 10:30 on a +02 clock: 08:30Z.
var plus2 = time.FixedZone("CEST", 2*60*60)
var queryNow = time.Date(2026, 9, 30, 10, 30, 0, 0, plus2)

func TestParseWhen(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{"10m", "2026-09-30T08:20:00Z"},
		{"3d", "2026-09-27T08:30:00Z"},
		{"1h30m", "2026-09-30T07:00:00Z"},
		{"2d4h", "2026-09-28T04:30:00Z"},
		// A clock time is the typing machine's clock.
		{"10:02", "2026-09-30T08:02:00Z"},
		// Still ahead today, so yesterday's.
		{"11:15", "2026-09-29T09:15:00Z"},
		{"2026-09-30T10:02", "2026-09-30T08:02:00Z"},
		{"2026-09-30 10:02:30", "2026-09-30T08:02:30Z"},
		{"2026-09-30T08:02:00Z", "2026-09-30T08:02:00Z"},
		{"2026-09-30T10:02:00.5+02:00", "2026-09-30T08:02:00.5Z"},
	}
	for _, c := range cases {
		got, err := ParseWhen(c.raw, queryNow)
		if err != nil {
			t.Errorf("ParseWhen(%q): %v", c.raw, err)
			continue
		}
		if FormatWhen(got) != c.want {
			t.Errorf("ParseWhen(%q) = %s, want %s", c.raw, FormatWhen(got), c.want)
		}
	}
	for _, bad := range []string{"", "soon", "25:00", "10", "-5m", "0m", "2026-13-01"} {
		if _, err := ParseWhen(bad, queryNow); err == nil {
			t.Errorf("ParseWhen(%q) must fail", bad)
		}
	}
}

func TestClockTimeMatchesTheUTCLine(t *testing.T) {
	since, err := ParseWhen("10:02", queryNow)
	if err != nil {
		t.Fatal(err)
	}
	f := LogFilter{Since: since}
	if _, ok := f.Match([]byte(`{"ts":"2026-09-30T08:02:00.000Z","level":"info","cat":"a","msg":"m"}`)); !ok {
		t.Fatal("10:02 in +02 must include the 08:02Z line")
	}
	if _, ok := f.Match([]byte(`{"ts":"2026-09-30T08:01:59.999Z","level":"info","cat":"a","msg":"m"}`)); ok {
		t.Fatal("a line before 10:02 local must be left out")
	}
}

func TestLogFilterMatch(t *testing.T) {
	line := func(ts, level, cat, msg string) []byte {
		data, _ := json.Marshal(map[string]string{"ts": ts, "level": level, "cat": cat, "msg": msg})
		// Go sorts keys: put ts first, as Voice OS writes it.
		return []byte(`{"ts":"` + ts + `",` + string(data[1:]))
	}
	at := func(s string) time.Time { t, _ := time.Parse(time.RFC3339, s); return t }
	cases := []struct {
		name string
		f    LogFilter
		raw  []byte
		want bool
	}{
		{"warn and above takes error", LogFilter{Level: "warn"}, line("2026-09-30T08:00:00.000Z", "error", "a", "m"), true},
		{"warn and above takes warn", LogFilter{Level: "warn"}, line("2026-09-30T08:00:00.000Z", "warn", "a", "m"), true},
		{"warn and above drops info", LogFilter{Level: "warn"}, line("2026-09-30T08:00:00.000Z", "info", "a", "m"), false},
		{"debug takes everything", LogFilter{Level: "debug"}, line("2026-09-30T08:00:00.000Z", "debug", "a", "m"), true},
		{"one of several cats", LogFilter{Cats: []string{"router", "kernel"}}, line("2026-09-30T08:00:00.000Z", "info", "kernel", "m"), true},
		{"a cat not asked for", LogFilter{Cats: []string{"router", "kernel"}}, line("2026-09-30T08:00:00.000Z", "info", "speech", "m"), false},
		{"grep ignores case", LogFilter{Grep: "signals"}, line("2026-09-30T08:00:00.000Z", "info", "a", "open SIGNALS"), true},
		{"grep misses", LogFilter{Grep: "admin"}, line("2026-09-30T08:00:00.000Z", "info", "a", "open signals"), false},
		{"since is inclusive", LogFilter{Since: at("2026-09-30T08:00:00Z")}, line("2026-09-30T08:00:00.000Z", "info", "a", "m"), true},
		{"until is inclusive", LogFilter{Until: at("2026-09-30T08:00:00Z")}, line("2026-09-30T08:00:00.000Z", "info", "a", "m"), true},
		{"after until", LogFilter{Until: at("2026-09-30T08:00:00Z")}, line("2026-09-30T08:00:00.001Z", "info", "a", "m"), false},
		{"no leading ts", LogFilter{}, []byte(`{"level":"info","ts":"2026-09-30T08:00:00.000Z"}`), false},
		{"malformed", LogFilter{}, []byte(`{"ts":"2026-09-30T08:00:00.000Z",`), false},
	}
	for _, c := range cases {
		if _, got := c.f.Match(c.raw); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestParseLogLineKeepsTheOtherFields(t *testing.T) {
	got, ok := parseLogLine([]byte(`{"ts":"2026-09-30T08:00:00.000Z","level":"info","cat":"gateway","msg":"listening","port":7431,"host":"x"}`))
	if !ok {
		t.Fatal("not parsed")
	}
	if got.TS != "2026-09-30T08:00:00.000Z" || got.Level != "info" || got.Cat != "gateway" || got.Msg != "listening" {
		t.Fatalf("got %+v", got)
	}
	if row := FormatLogRow(got); row != "2026-09-30T08:00:00.000Z\t\tinfo\tgateway\tlistening\t{\"host\":\"x\",\"port\":7431}" {
		t.Fatalf("row %q", row)
	}
	bare, _ := parseLogLine([]byte(`{"ts":"2026-09-30T08:00:00.000Z","level":"info","cat":"a","msg":"a\tb"}`))
	if row := FormatLogRow(bare); row != "2026-09-30T08:00:00.000Z\t\tinfo\ta\ta b\t{}" {
		t.Fatalf("bare row %q", row)
	}
}

func TestMergeByTime(t *testing.T) {
	main := []LogLine{{TS: "2026-09-30T08:00:01.000Z", Machine: "main", Msg: "a"}, {TS: "2026-09-30T08:00:03.000Z", Machine: "main", Msg: "c"}}
	vm1 := []LogLine{{TS: "2026-09-30T08:00:01.000Z", Machine: "vm1", Msg: "a2"}, {TS: "2026-09-30T08:00:02.000Z", Machine: "vm1", Msg: "b"}}
	merged := MergeByTime(main, vm1)
	var got []string
	for _, l := range merged {
		got = append(got, l.Machine+":"+l.Msg)
	}
	if want := []string{"main:a", "vm1:a2", "vm1:b", "main:c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	// --lines after the merge: the newest overall, not each machine's.
	if tail := Newest(merged, 2); tail[0].Msg != "b" || tail[1].Msg != "c" {
		t.Fatalf("tail %+v", tail)
	}
	if empty := MergeByTime(); empty == nil || len(empty) != 0 {
		t.Fatalf("empty merge must be [] not null: %#v", empty)
	}
}

func TestLogFilterArgs(t *testing.T) {
	since, _ := ParseWhen("10m", queryNow)
	f := LogFilter{Since: since, Cats: []string{"router", "kernel"}, Level: "warn", Grep: "it's $HOME"}
	want := []string{"--since=2026-09-30T08:20:00Z", "--cat=router,kernel", "--level=warn", "--grep=it's $HOME"}
	if got := f.Args(); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if got := RemoteLogArgs(f, 80); !reflect.DeepEqual(got, append([]string{"voice", "logs", "--local", "--json"}, append(want, "--lines=80")...)) {
		t.Fatalf("remote args %v", got)
	}
}

func TestDebugNotesKeepTheirNumbers(t *testing.T) {
	data, err := os.ReadFile("testdata/logs/debug-notes.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	notes := ParseDebugNotes(data)
	var ns []int
	for _, n := range notes {
		ns = append(ns, n.N)
	}
	// The garbage line is number 2: dropped, and numbers after it stay put.
	if !reflect.DeepEqual(ns, []int{1, 3, 4}) {
		t.Fatalf("numbers %v", ns)
	}
	if note, err := FindDebugNote(notes, 3); err != nil || note.Text != "double speech on a plan" {
		t.Fatalf("show 3: %+v %v", note, err)
	}
	for _, n := range []int{2, 5, 0} {
		if _, err := FindDebugNote(notes, n); err == nil {
			t.Errorf("show %d must fail (malformed or out of range)", n)
		}
	}
	grepped := FilterDebugNotes(notes, LogFilter{Grep: "DOUBLE"})
	if len(grepped) != 1 || grepped[0].N != 3 || grepped[0].Sessions[0].Ref != "store-front/main" {
		t.Fatalf("grep %+v", grepped)
	}
	bySaid := FilterDebugNotes(notes, LogFilter{Grep: "just the question"})
	if len(bySaid) != 1 || bySaid[0].N != 4 {
		t.Fatalf("grep on said %+v", bySaid)
	}
	since, _ := time.Parse(time.RFC3339, "2026-09-30T08:01:00Z")
	until, _ := time.Parse(time.RFC3339, "2026-09-30T08:02:00Z")
	windowed := FilterDebugNotes(notes, LogFilter{Since: since, Until: until})
	if len(windowed) != 1 || windowed[0].Row() != (DebugNoteRow{N: 3, At: "2026-09-30T08:01:30.000Z", View: "store-front/main", Text: "double speech on a plan"}) {
		t.Fatalf("window %+v", windowed)
	}
}

func TestNotesKeysSharedTable(t *testing.T) {
	// One table for both sides: voiceos/src/shared/notes.spec.ts reads it too.
	data, err := os.ReadFile("../../../voiceos/test/fixtures/shared/notes-keys.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name string `json:"name"`
		Key  string `json:"key"`
		File string `json:"file"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) == 0 {
		t.Fatal("empty table")
	}
	for _, c := range cases {
		key := ToNotesKey(c.Name)
		if key != c.Key || NotesFileName(key) != c.File {
			t.Errorf("%q → %q / %q, want %q / %q", c.Name, key, NotesFileName(key), c.Key, c.File)
		}
		if back, ok := notesKeyOf(c.File); !ok || back != c.Key {
			t.Errorf("file %q → %q, want %q", c.File, back, c.Key)
		}
	}
}

func TestParseAndFilterNotes(t *testing.T) {
	data := []byte("# store-front\n- 2026-09-30 09:58 — check the image sizes\n- 2026-09-30 10:05 — try a different tone\n- an old note with no time\nnot a note\n")
	notes := ParseNotes("store-front", data)
	want := []Note{
		{Workspace: "store-front", At: "2026-09-30 09:58", Text: "check the image sizes"},
		{Workspace: "store-front", At: "2026-09-30 10:05", Text: "try a different tone"},
		{Workspace: "store-front", At: "", Text: "an old note with no time"},
	}
	if !reflect.DeepEqual(notes, want) {
		t.Fatalf("got %+v", notes)
	}
	since, _ := ParseWhen("10:00", queryNow)
	if got := FilterNotes(notes, LogFilter{Since: since}, plus2); len(got) != 1 || got[0].Text != "try a different tone" {
		t.Fatalf("since %+v", got)
	}
	if got := FilterNotes(notes, LogFilter{Grep: "IMAGE"}, plus2); len(got) != 1 || got[0].At != "2026-09-30 09:58" {
		t.Fatalf("grep %+v", got)
	}
	if general := ParseNotes(GeneralNotes, []byte("- 2026-09-30 09:00 — x\n")); general[0].Workspace != "general" {
		t.Fatalf("general %+v", general)
	}
}
