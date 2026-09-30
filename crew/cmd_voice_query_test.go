package main

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/voice"
)

var queryClock = time.Date(2026, 9, 30, 10, 30, 0, 0, time.FixedZone("CEST", 2*60*60))

func TestParseQueryArgsRefuses(t *testing.T) {
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"logs", "--limit=5"}, "unknown flag --limit=5"},
		{[]string{"logs", "--around=30s"}, "unknown flag --around=30s"},
		{[]string{"debug-notes", "--cat=router"}, "unknown flag --cat=router"},
		{[]string{"notes", "--until=1h"}, "unknown flag --until=1h"},
		{[]string{"logs", "--lines=0"}, "--lines needs a positive number"},
		{[]string{"logs", "--lines=1001"}, "--lines at most 1000"},
		{[]string{"logs", "--lines=ten"}, "--lines needs a positive number"},
		{[]string{"logs", "--level=loud"}, "--level needs one of debug|info|warn|error"},
		{[]string{"logs", "--since="}, "--since needs a value"},
		{[]string{"logs", "--since=soon"}, "--since \"soon\" is not a time"},
		{[]string{"logs", "--since=1h", "--until=2h"}, "--until is before --since"},
		{[]string{"logs", "extra"}, "unexpected argument 'extra'"},
		{[]string{"debug-notes", "show"}, "say which note"},
		{[]string{"debug-notes", "show", "abc"}, "a note is its number"},
		{[]string{"notes", "store-front", "--all"}, "one workspace, or --all"},
		{[]string{"notes", "a", "b"}, "one workspace, or --all"},
	}
	for _, c := range cases {
		_, err := parseQueryArgs(c.args, queryClock)
		if err == nil || !strings.HasPrefix(err.Error(), c.want) {
			t.Errorf("%v: got %v, want %q", c.args, err, c.want)
		}
	}
}

func TestParseQueryArgs(t *testing.T) {
	q, err := parseQueryArgs([]string{"logs", "--since=10m", "--cat=router, kernel", "--level=warn", "--grep=Signals", "--lines=200", "--machine=vm1,main", "--exclude=vm2", "--local"}, queryClock)
	if err != nil {
		t.Fatal(err)
	}
	if q.kind != queryLogs || q.lines != 200 || !q.local || q.filter.Level != "warn" || q.filter.Grep != "Signals" ||
		!reflect.DeepEqual(q.filter.Cats, []string{"router", "kernel"}) || !reflect.DeepEqual(q.machines, []string{"vm1", "main"}) {
		t.Fatalf("got %+v", q)
	}
	defaults := map[string]int{"logs": 80, "debug-notes": 20, "notes": 20}
	for kind, n := range defaults {
		q, err := parseQueryArgs([]string{kind}, queryClock)
		if err != nil || q.lines != n {
			t.Errorf("%s default lines %d (%v), want %d", kind, q.lines, err, n)
		}
	}
	show, err := parseQueryArgs([]string{"debug-notes", "show", "3", "--around=2m"}, queryClock)
	if err != nil || show.kind != queryShowNote || show.note != 3 || show.around != 2*time.Minute {
		t.Fatalf("show %+v %v", show, err)
	}
	if def, _ := parseQueryArgs([]string{"debug-notes", "show", "1"}, queryClock); def.around != 30*time.Second {
		t.Fatalf("default around %s", def.around)
	}
}

// What a remote forwards: absolute UTC times, the parsed values, never --local,
// --json only when asked.
func TestQueryArgv(t *testing.T) {
	cases := []struct {
		args   []string
		asJSON bool
		want   []string
	}{
		{[]string{"logs", "--since=10m", "--local"}, false, []string{"voice", "logs", "--since=2026-09-30T08:20:00Z", "--lines=80"}},
		{[]string{"logs", "--since=10:02", "--until=10:05", "--cat=a,b", "--level=error", "--grep=x y", "--lines=5", "--machine=vm1", "--exclude=main"}, true,
			[]string{"voice", "logs", "--since=2026-09-30T08:02:00Z", "--until=2026-09-30T08:05:00Z", "--cat=a,b", "--level=error", "--grep=x y", "--lines=5", "--machine=vm1", "--exclude=main", "--json"}},
		{[]string{"debug-notes", "--grep=plan"}, false, []string{"voice", "debug-notes", "--grep=plan", "--lines=20"}},
		{[]string{"debug-notes", "show", "3", "--around=90s"}, true, []string{"voice", "debug-notes", "show", "3", "--around=1m30s", "--json"}},
		{[]string{"notes", "Store Front", "--since=3d"}, false, []string{"voice", "notes", "Store Front", "--since=2026-09-27T08:30:00Z", "--lines=20"}},
		{[]string{"notes", "--all"}, false, []string{"voice", "notes", "--all", "--lines=20"}},
	}
	for _, c := range cases {
		q, err := parseQueryArgs(c.args, queryClock)
		if err != nil {
			t.Fatalf("%v: %v", c.args, err)
		}
		if got := q.argv(c.asJSON); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%v:\n got %q\nwant %q", c.args, got, c.want)
		}
		// The main parses what it is sent into the same query.
		again, err := parseQueryArgs(q.argv(false)[1:], time.Now())
		if err != nil || !reflect.DeepEqual(again.argv(false), q.argv(false)) {
			t.Errorf("%v: forwarded args do not round-trip: %v", c.args, err)
		}
	}
}

func TestRenderDebugNote(t *testing.T) {
	said, asked := "store front please", "ship it"
	note := voice.DebugNote{
		N: 3, At: "2026-09-30T08:01:30.000Z", View: "store-front/main", Text: "double\nspeech", Said: &said,
		HeardHere: []voice.HeardLine{{Utterance: "approve", Did: []string{"answer"}, Reply: "Approved.", At: "2026-09-30T08:01:20.000Z"}},
		Sessions:  []voice.SessionSnapshot{{Ref: "store-front/main", Status: "working", LastAsked: &asked}},
		Asks:      []voice.AskSnapshot{{Ref: "store-front/main", Kind: "plan"}},
	}
	want := "debug note 3\t2026-09-30T08:01:30.000Z\tstore-front/main\n" +
		"note: double speech\n" +
		"said: store front please\n" +
		"heard here:\n  2026-09-30T08:01:20.000Z\t\"approve\"\tdid answer\treply \"Approved.\"\n" +
		"sessions:\n  store-front/main\tworking\tqueued 0\tlast asked \"ship it\"\n" +
		"asks:\n  store-front/main\tplan\n"
	if got := renderDebugNote(note); got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}
