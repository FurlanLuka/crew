package main

import (
	"errors"
	"fmt"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/voice"
)

// crew voice logs | debug-notes [show <n>] | notes: read-only queries over
// what Voice OS writes. Logs are on every machine, notes and debug notes on
// the main; a remote asks the main through its daemon's link.

type queryKind string

const (
	queryLogs       queryKind = "logs"
	queryDebugNotes queryKind = "debug-notes"
	queryShowNote   queryKind = "debug-notes show"
	queryNotes      queryKind = "notes"
)

// The main's Voice OS admits exactly these flags from a remote (link.ts isAllowedQuery).
var queryFlags = map[queryKind][]string{
	queryLogs:       {"--since", "--until", "--cat", "--level", "--grep", "--lines", "--machine", "--exclude"},
	queryDebugNotes: {"--since", "--until", "--grep", "--lines"},
	queryShowNote:   {"--around"},
	queryNotes:      {"--since", "--grep", "--lines", "--all"},
}

var queryUsage = map[queryKind]string{
	queryLogs:       "crew voice logs [--since=] [--until=] [--cat=<c,…>] [--level=<debug|info|warn|error>] [--grep=] [--lines=<n>] [--machine=<id|name|main,…>] [--exclude=<…>] [--json]",
	queryDebugNotes: "crew voice debug-notes [--since=] [--until=] [--grep=] [--lines=<n>] [--json]",
	queryShowNote:   "crew voice debug-notes show <n> [--around=30s] [--json]",
	queryNotes:      "crew voice notes [<workspace>|--all] [--since=] [--grep=] [--lines=<n>] [--json]",
}

const (
	maxQueryLines = 1000
	defaultAround = 30 * time.Second
	notConnected  = "the main is not connected"
	restartDaemon = "restart the remote daemon with crew voice remote"
	localOnlyWarn = "showing only this machine's logs"
)

type logsQuery struct {
	kind   queryKind
	filter voice.LogFilter
	lines  int
	// machines and exclude: --machine / --exclude words, checked against machines.json later.
	machines, exclude []string
	around            time.Duration
	note              int
	workspace         string
	all               bool
	local             bool
}

// parseQueryArgs reads the args after `crew voice` (the global --json already
// stripped). Relative times become absolute here, where they were typed. Pure.
func parseQueryArgs(args []string, now time.Time) (logsQuery, error) {
	q := logsQuery{kind: queryKind(args[0]), around: defaultAround}
	rest := args[1:]
	if q.kind == queryDebugNotes && len(rest) > 0 && rest[0] == "show" {
		q.kind, rest = queryShowNote, rest[1:]
	}
	allowed, known := queryFlags[q.kind]
	if !known {
		return q, fmt.Errorf("unknown query %q", args[0])
	}
	q.lines = 20
	if q.kind == queryLogs {
		q.lines = 80
	}

	var positionals []string
	for _, a := range rest {
		if a == "--local" {
			q.local = true
			continue
		}
		if !strings.HasPrefix(a, "-") {
			positionals = append(positionals, a)
			continue
		}
		name, value, hasValue := strings.Cut(a, "=")
		if !slices.Contains(allowed, name) {
			return q, fmt.Errorf("unknown flag %s", a)
		}
		if name == "--all" {
			if hasValue {
				return q, fmt.Errorf("--all takes no value")
			}
			q.all = true
			continue
		}
		if value == "" {
			return q, fmt.Errorf("%s needs a value (%s=…)", name, name)
		}
		if err := q.setFlag(name, value, now); err != nil {
			return q, err
		}
	}
	if err := q.setPositionals(positionals); err != nil {
		return q, err
	}
	if !q.filter.Since.IsZero() && !q.filter.Until.IsZero() && q.filter.Until.Before(q.filter.Since) {
		return q, fmt.Errorf("--until is before --since")
	}
	return q, nil
}

func (q *logsQuery) setFlag(name, value string, now time.Time) error {
	var err error
	switch name {
	case "--since":
		q.filter.Since, err = voice.ParseWhen(value, now)
	case "--until":
		q.filter.Until, err = voice.ParseWhen(value, now)
	case "--cat":
		q.filter.Cats = splitList(value)
	case "--level":
		if !slices.Contains(voice.Levels, value) {
			return fmt.Errorf("--level needs one of %s, got '%s'", strings.Join(voice.Levels, "|"), value)
		}
		q.filter.Level = value
	case "--grep":
		q.filter.Grep = value
	case "--lines":
		q.lines, err = parseIntFlag(value, true)
		if err == nil && q.lines > maxQueryLines {
			err = fmt.Errorf("at most %d", maxQueryLines)
		}
	case "--machine":
		q.machines = splitList(value)
	case "--exclude":
		q.exclude = splitList(value)
	case "--around":
		q.around, err = voice.ParseSpan(value)
	}
	if err != nil {
		return fmt.Errorf("%s %v", name, err)
	}
	return nil
}

func (q *logsQuery) setPositionals(positionals []string) error {
	switch q.kind {
	case queryShowNote:
		if len(positionals) != 1 {
			return fmt.Errorf("say which note: debug-notes show <n>")
		}
		n, err := strconv.Atoi(positionals[0])
		if err != nil || n <= 0 {
			return fmt.Errorf("a note is its number from crew voice debug-notes, got '%s'", positionals[0])
		}
		q.note = n
		return nil
	case queryNotes:
		if len(positionals) > 1 || (len(positionals) == 1 && q.all) {
			return fmt.Errorf("one workspace, or --all")
		}
		if len(positionals) == 1 {
			q.workspace = positionals[0]
		}
		return nil
	}
	if len(positionals) > 0 {
		return fmt.Errorf("unexpected argument '%s'", positionals[0])
	}
	return nil
}

// argv is the query as the main runs it for a remote: rebuilt from the parsed
// values (absolute times, never --local), with --json only when asked, so the
// human form comes back as the main prints it. Pure.
func (q logsQuery) argv(asJSON bool) []string {
	args := []string{"voice"}
	switch q.kind {
	case queryShowNote:
		args = append(args, "debug-notes", "show", strconv.Itoa(q.note), "--around="+q.around.String())
	case queryNotes:
		args = append(args, "notes")
		if q.workspace != "" {
			args = append(args, q.workspace)
		}
		if q.all {
			args = append(args, "--all")
		}
	default:
		args = append(args, string(q.kind))
	}
	if q.kind != queryShowNote {
		args = append(args, q.filter.Args()...)
		args = append(args, fmt.Sprintf("--lines=%d", q.lines))
	}
	if len(q.machines) > 0 {
		args = append(args, "--machine="+strings.Join(q.machines, ","))
	}
	if len(q.exclude) > 0 {
		args = append(args, "--exclude="+strings.Join(q.exclude, ","))
	}
	if asJSON {
		args = append(args, "--json")
	}
	return args
}

// voiceQuery runs crew voice logs|debug-notes|notes.
func voiceQuery(args []string) {
	q, err := parseQueryArgs(args, time.Now())
	if err != nil {
		usage := queryUsage[q.kind]
		if usage == "" {
			usage = queryUsage[queryLogs]
		}
		fmt.Fprintf(os.Stderr, "Error: %v\nUsage: %s\n", err, usage)
		os.Exit(1)
	}
	role := voice.CurrentRole(q.local)
	if role == voice.RoleRemote {
		if fallback := relayToMain(q); !fallback {
			return
		}
	}
	switch q.kind {
	case queryLogs:
		queryLogsHere(q, role)
	case queryDebugNotes:
		listDebugNotes(q)
	case queryShowNote:
		showDebugNote(q)
	case queryNotes:
		listNotes(q)
	}
}

// relayToMain asks the main through the daemon's link and exits with its
// answer. It returns only when a logs query should fall back to this
// machine's files; notes and debug notes live on the main alone.
func relayToMain(q logsQuery) (fallback bool) {
	reply, err := voice.AskMain(voice.RemoteQuerySocket(), q.argv(jsonOutput))
	if err == nil && reply.OK {
		os.Stdout.WriteString(reply.Value.Stdout)
		os.Stderr.WriteString(reply.Value.Stderr)
		os.Exit(reply.Value.Code)
	}
	reason := ""
	switch {
	case errors.Is(err, voice.ErrNoQuerySocket):
		reason = restartDaemon
	case err != nil:
		reason = err.Error()
	case reply.Reason == "no-main" || reply.Reason == "timeout":
		reason = notConnected
		if reply.Reason == "timeout" {
			reason = reply.Error
		}
	default:
		fmt.Fprintf(os.Stderr, "Error: %s\n", reply.Error)
		os.Exit(1)
	}
	if q.kind != queryLogs {
		if reason == restartDaemon {
			reason = "the remote daemon cannot ask the main; " + restartDaemon
		}
		fmt.Fprintf(os.Stderr, "Error: %s — notes and debug notes live on the main\n", reason)
		os.Exit(1)
	}
	if reason == restartDaemon {
		fmt.Fprintf(os.Stderr, "! %s\n", restartDaemon)
	} else {
		fmt.Fprintf(os.Stderr, "! %s; %s\n", notConnected, localOnlyWarn)
	}
	return true
}

// thisMachine labels a remote's own lines when the main cannot: its short hostname.
func thisMachine() string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		return "this-machine"
	}
	return strings.SplitN(host, ".", 2)[0]
}

func queryLogsHere(q logsQuery, role voice.Role) {
	if role == voice.RoleLocal || role == voice.RoleRemote {
		lines, err := voice.LocalLogs(q.filter, q.lines, thisMachine())
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		printLogs(voice.LogsDoc{Lines: lines, Unreachable: []voice.Unreachable{}})
		return
	}

	machines, err := voice.ReadMachines()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	withMain, remotes, err := voice.SelectMachines(machines, q.machines, q.exclude)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if !withMain && len(remotes) == 0 {
		fmt.Fprintln(os.Stderr, "Error: every machine is excluded")
		os.Exit(1)
	}
	if len(remotes) > 0 {
		fmt.Fprintf(os.Stderr, "! asking %d %s…\n", len(remotes), plural(len(remotes), "machine"))
	}
	doc, answered := voice.GatherLogs(q.filter, q.lines, withMain, remotes)
	for _, u := range doc.Unreachable {
		fmt.Fprintf(os.Stderr, "! %s %s\n", u.Label(), u.Reason)
	}
	printLogs(doc)
	if !answered {
		os.Exit(1)
	}
}

func plural(n int, word string) string {
	if n == 1 {
		return word
	}
	return word + "s"
}

func printLogs(doc voice.LogsDoc) {
	if jsonOutput {
		printJSON(doc)
		return
	}
	for _, line := range doc.Lines {
		fmt.Println(voice.FormatLogRow(line))
	}
}

func mustDebugNotes() []voice.DebugNote {
	notes, err := voice.ReadDebugNotes()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	return notes
}

func listDebugNotes(q logsQuery) {
	notes := voice.Newest(voice.FilterDebugNotes(mustDebugNotes(), q.filter), q.lines)
	rows := make([]voice.DebugNoteRow, 0, len(notes))
	for _, note := range notes {
		rows = append(rows, note.Row())
	}
	if jsonOutput {
		printJSON(map[string]any{"notes": rows})
		return
	}
	for _, r := range rows {
		fmt.Printf("%d\t%s\t%s\t%s\n", r.N, r.At, r.View, voice.OneLine(r.Text))
	}
}

func showDebugNote(q logsQuery) {
	note, err := voice.FindDebugNote(mustDebugNotes(), q.note)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	at, err := time.Parse(time.RFC3339Nano, note.At)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: debug note %d has no readable time (%q)\n", q.note, note.At)
		os.Exit(1)
	}
	window := voice.LogFilter{Since: at.Add(-q.around), Until: at.Add(q.around)}
	read, err := voice.ReadLog(voice.RotatedFiles(voice.LogFile()), window, 0, voice.MainMachine)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if warning := read.RotatedOut(window.Since); warning != "" {
		fmt.Fprintf(os.Stderr, "! %s\n", warning)
	}
	if jsonOutput {
		printJSON(map[string]any{"note": note, "lines": read.Lines})
		return
	}
	fmt.Print(renderDebugNote(note))
	fmt.Printf("\nlog %s … %s:\n", voice.FormatWhen(window.Since), voice.FormatWhen(window.Until))
	for _, line := range read.Lines {
		fmt.Println(voice.FormatLogRow(line))
	}
}

// renderDebugNote is show's human form: the note, then what was around it. Pure.
func renderDebugNote(n voice.DebugNote) string {
	var b strings.Builder
	fmt.Fprintf(&b, "debug note %d\t%s\t%s\n", n.N, n.At, n.View)
	fmt.Fprintf(&b, "note: %s\n", voice.OneLine(n.Text))
	if n.Said != nil {
		fmt.Fprintf(&b, "said: %s\n", voice.OneLine(*n.Said))
	}
	if len(n.HeardHere) > 0 {
		b.WriteString("heard here:\n")
		for _, h := range n.HeardHere {
			fmt.Fprintf(&b, "  %s\t%q\tdid %s\treply %q\n", h.At, h.Utterance, strings.Join(h.Did, ", "), h.Reply)
		}
	}
	if len(n.Sessions) > 0 {
		b.WriteString("sessions:\n")
		for _, s := range n.Sessions {
			fmt.Fprintf(&b, "  %s\t%s\tqueued %d", s.Ref, s.Status, s.Queued)
			if s.NeedsUser != nil {
				fmt.Fprintf(&b, "\tneeds %q", *s.NeedsUser)
			}
			if s.LastAsked != nil {
				fmt.Fprintf(&b, "\tlast asked %q", *s.LastAsked)
			}
			b.WriteString("\n")
		}
	}
	if len(n.Asks) > 0 {
		b.WriteString("asks:\n")
		for _, a := range n.Asks {
			fmt.Fprintf(&b, "  %s\t%s\n", a.Ref, a.Kind)
		}
	}
	if len(n.Spoken) > 0 {
		b.WriteString("spoken:\n")
		for _, s := range n.Spoken {
			fmt.Fprintf(&b, "  %s\t%s\t%q\n", s.At, s.Source, s.Text)
		}
	}
	if n.DevOffer != nil {
		fmt.Fprintf(&b, "dev offer: %s\n", *n.DevOffer)
	}
	return b.String()
}

func listNotes(q logsQuery) {
	var keys []string
	if !q.all {
		keys = []string{voice.ToNotesKey(q.workspace)}
	}
	byKey, order, err := voice.ReadNotes(keys)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	notes := []voice.Note{}
	for _, key := range order {
		// --lines counts per workspace: --all is one list per workspace, as Voice OS reads them.
		notes = append(notes, voice.Newest(voice.FilterNotes(byKey[key], q.filter, time.Local), q.lines)...)
	}
	if jsonOutput {
		printJSON(map[string]any{"notes": notes})
		return
	}
	if len(notes) == 0 && !q.all && q.filter.Grep == "" && q.filter.Since.IsZero() {
		fmt.Fprintf(os.Stderr, "No notes for %s yet.\n", voice.NameNotes(keys[0]))
	}
	for _, n := range notes {
		fmt.Printf("%s\t%s\t%s\n", n.Workspace, n.At, n.Text)
	}
}
