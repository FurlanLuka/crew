package workspace

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	osexec "os/exec"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/dev"
)

// Health is what the last check found wrong on a worktree. Absent means the
// last check passed. Only an explicit check — crew verify, or crew setup with
// its smoke — writes or clears it; a plain dev start never does, since "still
// up after six seconds" is evidence enough to record a death, not to erase
// one by luck.
type Health struct {
	At     time.Time `json:"at"`
	Issues []Issue   `json:"issues"`
}

// Issue is one thing that failed, at the stage of creation it belongs to:
// a checkout that git refused, an install step, a server that died.
type Issue struct {
	Stage   string `json:"stage"`
	Project string `json:"project"`
	Server  string `json:"server,omitempty"`
	// Reason tells two smoke failures apart: the process is gone, or it
	// runs but never bound its port (ReasonDied, ReasonNotListening).
	Reason string `json:"reason,omitempty"`
	Detail string `json:"detail"`
}

const (
	StageCheckout = "checkout"
	StageInstall  = "install"
	StageSmoke    = "smoke"
)

const (
	ReasonDied         = "died"
	ReasonNotListening = "not listening"
)

// UnmarshalJSON reads the shape an unreleased build wrote — one stage at the
// top, none on the issues — and puts the stage where it lives now.
func (h *Health) UnmarshalJSON(data []byte) error {
	var raw struct {
		Stage  string    `json:"stage"`
		At     time.Time `json:"at"`
		Issues []Issue   `json:"issues"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	h.At, h.Issues = raw.At, raw.Issues
	for i := range h.Issues {
		if h.Issues[i].Stage == "" {
			h.Issues[i].Stage = raw.Stage
		}
	}
	return nil
}

// ErrServersRunning: a verify restarts the worktree's session, which would
// interrupt real work. The caller stops first, or asks.
var ErrServersRunning = errors.New("servers are running")

// Summary is the one-line form for a list column.
func (h *Health) Summary() string {
	if h == nil || len(h.Issues) == 0 {
		return ""
	}
	if len(h.Issues) > 1 {
		return fmt.Sprintf("%d issues", len(h.Issues))
	}
	return h.Issues[0].Summary()
}

// Summary is one issue as a list would say it.
func (i Issue) Summary() string {
	switch i.Stage {
	case StageCheckout:
		return "checkout failed: " + i.Project
	case StageInstall:
		return "install failed: " + i.Project
	case StageSmoke:
		if i.Server == "" {
			return "servers could not start"
		}
		if i.Reason == ReasonNotListening {
			return "server not listening: " + i.Project + "/" + i.Server
		}
		return "server died: " + i.Project + "/" + i.Server
	}
	return i.Stage + " failed: " + i.Project
}

// Name is "project" or "project/server".
func (i Issue) Name() string {
	if i.Server != "" {
		return i.Project + "/" + i.Server
	}
	return i.Project
}

// failedCheckouts names the projects whose checkout is recorded as failed
// — the directories that are not there.
func (r *Resolved) failedCheckouts() map[string]bool {
	out := map[string]bool{}
	if r.Health == nil {
		return out
	}
	for _, i := range r.Health.Issues {
		if i.Stage == StageCheckout {
			out[i.Project] = true
		}
	}
	return out
}

// installIssues names the projects with a recorded install failure, which a
// verify installs again.
func (h *Health) installIssues() map[string]bool {
	out := map[string]bool{}
	if h == nil {
		return out
	}
	for _, i := range h.Issues {
		if i.Stage == StageInstall {
			out[i.Project] = true
		}
	}
	return out
}

// without is h minus one project's issues; nil once nothing is left.
func (h *Health) without(project string) *Health {
	if h == nil {
		return nil
	}
	var kept []Issue
	for _, i := range h.Issues {
		if i.Project != project {
			kept = append(kept, i)
		}
	}
	if len(kept) == 0 {
		return nil
	}
	return &Health{At: h.At, Issues: kept}
}

// MergeHealth is the recorded health plus what a check of the running
// servers found about servers the record does not already cover — crew fix
// with servers up should describe both.
func MergeHealth(recorded, check *Health) *Health {
	if check == nil {
		return recorded
	}
	if recorded == nil {
		return check
	}
	seen := map[string]bool{}
	for _, i := range recorded.Issues {
		seen[i.Name()] = true
	}
	merged := &Health{At: recorded.At, Issues: append([]Issue(nil), recorded.Issues...)}
	for _, i := range check.Issues {
		if !seen[i.Name()] {
			merged.Issues = append(merged.Issues, i)
		}
	}
	return merged
}

func healthOf(issues []Issue) *Health {
	if len(issues) == 0 {
		return nil
	}
	return &Health{At: time.Now(), Issues: issues}
}

// smokeIssues turns the failed servers into issues.
func smokeIssues(results []SmokeResult) []Issue {
	var issues []Issue
	for _, r := range SmokeFailures(results) {
		issue := Issue{Stage: StageSmoke, Project: r.Project, Server: r.Server, Reason: ReasonDied, Detail: r.Evidence}
		if r.State() == SmokeUnreached {
			// True for a smoke and for a look at running servers alike.
			issue.Reason = ReasonNotListening
			issue.Detail = fmt.Sprintf("running but nothing listens on :%d\n%s", r.Port, r.Evidence)
		}
		issues = append(issues, issue)
	}
	return issues
}

// RecordHealth writes h on the worktree; nil clears it.
func RecordHealth(ref Ref, h *Health) error {
	return updateWorktree(ref, func(wt *Worktree) { wt.Health = h })
}

func ClearHealth(ref Ref) error { return RecordHealth(ref, nil) }

// Verify finishes what a worktree is missing, then checks it, one runner
// per project: a project with no checkout is checked out and installed, one
// with a recorded install failure is installed again, and every project's
// servers are smoked — started, watched until each listens, dies or the
// ceiling passes, stopped. Each runner writes or clears its project's
// verdict. With names, only those projects — re-verify the one you fixed.
// Refuses while the worktree's servers are running (a smoke would restart
// them under whoever is using them) or while a runner is already on it.
func Verify(res *Resolved, opts CheckoutOptions, only []string) error {
	if dev.Running(res.Slug) {
		return ErrServersRunning
	}
	ws, err := loadFor(res.Ref)
	if err != nil {
		return err
	}
	names, err := chosenMembers(ws, only)
	if err != nil {
		return err
	}
	return StartSetup(res.Ref, verifyJobs(names, missingCheckouts(res.Ref, ws), res.Health.installIssues(), opts.Install))
}

// verifyJobs is what a verify runs per project: an install only where the
// checkout is missing or its last install failed, the smoke everywhere.
// Pure.
func verifyJobs(names []string, missing, installFailed map[string]bool, install bool) []ProjectJob {
	jobs := make([]ProjectJob, 0, len(names))
	for _, n := range names {
		jobs = append(jobs, ProjectJob{Project: n, Install: install && (missing[n] || installFailed[n]), Smoke: true})
	}
	return jobs
}

// RenderFixPrompt is what crew fix opens Claude with: the orientation prompt,
// then the failure with its evidence verbatim, then what to do about it.
// Pure over its inputs.
func RenderFixPrompt(res *Resolved, h *Health, anomalies string) string {
	var b strings.Builder
	b.WriteString(RenderPrompt(res, directBranches(res)))
	b.WriteString("\n## What failed\n\n")
	b.WriteString("What crew found wrong on this worktree — at creation, on a verify, or looking at the servers as they run:\n\n")
	for _, issue := range h.Issues {
		fmt.Fprintf(&b, "%s — %s:\n", issue.Name(), stageWords(issue))
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
	fmt.Fprintf(&b, "Fix the cause in this checkout — .env, an override (crew add override %s VAR=value), code, or git — then run: crew verify %s\n", res.Ref, res.Ref)
	b.WriteString("verify checks out anything still missing, re-runs the installs that failed, starts the servers and records what it finds; the worktree page stays locked until it passes.\n")
	return b.String()
}

func stageWords(i Issue) string {
	switch i.Stage {
	case StageCheckout:
		return "the git checkout failed"
	case StageInstall:
		return "the install failed"
	case StageSmoke:
		if i.Server == "" {
			return "the servers could not be started"
		}
		if i.Reason == ReasonNotListening {
			return "the server kept running but never listened on its port — something points at that port (does its command bind $PORT?)"
		}
		return "the server died within seconds of starting"
	}
	return i.Stage + " failed"
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
	return FixCommandFor(res, res.Health, anomalies)
}

// FixCommandFor is FixCommand over any health — the recorded one, or what
// a check of the running servers just found.
func FixCommandFor(res *Resolved, h *Health, anomalies string) (*osexec.Cmd, error) {
	if h == nil {
		return nil, fmt.Errorf("nothing recorded on %s — crew verify %s first", res.Ref, res.Ref)
	}
	text := RenderFixPrompt(res, h, anomalies)
	return claudeCommand(res, func() (string, error) {
		return text, os.WriteFile(PromptFilePath(res.Ref), []byte(text), 0o644)
	})
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}
