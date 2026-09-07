package workspace

import (
	"errors"
	"fmt"
	"os"
	osexec "os/exec"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
)

// Health is the last failure a check found on a worktree. Absent means the
// last check passed. Only an explicit check — crew verify, or crew setup with
// its smoke — writes or clears it; a plain dev start never does, since "still
// up after six seconds" is evidence enough to record a death, not to erase
// one by luck.
type Health struct {
	Stage  string    `json:"stage"` // StageInstall or StageSmoke
	At     time.Time `json:"at"`
	Issues []Issue   `json:"issues"`
}

// Issue is one thing that failed: an install for a project, or a server
// that died.
type Issue struct {
	Project string `json:"project"`
	Server  string `json:"server,omitempty"`
	Detail  string `json:"detail"`
}

const (
	StageInstall = "install"
	StageSmoke   = "smoke"
)

// ErrServersRunning: a verify restarts the worktree's session, which would
// interrupt real work. The caller stops first, or asks.
var ErrServersRunning = errors.New("servers are running")

// Summary is the one-line form for a list column.
func (h *Health) Summary() string {
	if h == nil {
		return ""
	}
	switch h.Stage {
	case StageInstall:
		return "install failed"
	case StageSmoke:
		if len(h.Issues) == 1 {
			return "server died: " + h.Issues[0].Project + "/" + h.Issues[0].Server
		}
		return fmt.Sprintf("%d servers died", len(h.Issues))
	}
	return h.Stage + " failed"
}

// HealthFromSetup turns a failed install into the recorded state.
func HealthFromSetup(err *SetupError) *Health {
	h := &Health{Stage: StageInstall, At: time.Now()}
	for _, e := range err.Errors {
		issue := Issue{Detail: e.Error()}
		var pe *ProjectSetupError
		if errors.As(e, &pe) {
			issue.Project, issue.Detail = pe.Project, pe.Err.Error()
		}
		// The step's full tail is the evidence; the message is the terminal's cut.
		var se *exec.StepError
		if errors.As(e, &se) && se.Output != "" {
			issue.Detail = se.Step + ":\n" + se.Output
		}
		h.Issues = append(h.Issues, issue)
	}
	return h
}

// HealthFromSmoke is nil when every server survived.
func HealthFromSmoke(results []SmokeResult) *Health {
	failed := SmokeFailures(results)
	if len(failed) == 0 {
		return nil
	}
	h := &Health{Stage: StageSmoke, At: time.Now()}
	for _, r := range failed {
		h.Issues = append(h.Issues, Issue{Project: r.Project, Server: r.Server, Detail: r.Evidence})
	}
	return h
}

// RecordHealth writes h on the worktree; nil clears it. Its own load and
// save, the way SavePorts works: the caller may have held a workspace across
// a minutes-long install, and saving that snapshot would drop what any
// sibling wrote meanwhile.
func RecordHealth(ref Ref, h *Health) error {
	ws, err := Load(ref.Workspace)
	if err != nil {
		return err
	}
	wt, err := selectWorktree(ws, ref.Worktree)
	if err != nil {
		return err
	}
	for i := range ws.Worktrees {
		if ws.Worktrees[i].Name == wt.Name {
			ws.Worktrees[i].Health = h
			return Save(ws)
		}
	}
	return fmt.Errorf("workspace '%s' has no worktree '%s'", ref.Workspace, ref.Worktree)
}

func ClearHealth(ref Ref) error { return RecordHealth(ref, nil) }

// Verify is the smoke start with its verdict remembered: servers up, a few
// seconds, which survived, everything stopped again; the worktree's Health
// is written or cleared accordingly. Refuses while the worktree's servers
// are running — a smoke start would restart them under whoever is using
// them.
func Verify(res *Resolved) ([]SmokeResult, error) {
	if dev.Running(res.Slug) {
		return nil, ErrServersRunning
	}
	results, err := SmokeStart(res)
	if err != nil {
		return nil, err
	}
	h := HealthFromSmoke(results)
	if err := RecordHealth(res.Ref, h); err != nil {
		return results, err
	}
	res.Health = h
	return results, nil
}

// RenderFixPrompt is what crew fix opens Claude with: the orientation prompt,
// then the failure with its evidence verbatim, then what to do about it.
// Pure over its inputs.
func RenderFixPrompt(res *Resolved, h *Health, anomalies string) string {
	var b strings.Builder
	b.WriteString(RenderPrompt(res, directBranches(res)))
	b.WriteString("\n## What failed\n\n")
	switch h.Stage {
	case StageInstall:
		b.WriteString("Stage: install — a project's dependencies did not install.\n\n")
	case StageSmoke:
		b.WriteString("Stage: smoke — a server died within seconds of starting.\n\n")
	default:
		fmt.Fprintf(&b, "Stage: %s.\n\n", h.Stage)
	}
	for _, issue := range h.Issues {
		name := issue.Project
		if issue.Server != "" {
			name += "/" + issue.Server
		}
		if name == "" {
			name = "(unknown)"
		}
		fmt.Fprintf(&b, "%s:\n", name)
		for _, line := range strings.Split(strings.TrimRight(issue.Detail, "\n"), "\n") {
			b.WriteString("    " + line + "\n")
		}
		b.WriteString("\n")
	}
	if strings.TrimSpace(anomalies) != "" {
		b.WriteString("Env anomalies for this worktree (bindings crew could not resolve — a plain var missing from .env shows in the log above, not here):\n")
		for _, line := range strings.Split(strings.TrimRight(anomalies, "\n"), "\n") {
			b.WriteString("    " + strings.TrimSpace(line) + "\n")
		}
		b.WriteString("\n")
	}
	fmt.Fprintf(&b, "Fix the cause in this checkout — .env, an override (crew add override %s VAR=value), or code — then run: crew verify %s\n", res.Ref, res.Ref)
	if h.Stage == StageInstall {
		fmt.Fprintf(&b, "The install stage failed, so crew setup %s is the re-run once the cause is fixed.\n", res.Ref)
	} else {
		fmt.Fprintf(&b, "Do not run crew setup %s unless dependencies are actually missing.\n", res.Ref)
	}
	return b.String()
}

// FixAnomalies is what the fix prompt says about bindings: resolved against
// the running servers when there are any, else against the worktree's
// reserved ports — what the next start will use.
func FixAnomalies(res *Resolved) string {
	routes, _ := dev.LoadRoutes(res.Slug)
	ports := dev.IndexRoutePorts(routes)
	if len(ports) == 0 {
		ports = dev.IndexReservedPorts(res.Ports)
	}
	return strings.TrimSpace(dev.FormatAnomalies(dev.ResolveBindings(res.ResolveParams(ports))))
}

// FixCommand is ClaudeCommand with the fix prompt, always passed: the
// orientation prompt's project-count gate does not apply to a failure.
func FixCommand(res *Resolved, anomalies string) (*osexec.Cmd, error) {
	if res.Health == nil {
		return nil, fmt.Errorf("nothing recorded on %s — crew verify %s first", res.Ref, res.Ref)
	}
	text := RenderFixPrompt(res, res.Health, anomalies)
	return claudeCommand(res, func() (string, error) {
		return text, os.WriteFile(PromptFilePath(res.Ref), []byte(text), 0o644)
	})
}
