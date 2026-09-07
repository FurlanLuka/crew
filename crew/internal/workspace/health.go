package workspace

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	osexec "os/exec"
	"sort"
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
	Detail  string `json:"detail"`
}

const (
	StageCheckout = "checkout"
	StageInstall  = "install"
	StageSmoke    = "smoke"
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

// missingCheckouts names the projects whose checkout is recorded as failed
// — the directories that are not there.
func (r *Resolved) missingCheckouts() map[string]bool {
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

// healthOf is nil when nothing failed.
func healthOf(issues []Issue) *Health {
	if len(issues) == 0 {
		return nil
	}
	return &Health{At: time.Now(), Issues: issues}
}

// smokeIssues turns the dead servers into issues.
func smokeIssues(results []SmokeResult) []Issue {
	var issues []Issue
	for _, r := range SmokeFailures(results) {
		issues = append(issues, Issue{Stage: StageSmoke, Project: r.Project, Server: r.Server, Detail: r.Evidence})
	}
	return issues
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

// VerifyResult is what a check found: the smoke, and the issues recorded
// afterwards (nil when everything passed).
type VerifyResult struct {
	Smoke  []SmokeResult
	Health *Health
}

// Verify finishes what a worktree is missing, then checks it: a project with
// no checkout is checked out, one with a recorded install failure (or a
// checkout just made) is installed, then the servers are started, watched
// for a few seconds, and stopped again. The verdict is written or cleared.
// On a verified worktree that is the smoke alone. Refuses while the
// worktree's servers are running — a smoke start would restart them under
// whoever is using them.
func Verify(res *Resolved, opts CheckoutOptions) (VerifyResult, error) {
	if dev.Running(res.Slug) {
		return VerifyResult{}, ErrServersRunning
	}
	ws, err := Load(res.Ref.Workspace)
	if err != nil {
		return VerifyResult{}, err
	}

	var missing []string
	for _, wp := range ws.Projects {
		if !IsDirect(wp) && !dirExists(WorktreePath(res.Ref, wp.Name)) {
			missing = append(missing, wp.Name)
		}
	}
	made, issues := checkoutProjects(res.Ref, ws, missing, opts.Progress)

	toInstall := res.Health.installIssues()
	for _, name := range made {
		toInstall[name] = true
	}
	if opts.Install {
		issues = append(issues, installProjects(res.Ref, ws, sortedKeys(toInstall), opts)...)
	}

	opts.Smoke = true
	result, err := finishCheck(res.Ref, issues, opts)
	res.Health = result.Health
	return result, err
}

// RenderFixPrompt is what crew fix opens Claude with: the orientation prompt,
// then the failure with its evidence verbatim, then what to do about it.
// Pure over its inputs.
func RenderFixPrompt(res *Resolved, h *Health, anomalies string) string {
	var b strings.Builder
	b.WriteString(RenderPrompt(res, directBranches(res)))
	b.WriteString("\n## What failed\n\n")
	b.WriteString("Creating this worktree ran every step it could; these did not go through:\n\n")
	for _, issue := range h.Issues {
		fmt.Fprintf(&b, "%s — %s:\n", issue.Name(), stageWords(issue.Stage))
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

func stageWords(stage string) string {
	switch stage {
	case StageCheckout:
		return "the git checkout failed"
	case StageInstall:
		return "the install failed"
	case StageSmoke:
		return "the server died within seconds of starting"
	}
	return stage + " failed"
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

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func sortedKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
