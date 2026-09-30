package voice

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	osexec "os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/debug"
	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

// Role is which path a query takes on this machine.
type Role int

const (
	// RoleLocal: --local, this machine's files only — a forwarded query never forwards again.
	RoleLocal Role = iota
	// RoleMain: the cockpit runs here, or machines.json exists: the main's files plus remotes over SSH.
	RoleMain
	// RoleRemote: the remote daemon runs here; the main answers through its link.
	RoleRemote
	// RoleAlone: nothing runs and no machines are recorded: this machine's files.
	RoleAlone
)

// DecideRole checks in the plan's order: --local, cockpit, daemon, machines.json. Pure.
func DecideRole(local, cockpit, daemon, hasMachines bool) Role {
	switch {
	case local:
		return RoleLocal
	case cockpit:
		return RoleMain
	case daemon:
		return RoleRemote
	case hasMachines:
		return RoleMain
	}
	return RoleAlone
}

func CurrentRole(local bool) Role {
	if local {
		return RoleLocal
	}
	_, err := os.Stat(MachinesFile())
	return DecideRole(false, CockpitRunning(), RemoteRunning(), err == nil)
}

// LogsDoc is crew voice logs --json, and what a remote's --local answers with.
type LogsDoc struct {
	Lines       []LogLine     `json:"lines"`
	Unreachable []Unreachable `json:"unreachable"`
}

type Unreachable struct {
	Machine string `json:"machine"`
	Name    string `json:"name"`
	Reason  string `json:"reason"`
}

// EncodeLogsDoc is what --local --json prints: one line, because the main
// reads a remote's answer off the last stdout line (a login shell may print
// before it). Pure.
func EncodeLogsDoc(doc LogsDoc) ([]byte, error) {
	data, err := json.Marshal(doc)
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

// Label is how a machine is named in a warning: "vm2 (build box)", or its id alone.
func (u Unreachable) Label() string {
	if u.Name == "" || u.Name == u.Machine {
		return u.Machine
	}
	return fmt.Sprintf("%s (%s)", u.Machine, u.Name)
}

// sshBinary and remoteDeadline are vars so tests run a fake ssh with a short wait.
var (
	sshBinary      = "ssh"
	remoteDeadline = 20 * time.Second
)

// RemoteLogArgs is the query a remote runs over SSH: its own files as JSON,
// the filters rebuilt from the parsed query. Pure.
func RemoteLogArgs(f LogFilter, lines int) []string {
	args := []string{"voice", "logs", "--local", "--json"}
	args = append(args, f.Args()...)
	return append(args, fmt.Sprintf("--lines=%d", lines))
}

// RemoteCrewCommand is what ssh hands the remote user's login shell. Quoted
// twice: each arg for sh, then the whole sh script for the login shell (bash,
// zsh, fish all read single quotes). crew may be on the login PATH or only in
// ~/.local/bin, where install.sh puts it — the same fallback as
// voiceos/src/remote/ssh.ts buildRemoteCrewCommand; change the two together. Pure.
func RemoteCrewCommand(args []string) string {
	quoted := make([]string, len(args))
	for i, a := range args {
		quoted[i] = crewExec.ShellQuote(a)
	}
	line := strings.Join(quoted, " ")
	script := fmt.Sprintf(`command -v crew >/dev/null 2>&1 && exec crew %s; exec "$HOME/.local/bin/crew" %s`, line, line)
	return "sh -lc " + crewExec.ShellQuote(script)
}

// sshArgv: BatchMode, so never a password prompt nobody can answer. Pure.
func sshArgv(host, command string) []string {
	return []string{"-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", host, command}
}

type remoteKind int

const (
	remoteAnswered remoteKind = iota
	remoteTooOld
	remoteUnreachable
)

type remoteAnswer struct {
	kind   remoteKind
	doc    LogsDoc
	reason string
}

const tooOldReason = "runs an older crew; run crew update there"

// classifyRemote sorts what a remote's crew said. The document is the last
// stdout line (a login shell may print before it); an old crew ignores the
// flags and prints a raw tail — log lines are JSON too, but never a document
// with "lines". Pure.
func classifyRemote(code int, stdout, stderr string) remoteAnswer {
	if doc, ok := lastDocument(stdout); ok {
		return remoteAnswer{kind: remoteAnswered, doc: doc}
	}
	last := lastLine(stderr)
	switch {
	case code == 255 || code == 127:
		if last == "" {
			last = fmt.Sprintf("ssh exited %d", code)
		}
		return remoteAnswer{kind: remoteUnreachable, reason: "unreachable: " + last}
	case code == 0, strings.Contains(stderr, "Usage: crew voice"):
		return remoteAnswer{kind: remoteTooOld, reason: tooOldReason}
	}
	if last == "" {
		last = fmt.Sprintf("crew exited %d", code)
	}
	return remoteAnswer{kind: remoteUnreachable, reason: "failed: " + strings.TrimPrefix(last, "Error: ")}
}

func lastDocument(stdout string) (LogsDoc, bool) {
	var doc struct {
		Lines       *[]LogLine    `json:"lines"`
		Unreachable []Unreachable `json:"unreachable"`
	}
	line := lastLine(stdout)
	if !strings.HasPrefix(line, "{") || json.Unmarshal([]byte(line), &doc) != nil || doc.Lines == nil {
		return LogsDoc{}, false
	}
	return LogsDoc{Lines: *doc.Lines, Unreachable: doc.Unreachable}, true
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

// RemoteResult is one machine's part of a query.
type RemoteResult struct {
	Machine  Machine
	Answered bool
	Lines    []LogLine
	Reason   string
}

func (r RemoteResult) Unreachable() Unreachable {
	return Unreachable{Machine: r.Machine.ID, Name: r.Machine.Name, Reason: r.Reason}
}

// AskRemotes runs args on every machine at once, each with its own deadline,
// and returns in the machines' order.
func AskRemotes(machines []Machine, args []string) []RemoteResult {
	results := make([]RemoteResult, len(machines))
	var wg sync.WaitGroup
	for i, m := range machines {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = askRemote(m, args)
		}()
	}
	wg.Wait()
	return results
}

func askRemote(m Machine, args []string) RemoteResult {
	result := RemoteResult{Machine: m}
	if !ValidHost(m.Host) {
		result.Reason = fmt.Sprintf("unreachable: %q is not an SSH host", m.Host)
		return result
	}
	ctx, cancel := context.WithTimeout(context.Background(), remoteDeadline)
	defer cancel()
	argv := sshArgv(m.Host, RemoteCrewCommand(args))
	debug.Log("voice", "%s %s", sshBinary, strings.Join(argv, " "))
	cmd := osexec.CommandContext(ctx, sshBinary, argv...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	// A ControlMaster left behind can hold the pipes open past the kill.
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	if ctx.Err() != nil {
		debug.Log("voice", "%s: no answer within %s", m.ID, remoteDeadline)
		result.Reason = fmt.Sprintf("unreachable: no answer within %s", remoteDeadline)
		return result
	}
	code := 0
	var exitErr *osexec.ExitError
	switch {
	case errors.As(err, &exitErr):
		code = exitErr.ExitCode()
	case err != nil:
		debug.Log("voice", "%s: %v", m.ID, err)
		result.Reason = "unreachable: " + err.Error()
		return result
	}
	answer := classifyRemote(code, stdout.String(), stderr.String())
	debug.Log("voice", "%s: exit %d, %d lines, %s", m.ID, code, len(answer.doc.Lines), answer.reason)
	if answer.kind != remoteAnswered {
		result.Reason = answer.reason
		return result
	}
	result.Answered = true
	result.Lines = answer.doc.Lines
	for i := range result.Lines {
		result.Lines[i].Machine = m.ID
	}
	return result
}

// GatherLogs is the main's own log (withMain) and every remote's, merged by
// time, newest n; answered when at least one machine did, the main included.
func GatherLogs(f LogFilter, n int, withMain bool, remotes []Machine) (LogsDoc, bool) {
	doc := LogsDoc{Lines: []LogLine{}, Unreachable: []Unreachable{}}
	var groups [][]LogLine
	answered := false
	if withMain {
		lines, err := LocalLogs(f, n, MainMachine)
		if err != nil {
			doc.Unreachable = append(doc.Unreachable, Unreachable{Machine: MainMachine, Name: MainMachine, Reason: "log unreadable: " + err.Error()})
		} else {
			groups, answered = append(groups, lines), true
		}
	}
	for _, r := range AskRemotes(remotes, RemoteLogArgs(f, n)) {
		if r.Answered {
			groups, answered = append(groups, r.Lines), true
			continue
		}
		doc.Unreachable = append(doc.Unreachable, r.Unreachable())
	}
	doc.Lines = Newest(MergeByTime(groups...), n)
	return doc, answered
}

// queryWait is the outermost deadline: the daemon's own (30 s) answers first.
var queryWait = 35 * time.Second

// ErrNoQuerySocket: the daemon predates query.sock, or is not listening.
var ErrNoQuerySocket = errors.New("the remote daemon has no query socket")

// QueryReply is the one line the daemon answers on query.sock
// (voiceos/test/fixtures/shared/query-socket.json).
type QueryReply struct {
	OK     bool        `json:"ok"`
	Value  *QueryValue `json:"value,omitempty"`
	Reason string      `json:"reason,omitempty"`
	Error  string      `json:"error,omitempty"`
}

// QueryValue is the main's crew run, relayed as it was.
type QueryValue struct {
	Code   int    `json:"code"`
	Stdout string `json:"stdout"`
	Stderr string `json:"stderr"`
}

// AskMain asks the main to run `crew <args>` through the remote daemon's link:
// one line out, one line back.
func AskMain(socket string, args []string) (QueryReply, error) {
	debug.Log("voice", "query.sock ← %s", strings.Join(args, " "))
	conn, err := net.DialTimeout("unix", socket, 2*time.Second)
	if errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ECONNREFUSED) {
		return QueryReply{}, ErrNoQuerySocket
	}
	if err != nil {
		return QueryReply{}, err
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(queryWait))

	var request bytes.Buffer
	enc := json.NewEncoder(&request)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(map[string][]string{"args": args}); err != nil {
		return QueryReply{}, err
	}
	if _, err := conn.Write(request.Bytes()); err != nil {
		return QueryReply{}, err
	}
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return QueryReply{Reason: "timeout", Error: fmt.Sprintf("the main did not answer in %s", queryWait)}, nil
	}
	if err != nil {
		return QueryReply{}, fmt.Errorf("the remote daemon closed the query: %w", err)
	}
	var reply QueryReply
	if err := json.Unmarshal(line, &reply); err != nil {
		return QueryReply{}, fmt.Errorf("the remote daemon answered something unreadable: %w", err)
	}
	if reply.OK && reply.Value == nil {
		return QueryReply{}, errors.New("the remote daemon answered with no value")
	}
	debug.Log("voice", "query.sock → ok=%v reason=%q", reply.OK, reply.Reason)
	return reply, nil
}
