package voice

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The pure half of crew server logs|debug-notes|notes: times, filters and the
// parsers of what Voice OS writes. Reading files is query_read.go.

var agoPattern = regexp.MustCompile(`^(?:(\d+)d)?(.*)$`)

// ParseSpan reads a positive length of time: Go's 10m, 1h30m, 45s, plus days (3d, 2d4h). Pure.
func ParseSpan(raw string) (time.Duration, error) {
	m := agoPattern.FindStringSubmatch(strings.TrimSpace(raw))
	if m == nil || (m[1] == "" && m[2] == "") {
		return 0, fmt.Errorf("%q is not a length of time (10m, 2h, 3d)", raw)
	}
	var span time.Duration
	if m[1] != "" {
		days, err := strconv.Atoi(m[1])
		if err != nil {
			return 0, fmt.Errorf("%q is not a length of time (10m, 2h, 3d)", raw)
		}
		span = time.Duration(days) * 24 * time.Hour
	}
	if m[2] != "" {
		rest, err := time.ParseDuration(m[2])
		if err != nil {
			return 0, fmt.Errorf("%q is not a length of time (10m, 2h, 3d)", raw)
		}
		span += rest
	}
	if span <= 0 {
		return 0, fmt.Errorf("%q is not a length of time (10m, 2h, 3d)", raw)
	}
	return span, nil
}

// Times without a zone are the clock of the machine the command was typed on.
var localLayouts = []string{
	"2006-01-02T15:04:05.999999999",
	"2006-01-02T15:04",
	"2006-01-02 15:04:05",
	"2006-01-02 15:04",
	"2006-01-02",
}

// ParseWhen reads --since/--until into a UTC moment: a span back from now
// (10m, 2h, 3d), a clock time today (10:02; one still ahead means yesterday),
// or an ISO time (local when it names no zone). Converted where it was typed,
// so a query forwarded to other machines means the same moment there. Pure.
func ParseWhen(raw string, now time.Time) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if span, err := ParseSpan(raw); err == nil {
		return now.Add(-span).UTC(), nil
	}
	for _, layout := range []string{"15:04", "15:04:05"} {
		clock, err := time.ParseInLocation(layout, raw, now.Location())
		if err != nil {
			continue
		}
		y, mo, d := now.Date()
		at := time.Date(y, mo, d, clock.Hour(), clock.Minute(), clock.Second(), 0, now.Location())
		if at.After(now) {
			at = at.AddDate(0, 0, -1)
		}
		return at.UTC(), nil
	}
	if at, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return at.UTC(), nil
	}
	for _, layout := range localLayouts {
		if at, err := time.ParseInLocation(layout, raw, now.Location()); err == nil {
			return at.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("%q is not a time (10m, 2h, 3d, 10:02, or 2026-09-30T10:02)", raw)
}

// FormatWhen is how a moment travels in forwarded args: UTC RFC 3339. Pure.
func FormatWhen(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

// isoMillis is Voice OS's toISOString: fixed width, so line times compare as strings.
const isoMillis = "2006-01-02T15:04:05.000Z"

var levelRank = map[string]int{"debug": 0, "info": 1, "warn": 2, "error": 3}

// Levels is the order --level reads: a level means it and every one after it.
var Levels = []string{"debug", "info", "warn", "error"}

// LogFilter is what every query filters by; debug notes and notes use the parts they have.
type LogFilter struct {
	Since, Until time.Time // zero: open
	Cats         []string
	Level        string // "": every level
	Grep         string
}

// Args are the filter as flags, rebuilt from the parsed values — never the
// raw args — for a query run on another machine. Pure.
func (f LogFilter) Args() []string {
	var args []string
	if !f.Since.IsZero() {
		args = append(args, "--since="+FormatWhen(f.Since))
	}
	if !f.Until.IsZero() {
		args = append(args, "--until="+FormatWhen(f.Until))
	}
	if len(f.Cats) > 0 {
		args = append(args, "--cat="+strings.Join(f.Cats, ","))
	}
	if f.Level != "" {
		args = append(args, "--level="+f.Level)
	}
	if f.Grep != "" {
		args = append(args, "--grep="+f.Grep)
	}
	return args
}

// lineMatcher is a LogFilter prepared once for a scan of many lines.
type lineMatcher struct {
	since, until string
	cats         map[string]bool
	minLevel     int
	grep         []byte
	// rawRejects: grep holds nothing JSON escapes, so a raw line without it cannot match.
	rawRejects bool
}

func (f LogFilter) matcher() lineMatcher {
	m := lineMatcher{minLevel: levelRank[f.Level]}
	if !f.Since.IsZero() {
		m.since = f.Since.UTC().Format(isoMillis)
	}
	if !f.Until.IsZero() {
		m.until = f.Until.UTC().Format(isoMillis)
	}
	if len(f.Cats) > 0 {
		m.cats = map[string]bool{}
		for _, c := range f.Cats {
			m.cats[c] = true
		}
	}
	if f.Grep != "" {
		m.grep = bytes.ToLower([]byte(f.Grep))
		m.rawRejects = !strings.ContainsFunc(f.Grep, func(r rune) bool { return r == '"' || r == '\\' || r < 0x20 })
	}
	return m
}

// inTime reads only the line's leading "ts": most of a big log is out of the
// window, and this spares decoding it.
func (m lineMatcher) inTime(ts string) bool {
	return (m.since == "" || ts >= m.since) && (m.until == "" || ts <= m.until)
}

func (m lineMatcher) match(raw []byte) (LogLine, bool) {
	ts, ok := leadingTS(raw)
	if !ok || !m.inTime(ts) {
		return LogLine{}, false
	}
	// The raw line is only a quick reject: JSON escapes " and \ there, and
	// its keys ("level", "cat") would match every line.
	if m.grep != nil && m.rawRejects && !bytes.Contains(bytes.ToLower(raw), m.grep) {
		return LogLine{}, false
	}
	line, ok := parseLogLine(raw)
	if !ok {
		return LogLine{}, false
	}
	if m.grep != nil && !bytes.Contains(bytes.ToLower([]byte(searchText(line))), m.grep) {
		return LogLine{}, false
	}
	if m.cats != nil && !m.cats[line.Cat] {
		return LogLine{}, false
	}
	rank, known := levelRank[line.Level]
	if !known {
		rank = levelRank["info"]
	}
	return line, rank >= m.minLevel
}

// Match is one line against the filter. Pure.
func (f LogFilter) Match(raw []byte) (LogLine, bool) { return f.matcher().match(raw) }

// LogLine is one Voice OS log line, labelled with the machine it came from.
type LogLine struct {
	TS      string                     `json:"ts"`
	Machine string                     `json:"machine"`
	Level   string                     `json:"level"`
	Cat     string                     `json:"cat"`
	Msg     string                     `json:"msg"`
	Fields  map[string]json.RawMessage `json:"fields"`
}

// searchText is what --grep reads: the message and the fields' values, strings
// as said, not as JSON spells them; never the keys.
func searchText(l LogLine) string {
	parts := []string{l.Msg}
	for _, v := range l.Fields {
		var text string
		if json.Unmarshal(v, &text) == nil {
			parts = append(parts, text)
		} else {
			parts = append(parts, string(v))
		}
	}
	return strings.Join(parts, "\n")
}

var tsPrefix = []byte(`{"ts":"`)

// leadingTS: Voice OS writes "ts" first (voiceos/src/log.ts), as toISOString, so
// the prefix is read without decoding; any other spelling of a JSON line (spaces,
// ts later on) is decoded rather than dropped. Pure.
func leadingTS(raw []byte) (string, bool) {
	if !bytes.HasPrefix(raw, tsPrefix) {
		var line struct {
			TS string `json:"ts"`
		}
		if json.Unmarshal(raw, &line) != nil || line.TS == "" {
			return "", false
		}
		return line.TS, true
	}
	rest := raw[len(tsPrefix):]
	end := bytes.IndexByte(rest, '"')
	if end < 0 {
		return "", false
	}
	return string(rest[:end]), true
}

func parseLogLine(raw []byte) (LogLine, bool) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return LogLine{}, false
	}
	line := LogLine{Fields: map[string]json.RawMessage{}}
	for key, dst := range map[string]*string{"ts": &line.TS, "level": &line.Level, "cat": &line.Cat, "msg": &line.Msg} {
		if v, ok := obj[key]; ok {
			if json.Unmarshal(v, dst) != nil {
				return LogLine{}, false
			}
			delete(obj, key)
		}
	}
	if line.TS == "" {
		return LogLine{}, false
	}
	for k, v := range obj {
		line.Fields[k] = v
	}
	return line, true
}

// MergeByTime interleaves machines' lines by time; equal times keep their
// order (a machine's own lines stay as written). Pure.
func MergeByTime(groups ...[]LogLine) []LogLine {
	merged := []LogLine{}
	for _, g := range groups {
		merged = append(merged, g...)
	}
	sort.SliceStable(merged, func(i, j int) bool { return merged[i].TS < merged[j].TS })
	return merged
}

// Newest keeps the last n, oldest first; n <= 0 keeps every one. Pure.
func Newest[T any](items []T, n int) []T {
	if n > 0 && len(items) > n {
		return slices.Clone(items[len(items)-n:])
	}
	return items
}

// FormatLogRow is the tab row crew server logs prints. Pure.
func FormatLogRow(l LogLine) string {
	fields := "{}"
	if len(l.Fields) > 0 {
		if data, err := json.Marshal(l.Fields); err == nil {
			fields = string(data)
		}
	}
	return strings.Join([]string{l.TS, l.Machine, l.Level, l.Cat, OneLine(l.Msg), fields}, "\t")
}

// OneLine keeps a value in its tab column.
func OneLine(s string) string {
	return strings.NewReplacer("\t", " ", "\n", " ", "\r", " ").Replace(s)
}

// DebugNote is one line of debug-notes.jsonl (voiceos/src/memory/debug-notes.ts).
// N is its position in the file, so a filtered list keeps the numbers show takes.
type DebugNote struct {
	N         int               `json:"n"`
	At        string            `json:"at"`
	Text      string            `json:"text"`
	Said      *string           `json:"said"`
	View      string            `json:"view"`
	HeardHere []HeardLine       `json:"heardHere"`
	Sessions  []SessionSnapshot `json:"sessions"`
	Asks      []AskSnapshot     `json:"asks"`
	Spoken    []SpokenLine      `json:"spoken"`
	DevOffer  *string           `json:"devOffer"`
}

type HeardLine struct {
	Utterance string   `json:"utterance"`
	Did       []string `json:"did"`
	Reply     string   `json:"reply"`
	At        string   `json:"at"`
}

type SessionSnapshot struct {
	Ref       string  `json:"ref"`
	Status    string  `json:"status"`
	Queued    int     `json:"queued"`
	NeedsUser *string `json:"needsUser"`
	LastAsked *string `json:"lastAsked"`
}

type AskSnapshot struct {
	Ref  string `json:"ref"`
	Kind string `json:"kind"`
}

type SpokenLine struct {
	Source string `json:"source"`
	Text   string `json:"text"`
	At     string `json:"at"`
}

// DebugNoteRow is a note in the list: what tells one from another.
type DebugNoteRow struct {
	N    int    `json:"n"`
	At   string `json:"at"`
	View string `json:"view"`
	Text string `json:"text"`
}

func (n DebugNote) Row() DebugNoteRow {
	return DebugNoteRow{N: n.N, At: n.At, View: n.View, Text: n.Text}
}

// ParseDebugNotes numbers every non-empty line, a malformed one included, so
// the numbers never shift when one line is bad. Pure.
func ParseDebugNotes(data []byte) []DebugNote {
	notes := []DebugNote{}
	n := 0
	for _, raw := range bytes.Split(data, []byte("\n")) {
		if len(bytes.TrimSpace(raw)) == 0 {
			continue
		}
		n++
		var note DebugNote
		if err := json.Unmarshal(raw, &note); err != nil || note.At == "" {
			continue
		}
		note.N = n
		notes = append(notes, note)
	}
	return notes
}

// FindDebugNote is note n as crew server debug-notes numbered it. Pure.
func FindDebugNote(notes []DebugNote, n int) (DebugNote, error) {
	for _, note := range notes {
		if note.N == n {
			return note, nil
		}
	}
	return DebugNote{}, fmt.Errorf("no debug note %d (crew server debug-notes lists them)", n)
}

// FilterDebugNotes keeps the notes in the window whose words hold grep. Pure.
func FilterDebugNotes(notes []DebugNote, f LogFilter) []DebugNote {
	kept := []DebugNote{}
	grep := strings.ToLower(f.Grep)
	for _, note := range notes {
		at, err := time.Parse(time.RFC3339Nano, note.At)
		if err != nil || !inWindow(at, f) {
			continue
		}
		said := ""
		if note.Said != nil {
			said = *note.Said
		}
		if grep != "" && !strings.Contains(strings.ToLower(note.Text+"\n"+said+"\n"+note.View), grep) {
			continue
		}
		kept = append(kept, note)
	}
	return kept
}

func inWindow(at time.Time, f LogFilter) bool {
	return (f.Since.IsZero() || !at.Before(f.Since)) && (f.Until.IsZero() || !at.After(f.Until))
}
