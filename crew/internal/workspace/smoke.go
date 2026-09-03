package workspace

import (
	"os"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
)

// SmokeResult is one server's fate a few seconds after start.
type SmokeResult struct {
	Project string
	Server  string
	Alive   bool
	Tail    string // last log lines, for a server that died
}

const (
	smokeSettle = 6 * time.Second
	smokeTail   = 4
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

	session := dev.SessionName(res.Slug)
	var results []SmokeResult
	for _, r := range result.Routes {
		window := string(res.Slug) + "/" + r.ServerName
		sr := SmokeResult{Project: r.Project, Server: r.ServerName}
		sr.Alive = exec.TmuxPaneBusy(session, window)
		if !sr.Alive {
			sr.Tail = tailLog(dev.LogFile(res.Slug, r.ServerName), smokeTail)
		}
		results = append(results, sr)
	}

	dev.StopAll(res.Slug)
	return results, nil
}

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
	return strings.HasPrefix(line, "export ") ||
		strings.HasPrefix(line, "PORT=") ||
		strings.Contains(line, "export SPEAK") ||
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

// SmokeFailures is the subset that died.
func SmokeFailures(results []SmokeResult) []SmokeResult {
	var failed []SmokeResult
	for _, r := range results {
		if !r.Alive {
			failed = append(failed, r)
		}
	}
	return failed
}
