package workspace

import (
	"fmt"
	"net"
	"os"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// SmokeResult is one server's fate a few seconds after start.
type SmokeResult struct {
	Project   string `json:"project"`
	Server    string `json:"server"`
	Port      int    `json:"port"`
	Alive     bool   `json:"alive"`
	Listening bool   `json:"listening"` // something accepts on its port
	// Referenced: a binding somewhere points at this server, so a port
	// nobody listens on is a dead URL crew handed out.
	Referenced bool   `json:"referenced"`
	Tail       string `json:"tail,omitempty"`     // last few log lines, for the terminal
	Evidence   string `json:"evidence,omitempty"` // a longer tail, kept on the worktree for whoever fixes it
	// TookMs is how long the verdict took: a server that listens in two
	// seconds passes in two, one that never does fails at the ceiling.
	TookMs int64 `json:"took_ms"`
}

// SmokeState is the one verdict every reader switches on.
type SmokeState int

const (
	SmokeOK        SmokeState = iota
	SmokeDied                 // the pane's process is gone
	SmokeUnreached            // runs, nothing listens, and a binding points at it — a dead URL crew handed out
	SmokeIdle                 // runs, nothing listens, nobody points at it — a worker; a note, not a failure
)

// State is pure over the three facts the inspection reads.
func (r SmokeResult) State() SmokeState {
	switch {
	case !r.Alive:
		return SmokeDied
	case r.Listening:
		return SmokeOK
	case r.Referenced:
		return SmokeUnreached
	default:
		return SmokeIdle
	}
}

// Failed: crew only asserts the URLs it handed out, so an idle worker is
// not a failure.
func (r SmokeResult) Failed() bool {
	st := r.State()
	return st == SmokeDied || st == SmokeUnreached
}

// Took is how long the verdict took.
func (r SmokeResult) Took() time.Duration { return time.Duration(r.TookMs) * time.Millisecond }

// withoutStarting drops the servers still coming up — for a page that
// must not hand Claude a verdict it does not have yet. Pure.
func withoutStarting(results []SmokeResult) []SmokeResult {
	var decided []SmokeResult
	for _, r := range results {
		if r.State() != SmokeUnreached {
			decided = append(decided, r)
		}
	}
	return decided
}

// SmokeCeiling is how long a referenced server gets to start listening.
// A variable so tests can shorten it; there is no per-server knob — one
// ceiling, and a server that listens sooner passes sooner.
var SmokeCeiling = 60 * time.Second

const (
	smokeTick = time.Second
	// deadGrace: right after a start the pane's shell has not launched the
	// command yet, and "not busy" would read as "died". A pane never seen
	// busy is only dead after this. Four seconds, not two: on a loaded
	// machine (several runners starting smokes at once) zsh took longer
	// than two to reach the command, and a false "died" is the one verdict
	// crew must not hand out.
	deadGrace = 4 * time.Second
	smokeTail = 4
	// A stack trace usually sits above the one line that says why; the
	// terminal shows the end, the recorded evidence keeps enough to read it.
	evidenceTail = 30
)

// CheckServers is one look at whatever is running now — nothing started,
// nothing stopped, nothing waited for. What `crew dev check` prints and
// what the worktree page marks its rows with. Nil when nothing runs.
func CheckServers(res *Resolved) []SmokeResult {
	routes, _ := dev.LoadRoutes(res.Slug)
	if len(routes) == 0 {
		return nil
	}
	return waitDevRoutes(res.Slug, routes, 0)
}

// WaitServers is CheckServers with the smoke's patience: `crew dev check
// --wait` right after a start.
func WaitServers(res *Resolved) []SmokeResult {
	routes, _ := dev.LoadRoutes(res.Slug)
	if len(routes) == 0 {
		return nil
	}
	return waitDevRoutes(res.Slug, routes, SmokeCeiling)
}

// waitDevRoutes is waitRoutes over the dev session's windows and logs.
func waitDevRoutes(slug dev.Slug, routes []dev.Route, ceiling time.Duration) []SmokeResult {
	window := func(r dev.Route) string { return string(slug) + "/" + r.ServerName }
	logFor := func(r dev.Route) string { return dev.LogFile(slug, r.ServerName) }
	return waitRoutes(dev.SessionName(slug), routes, window, logFor, ceiling)
}

// waitRoutes polls each route's pane and port until it has a verdict, and
// keeps the log tail for the ones that failed. The session, the window a
// route runs in and where its log is are the caller's — the dev session
// and a setup runner's smoke lay them out differently.
func waitRoutes(session string, routes []dev.Route, window, logFor func(dev.Route) string, ceiling time.Duration) []SmokeResult {
	look := func(r dev.Route) (alive, listening bool) {
		alive = exec.TmuxPaneBusy(session, window(r))
		if alive {
			listening = portOpen(r.InternalPort)
		}
		return alive, listening
	}
	results := waitForServers(routes, referencedServers(), look, smokeTiming{ceiling: ceiling, tick: smokeTick, grace: deadGrace})
	for i, r := range routes {
		if results[i].Failed() {
			results[i].Tail = tailLog(logFor(r), smokeTail)
			results[i].Evidence = tailLog(logFor(r), evidenceTail)
		}
	}
	return results
}

// smokeTiming is the loop's clock: how long a referenced server gets to
// listen, how often to look, and how long a pane not yet seen busy gets
// before "not busy" means "died".
type smokeTiming struct {
	ceiling, tick, grace time.Duration
}

// hasVerdict is the loop's one decision, for one look at one server. A
// port that answers is a verdict, so is a dead pane — unless it was never
// seen busy and the grace is still running, in which case the shell may
// just not have launched the command yet; a server nobody points at is
// done the moment it is alive (there is nothing to wait for). Pure.
func hasVerdict(alive, listening, referenced, seenAlive, withinGrace bool) bool {
	switch {
	case listening:
		return true
	case !alive:
		return seenAlive || !withinGrace
	default:
		return !referenced
	}
}

// waitForServers is the loop: every tick each undecided server is looked
// at again until hasVerdict says so; a referenced one that never listens
// is Unreached at the ceiling. look is the only I/O it does itself; time
// is real. The loop ends when every server has its verdict — a stack that
// comes up in three seconds is judged in three.
func waitForServers(routes []dev.Route, referenced map[string]bool, look func(dev.Route) (alive, listening bool), t smokeTiming) []SmokeResult {
	start := time.Now()
	results := make([]SmokeResult, len(routes))
	decided := make([]bool, len(routes))
	seenAlive := make([]bool, len(routes))
	for i, r := range routes {
		results[i] = SmokeResult{Project: r.Project, Server: r.ServerName, Port: r.InternalPort, Referenced: referenced[dev.PortKey(r.Project, r.ServerName)]}
	}
	for {
		pending := 0
		for i, r := range routes {
			if decided[i] {
				continue
			}
			alive, listening := look(r)
			results[i].Alive, results[i].Listening = alive, listening
			seenAlive[i] = seenAlive[i] || alive
			if hasVerdict(alive, listening, results[i].Referenced, seenAlive[i], time.Since(start) < t.grace) {
				decided[i] = true
				results[i].TookMs = time.Since(start).Milliseconds()
				continue
			}
			pending++
		}
		if pending == 0 || time.Since(start) >= t.ceiling {
			break
		}
		time.Sleep(t.tick)
	}
	for i := range results {
		if !decided[i] {
			results[i].TookMs = time.Since(start).Milliseconds()
		}
	}
	return results
}

// CheckHealth is a check's failures as a health record that is never
// written: the page and crew fix can hand it to Claude the way a recorded
// one is, while a plain start still records nothing.
func CheckHealth(results []SmokeResult) *Health { return healthOf(smokeIssues(results)) }

// tailLog returns the last n non-empty lines of a log, stripped of terminal
// noise, so a failure can be shown without opening the logs view.
func tailLog(path string, n int) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var lines []string
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(stripANSI(line))
		if line == "" || isPromptNoise(line) {
			continue
		}
		lines = append(lines, line)
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// isPromptNoise drops what a tmux pane records around the real output: the
// shell prompt, the command crew typed, and zsh's end-of-line marker.
func isPromptNoise(line string) bool {
	return line == "export" || strings.HasPrefix(line, "export ") ||
		strings.HasPrefix(line, "PORT=") ||
		strings.Contains(line, "➜") ||
		strings.HasPrefix(line, "%")
}

// stripANSI removes CSI sequences (ESC [ … letter) and OSC sequences
// (ESC ] … BEL or ESC \), which is what a captured pane is full of.
func stripANSI(s string) string {
	var out strings.Builder
	rs := []rune(s)
	for i := 0; i < len(rs); i++ {
		if rs[i] != '\x1b' {
			out.WriteRune(rs[i])
			continue
		}
		if i+1 >= len(rs) {
			break
		}
		switch rs[i+1] {
		case '[':
			i += 2
			for i < len(rs) && !((rs[i] >= 'A' && rs[i] <= 'Z') || (rs[i] >= 'a' && rs[i] <= 'z')) {
				i++
			}
		case ']':
			i += 2
			for i < len(rs) && rs[i] != '\x07' && !(rs[i] == '\x1b' && i+1 < len(rs) && rs[i+1] == '\\') {
				i++
			}
			if i < len(rs) && rs[i] == '\x1b' {
				i++
			}
		default:
			i++
		}
	}
	return out.String()
}

// SmokeFailures is the subset that failed (see SmokeResult.Failed).
func SmokeFailures(results []SmokeResult) []SmokeResult {
	var failed []SmokeResult
	for _, r := range results {
		if r.Failed() {
			failed = append(failed, r)
		}
	}
	return failed
}

// SmokeNotes are the idle servers: worth a line, not a failure.
func SmokeNotes(results []SmokeResult) []string {
	var notes []string
	for _, r := range results {
		if r.State() == SmokeIdle {
			notes = append(notes, fmt.Sprintf("%s/%s running, not listening on :%d — nothing points at it", r.Project, r.Server, r.Port))
		}
	}
	return notes
}

// portOpen: does anything accept on loopback:port. A dial, not HTTP — a
// dev server may talk ws or grpc. Both loopbacks: Node 17+ resolves
// localhost to ::1 first, so a server told to bind "localhost" may only be
// on v6.
func portOpen(port int) bool {
	for _, host := range []string{"127.0.0.1", "[::1]"} {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", host, port), 200*time.Millisecond)
		if err == nil {
			conn.Close()
			return true
		}
	}
	return false
}

// referencedServers is every "project/server" some binding in the pool
// points at. A bare {{project}} names its only server. Pure over the pool.
func referencedServers() map[string]bool {
	pool, _ := project.List()
	return referencedIn(pool)
}

func referencedIn(pool []project.Project) map[string]bool {
	byName := map[string]project.Project{}
	for _, p := range pool {
		byName[p.Name] = p
	}
	out := map[string]bool{}
	for _, p := range pool {
		for _, b := range p.Bindings {
			tokens, err := dev.ParseTokens(b.Value)
			if err != nil {
				continue
			}
			for _, tok := range tokens {
				if tok.Kind != dev.TokenTarget {
					continue
				}
				target, ok := byName[tok.Target.Project]
				if !ok {
					continue
				}
				switch {
				case tok.Target.HasServer:
					out[dev.PortKey(target.Name, tok.Target.Server)] = true
				case len(target.DevServers) == 1:
					out[dev.PortKey(target.Name, target.DevServers[0].Name)] = true
				}
			}
		}
	}
	return out
}
