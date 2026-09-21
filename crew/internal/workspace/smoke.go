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

const (
	smokeSettle = 6 * time.Second
	smokeTail   = 4
	// A stack trace usually sits above the one line that says why; the
	// terminal shows the end, the recorded evidence keeps enough to read it.
	evidenceTail = 30
)

// SmokeStart starts a worktree's servers, waits for them to settle, reports
// which are still running, and stops everything again.
//
// Crew cannot judge "healthy" — a server that binds and then serves errors
// looks fine from here. What it can read honestly is "died within seconds",
// which is exactly the shape of a broken checkout: bad interpreter, missing
// module, no .env. Servers are stopped afterwards because creating a worktree
// should not leave things running as a side effect; the page is one keystroke
// away for that.
func SmokeStart(res *Resolved) ([]SmokeResult, error) {
	result, err := StartDev(res, true, false)
	if err != nil {
		return nil, err
	}
	time.Sleep(smokeSettle)
	results := inspectRoutes(res.Slug, result.Routes)
	dev.StopAll(res.Slug)
	return results, nil
}

// CheckServers is the smoke's look at whatever is running now — nothing
// started, nothing stopped. What `crew dev check` prints and what the
// worktree page marks its rows with. Nil when nothing runs.
func CheckServers(res *Resolved) []SmokeResult {
	routes, _ := dev.LoadRoutes(res.Slug)
	if len(routes) == 0 {
		return nil
	}
	return inspectRoutes(res.Slug, routes)
}

// inspectRoutes reads each route's pane and port, and keeps the log tail
// for the ones that failed.
func inspectRoutes(slug dev.Slug, routes []dev.Route) []SmokeResult {
	session := dev.SessionName(slug)
	referenced := referencedServers()
	var results []SmokeResult
	for _, r := range routes {
		window := string(slug) + "/" + r.ServerName
		sr := SmokeResult{Project: r.Project, Server: r.ServerName, Port: r.InternalPort, Referenced: referenced[dev.PortKey(r.Project, r.ServerName)]}
		sr.Alive = exec.TmuxPaneBusy(session, window)
		if sr.Alive {
			sr.Listening = portOpen(r.InternalPort)
		}
		if sr.Failed() {
			sr.Tail = tailLog(dev.LogFile(slug, r.ServerName), smokeTail)
			sr.Evidence = tailLog(dev.LogFile(slug, r.ServerName), evidenceTail)
		}
		results = append(results, sr)
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
