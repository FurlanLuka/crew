package voice

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"net"
	"os"
	osexec "os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestDecideRole(t *testing.T) {
	cases := []struct {
		name                               string
		local, cockpit, daemon, hasMachine bool
		want                               Role
	}{
		{"--local wins over everything", true, true, true, true, RoleLocal},
		{"--local on a remote", true, false, true, false, RoleLocal},
		{"the cockpit runs: the main", false, true, false, false, RoleMain},
		{"cockpit and daemon both: the main", false, true, true, true, RoleMain},
		{"the daemon runs: a remote", false, false, true, true, RoleRemote},
		{"nothing runs, machines recorded: the main", false, false, false, true, RoleMain},
		{"nothing at all: alone", false, false, false, false, RoleAlone},
	}
	for _, c := range cases {
		if got := DecideRole(c.local, c.cockpit, c.daemon, c.hasMachine); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestClassifyRemote(t *testing.T) {
	doc := `{"lines":[{"ts":"2026-09-30T08:00:00.000Z","machine":"vm1","level":"info","cat":"a","msg":"m","fields":{}}],"unreachable":[]}`
	cases := []struct {
		name           string
		code           int
		stdout, stderr string
		kind           remoteKind
		reason         string
	}{
		{"JSON after login-shell text", 0, "Welcome to vm1\nLast login: today\n" + doc + "\n", "", remoteAnswered, ""},
		{"an old crew's raw tail", 0, `{"ts":"2026-09-30T08:00:00.000Z","level":"info","cat":"a","msg":"m"}` + "\n", "", remoteTooOld, tooOldReason},
		{"an old crew's usage error", 1, "", "Usage: crew voice [start|stop|restart|status|logs|keys|remote|machines]\n", remoteTooOld, tooOldReason},
		{"ssh could not connect", 255, "", "ssh: connect to host vm2 port 22: Connection refused\n", remoteUnreachable, "unreachable: ssh: connect to host vm2 port 22: Connection refused"},
		{"no crew there", 127, "", "sh: 1: exec: /home/dev/.local/bin/crew: not found\n", remoteUnreachable, "unreachable: sh: 1: exec: /home/dev/.local/bin/crew: not found"},
		{"crew failed", 1, "", "Error: permission denied\n", remoteUnreachable, "failed: permission denied"},
	}
	for _, c := range cases {
		got := classifyRemote(c.code, c.stdout, c.stderr)
		if got.kind != c.kind || got.reason != c.reason {
			t.Errorf("%s: got (%v, %q), want (%v, %q)", c.name, got.kind, got.reason, c.kind, c.reason)
		}
		if c.kind == remoteAnswered && (len(got.doc.Lines) != 1 || got.doc.Lines[0].Msg != "m") {
			t.Errorf("%s: doc %+v", c.name, got.doc)
		}
	}
}

// What --local --json prints is what the main reads back: one line, after
// whatever a login shell said first.
func TestLocalDocumentReadsBackAsAnswered(t *testing.T) {
	line, ok := parseLogLine([]byte(`{"ts":"2026-09-30T08:00:00.000Z","level":"info","cat":"a","msg":"two\nlines","ref":"store-front/main"}`))
	if !ok {
		t.Fatal("fixture line")
	}
	line.Machine = "vm1-host"
	data, err := EncodeLogsDoc(LogsDoc{Lines: []LogLine{line}, Unreachable: []Unreachable{}})
	if err != nil {
		t.Fatal(err)
	}
	got := classifyRemote(0, "Last login: today\n"+string(data), "")
	if got.kind != remoteAnswered || len(got.doc.Lines) != 1 || got.doc.Lines[0].Msg != "two\nlines" || string(got.doc.Lines[0].Fields["ref"]) != `"store-front/main"` {
		t.Fatalf("got %+v", got)
	}
	if empty, _ := EncodeLogsDoc(LogsDoc{Lines: []LogLine{}, Unreachable: []Unreachable{}}); classifyRemote(0, string(empty), "").kind != remoteAnswered {
		t.Fatal("an empty answer is still an answer")
	}
}

// The built command goes through a real sh twice — the login shell's parse,
// then sh -lc — into a stub crew that prints its argv, one per line.
func TestRemoteCrewCommandQuoting(t *testing.T) {
	home := t.TempDir()
	bin := filepath.Join(home, ".local", "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	stub := "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done\n"
	if err := os.WriteFile(filepath.Join(bin, "crew"), []byte(stub), 0o755); err != nil {
		t.Fatal(err)
	}
	// sh -l reads /etc/profile (which may put a real crew on PATH), then
	// ~/.profile: the last word on PATH is this test's, so the stub is the only
	// crew either branch can reach.
	branches := map[string]string{
		"crew on the login PATH":    "PATH=\"$HOME/.local/bin:/usr/bin:/bin\"\n",
		"the ~/.local/bin fallback": "PATH=/usr/bin:/bin\n",
	}
	for branch, profile := range branches {
		if err := os.WriteFile(filepath.Join(home, ".profile"), []byte(profile), 0o644); err != nil {
			t.Fatal(err)
		}
		for _, grep := range []string{"it's", "$HOME", "a; rm -rf ~", "two  spaces", "-x", `"quoted" \back`, "`uname`"} {
			args := RemoteLogArgs(LogFilter{Grep: grep}, 80)
			cmd := osexec.Command("/bin/sh", "-c", RemoteCrewCommand(args))
			cmd.Env = []string{"HOME=" + home, "PATH=/usr/bin:/bin"}
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("%s, %q: %v\n%s", branch, grep, err, out)
			}
			if got := strings.Split(strings.TrimRight(string(out), "\n"), "\n"); !reflect.DeepEqual(got, args) {
				t.Errorf("%s, %q: crew got %q, want %q", branch, grep, got, args)
			}
		}
	}
}

// fakeSSH is an ssh that answers by host: ok prints a document, down exits
// 255, slow hangs past the deadline.
func fakeSSH(t *testing.T) {
	t.Helper()
	script := `#!/bin/sh
while [ "$1" != "--" ]; do shift; done
host="$2"
case "$host" in
ok) echo 'Welcome'; echo '{"lines":[{"ts":"2026-09-30T08:00:05.000Z","machine":"somewhere","level":"info","cat":"remote","msg":"from ok","fields":{}}],"unreachable":[]}' ;;
down) echo 'ssh: connect to host down port 22: Connection refused' >&2; exit 255 ;;
slow) exec sleep 10 ;;
esac
`
	path := filepath.Join(t.TempDir(), "ssh")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	savedBin, savedDeadline := sshBinary, remoteDeadline
	sshBinary, remoteDeadline = path, 500*time.Millisecond
	t.Cleanup(func() { sshBinary, remoteDeadline = savedBin, savedDeadline })
}

func TestGatherLogsAcrossMachines(t *testing.T) {
	isolateConfig(t)
	fakeSSH(t)
	machines := []Machine{{ID: "vm1", Host: "ok", Name: "Build box"}, {ID: "vm2", Host: "down", Name: "vm2"}, {ID: "vm3", Host: "slow", Name: "GPU"}}

	started := time.Now()
	doc, answered := GatherLogs(LogFilter{}, 80, false, machines)
	if took := time.Since(started); took > 3*time.Second {
		t.Fatalf("machines were not asked in parallel within the deadline: %s", took)
	}
	if !answered {
		t.Fatal("one machine answered: exit 0")
	}
	if len(doc.Lines) != 1 || doc.Lines[0].Msg != "from ok" || doc.Lines[0].Machine != "vm1" {
		t.Fatalf("lines %+v", doc.Lines)
	}
	if len(doc.Unreachable) != 2 {
		t.Fatalf("unreachable %+v", doc.Unreachable)
	}
	if u := doc.Unreachable[0]; u.Machine != "vm2" || u.Label() != "vm2" || !strings.Contains(u.Reason, "Connection refused") {
		t.Errorf("vm2 %+v", u)
	}
	if u := doc.Unreachable[1]; u.Label() != "vm3 (GPU)" || !strings.Contains(u.Reason, "no answer within") {
		t.Errorf("vm3 %+v", u)
	}

	_, answered = GatherLogs(LogFilter{}, 80, false, machines[1:])
	if answered {
		t.Fatal("no machine answered: exit 1")
	}
	// The main's own log counts as an answer, even an empty one.
	mainOnly, answered := GatherLogs(LogFilter{}, 80, true, machines[1:2])
	if !answered || mainOnly.Lines == nil {
		t.Fatalf("the main answers: %+v", mainOnly)
	}
}

func TestAskRemoteRefusesABadHost(t *testing.T) {
	fakeSSH(t)
	r := askRemote(Machine{ID: "x", Host: "-oProxyCommand=touch /tmp/pwned"}, []string{"voice"})
	if r.Answered || !strings.Contains(r.Reason, "not an SSH host") {
		t.Fatalf("got %+v", r)
	}
}

type socketFixture struct {
	Request  json.RawMessage `json:"request"`
	Answered json.RawMessage `json:"answered"`
	NoMain   json.RawMessage `json:"noMain"`
	Timeout  json.RawMessage `json:"timeout"`
	Failed   json.RawMessage `json:"failed"`
}

// serveOnce answers one query.sock connection with reply, and hands back the request line.
func serveOnce(t *testing.T, reply []byte) (string, <-chan string) {
	t.Helper()
	// A unix socket path must stay short (104 bytes on macOS): not t.TempDir.
	dir, err := os.MkdirTemp("/tmp", "crewq")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "query.sock")
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	got := make(chan string, 1)
	done := make(chan struct{})
	t.Cleanup(func() { close(done) })
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		line, _ := bufio.NewReader(conn).ReadString('\n')
		got <- line
		if reply == nil {
			// A daemon that never answers: the client's deadline ends it.
			<-done
			return
		}
		// The fixture is pretty-printed; the wire is one line.
		var compact bytes.Buffer
		if err := json.Compact(&compact, reply); err != nil {
			t.Error(err)
			return
		}
		conn.Write(append(compact.Bytes(), '\n'))
	}()
	return socket, got
}

func TestAskMainSharedFixture(t *testing.T) {
	data, err := os.ReadFile("../../../voiceos/test/fixtures/shared/query-socket.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx socketFixture
	if err := json.Unmarshal(data, &fx); err != nil {
		t.Fatal(err)
	}
	var request struct {
		Args []string `json:"args"`
	}
	json.Unmarshal(fx.Request, &request)

	socket, sent := serveOnce(t, fx.Answered)
	reply, err := AskMain(socket, request.Args)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if line := <-sent; !strings.HasSuffix(line, "\n") || json.Unmarshal([]byte(line), &wire) != nil {
		t.Fatalf("one JSON line out, got %q", line)
	}
	var want map[string]any
	json.Unmarshal(fx.Request, &want)
	if !reflect.DeepEqual(wire, want) {
		t.Fatalf("request %v, want %v", wire, want)
	}
	if !reply.OK || reply.Value.Code != 0 || reply.Value.Stdout != "{\"lines\":[],\"unreachable\":[]}\n" || !strings.HasPrefix(reply.Value.Stderr, "! vm2 (build box)") {
		t.Fatalf("reply %+v %+v", reply, reply.Value)
	}

	for name, line := range map[string]json.RawMessage{"no-main": fx.NoMain, "timeout": fx.Timeout, "error": fx.Failed} {
		socket, _ := serveOnce(t, line)
		reply, err := AskMain(socket, request.Args)
		if err != nil || reply.OK || reply.Reason != name || reply.Error == "" {
			t.Errorf("%s: %+v %v", name, reply, err)
		}
	}
}

func TestAskMainWithoutASocket(t *testing.T) {
	_, err := AskMain(filepath.Join(t.TempDir(), "query.sock"), []string{"voice", "logs"})
	if !errors.Is(err, ErrNoQuerySocket) {
		t.Fatalf("got %v", err)
	}
}

func TestAskMainTimesOut(t *testing.T) {
	saved := queryWait
	queryWait = 200 * time.Millisecond
	t.Cleanup(func() { queryWait = saved })
	socket, _ := serveOnce(t, nil)
	reply, err := AskMain(socket, []string{"voice", "logs"})
	if err != nil || reply.OK || reply.Reason != "timeout" {
		t.Fatalf("got %+v %v", reply, err)
	}
}
