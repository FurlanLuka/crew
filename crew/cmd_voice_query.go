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
		fmt.Fprintf(os.Stderr, "Error: %v\nUsage: %s\n", err, queryUsage[q.kind])
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
// answer. It returns only when a logs query falls back to this machine's
// files; notes and debug notes live on the main alone.
func relayToMain(q logsQuery) (fallback bool) {
	reply, err := voice.AskMain(voice.RemoteQuerySocket(), q.argv(jsonOutput))
	fallback, stderr, code := relayOutcome(q.kind, reply, err)
	if err == nil && reply.OK {
		os.Stdout.WriteString(reply.Value.Stdout)
	}
	os.Stderr.WriteString(stderr)
	if !fallback {
		os.Exit(code)
	}
	return true
}

// relayOutcome is what a remote does with the main's answer: relay it, fall
// back to its own logs with a warning, or fail. A refusal by the main
// ("narrow the filters") never falls back: this machine's lines would answer
// a different question. Pure.
func relayOutcome(kind queryKind, reply voice.QueryReply, err error) (fallback bool, stderr string, code int) {
	if err == nil && reply.OK {
		return false, reply.Value.Stderr, reply.Value.Code
	}
	if err == nil && reply.Reason != "no-main" && reply.Reason != "timeout" {
		return false, fmt.Sprintf("Error: %s\n", reply.Error), 1
	}
	reason := reply.Error
	switch {
	case errors.Is(err, voice.ErrNoQuerySocket):
		reason = "the remote daemon cannot ask the main; " + restartDaemon
		if kind == queryLogs {
			return true, fmt.Sprintf("! %s\n", restartDaemon), 0
		}
	case err != nil:
		reason = err.Error()
	case reason == "":
		reason = notConnected
	}
	if kind != queryLogs {
		return false, fmt.Sprintf("Error: %s — notes and debug notes live on the main\n", reason), 1
	}
	return true, fmt.Sprintf("! %s; %s\n", reason, localOnlyWarn), 0
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
		doc := voice.LogsDoc{Lines: lines, Unreachable: []voice.Unreachable{}}
		if q.local && jsonOutput {
			data, err := voice.EncodeLogsDoc(doc)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			os.Stdout.Write(data)
			return
		}
		printLogs(doc)
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
