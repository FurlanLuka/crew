package main

import (
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/dirsize"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// mustParseWorktreeRef parses a ref that must name a worktree explicitly, since
// creating or removing one is not something to guess at.
func mustParseWorktreeRef(arg, verb string) workspace.Ref {
	ref, err := workspace.ParseRef(arg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if ref.Worktree == "" {
		fmt.Fprintf(os.Stderr, "Usage: crew %s worktree <workspace>/<name>\n", verb)
		os.Exit(1)
	}
	return ref
}

func cmdAddWorktree() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew add worktree <workspace>/<name> [--pull] [--no-install] [--no-smoke] [--wait]\n")
		os.Exit(1)
	}

	ref := mustParseWorktreeRef(os.Args[3], "add")
	f := parseSetupFlags(os.Args[4:], false)

	ws, err := workspace.Load(ref.Workspace)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: workspace '%s' not found\n", ref.Workspace)
		os.Exit(1)
	}

	printBases(ws, f.pull, fmt.Sprintf("crew add worktree %s --pull fast-forwards the local bases first.", ref))

	if notice := workspace.TrashNotice(); notice != "" {
		fmt.Fprintf(human, "\n  %s\n", notice)
	}
	fmt.Fprintf(human, "\nCreating %s\n", ref)
	if err := workspace.AddWorktree(ref.Workspace, ref.Worktree, f.checkoutOptions()); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	landOn(ref, fmt.Sprintf("Created %s", ref), f.wait)
}

// setupFlags is what every command that starts runners takes.
type setupFlags struct {
	install, smoke, pull, wait bool
	projects                   []string // the filter, where one is allowed
}

func (f setupFlags) checkoutOptions() workspace.CheckoutOptions {
	// No install, nothing to smoke.
	return workspace.CheckoutOptions{Install: f.install, Smoke: f.smoke && f.install}
}

// parseSetupFlags reads --no-install / --no-smoke / --pull / --wait and,
// where allowed, bare project names. Exits on anything else.
func parseSetupFlags(args []string, projects bool) setupFlags {
	f, err := parseSetupArgs(args, projects)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	return f
}

// parseSetupArgs is parseSetupFlags without the exit. Pure.
func parseSetupArgs(args []string, projects bool) (setupFlags, error) {
	f := setupFlags{install: true, smoke: true}
	for _, arg := range args {
		switch {
		case arg == "--no-install":
			f.install = false
		case arg == "--no-smoke":
			f.smoke = false
		case arg == "--pull":
			f.pull = true
		case arg == "--wait":
			f.wait = true
		case strings.HasPrefix(arg, "-"):
			return f, fmt.Errorf("unknown flag '%s'", arg)
		case projects:
			f.projects = append(f.projects, arg)
		default:
			return f, fmt.Errorf("unexpected argument '%s'", arg)
		}
	}
	return f, nil
}

// watchSetup waits for a worktree's runners, redrawing their table every
// second in a terminal and printing it once at the end otherwise, and
// returns the final status.
func watchSetup(ref workspace.Ref) workspace.Status {
	tty := isTerminal() && !jsonOutput
	frames := []string{"⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"}
	drawn, i := 0, 0
	st, err := workspace.WatchSetup(ref, time.Second, func(st workspace.Status) {
		if !tty {
			return
		}
		if drawn > 0 {
			fmt.Fprintf(human, "\033[%dA\033[J", drawn)
		}
		table := workspace.RenderSetupTable(st, frames[i%len(frames)])
		fmt.Fprint(human, table)
		drawn = strings.Count(table, "\n")
		i++
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if !tty {
		fmt.Fprint(human, workspace.RenderSetupTable(st, "…"))
	}
	return st
}

// printBases is the base-branch table every worktree creation opens with:
// pulled first when asked and stale, the stale warning with the way to
// pull otherwise. On the human stream, like all narration.
func printBases(ws *workspace.Workspace, pull bool, pullHint string) {
	statuses := workspace.BaseStatuses(ws)
	if pull && workspace.Stale(statuses) {
		fmt.Fprintf(human, "Pulling latest…\n")
		for _, err := range workspace.UpdateBases(ws, statuses) {
			fmt.Fprintf(os.Stderr, "  ! %v\n", err)
		}
		statuses = workspace.BaseStatuses(ws)
	}
	fmt.Fprintf(human, "Branching from\n\n%s", workspace.FormatBaseStatuses(statuses))
	if warn := workspace.StaleWarning(statuses); warn != "" {
		fmt.Fprintf(human, "\n  %s\n", warn)
		if !pull {
			fmt.Fprintf(human, "  %s\n", pullHint)
		}
	}
}

// landOn is where creation ends. The runners are going; in a terminal the
// worktree page shows them (esc leaves them running). Without one, the
// status line and the way to watch — or, with --wait, the runners watched
// to the end, the summary, and exit 1 while anything is recorded so a
// script can tell.
func landOn(ref workspace.Ref, created string, wait bool) {
	if isTerminal() && !jsonOutput && !wait {
		page := workspace.NewWorktreeView(ref)
		page.SetStatus(created + " — installing")
		runTUI(page)
		return
	}
	res, err := workspace.Resolve(ref)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	projects := projectsOut(res)
	if !wait {
		if jsonOutput {
			printJSON(startedDoc(ref, projects))
			return
		}
		fmt.Print(renderStarted(ref, created, len(res.Projects)))
		return
	}
	reportVerdict(ref, func(st workspace.Status, h *workspace.Health) (map[string]any, string) {
		return finishedDoc(ref, projects, h), renderCreationSummary(res, created, h)
	})
}

// projOut is a project in a creation document.
type projOut struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

func projectsOut(res *workspace.Resolved) []projOut {
	out := make([]projOut, 0, len(res.Projects))
	for _, p := range res.Projects {
		out = append(out, projOut{p.Name, p.Path})
	}
	return out
}

// startedDoc is the --json creation document without --wait: the runners
// are going, no health yet. Pure.
func startedDoc(ref workspace.Ref, projects []projOut) map[string]any {
	return map[string]any{"ref": ref.String(), "running": true, "projects": projects}
}

// finishedDoc is the --wait --json creation document: what was made and
// what is recorded. Pure.
func finishedDoc(ref workspace.Ref, projects []projOut, h *workspace.Health) map[string]any {
	return map[string]any{"ref": ref.String(), "projects": projects, "health": h}
}

// reportVerdict is how every waited-for command ends: the runners watched
// to the end, the worktree's record read fresh (a verify of one project
// leaves the others' record standing), then the document on --json or
// the text — and exit 1 while anything is recorded, so a script can tell.
func reportVerdict(ref workspace.Ref, render func(workspace.Status, *workspace.Health) (doc map[string]any, text string)) {
	st := watchSetup(ref)
	h := recordedHealth(ref)
	doc, text := render(st, h)
	if jsonOutput {
		printJSON(doc)
	} else {
		fmt.Print(text)
	}
	if h != nil {
		os.Exit(1)
	}
}

// renderStarted is the no-terminal, no-wait ending: the runners are going,
// here is how to watch them. Pure.
func renderStarted(ref workspace.Ref, created string, projects int) string {
	return fmt.Sprintf("%s — %d projects installing in the background.\n  crew setup status %s [--wait]   what each runner has done; --wait stays until every one is done\n  crew setup logs %s <project>    what an install is printing\n", created, projects, ref, ref)
}

// renderCreationSummary is the waited-for ending: what was made, every
// issue, and the way out — or the launch line when nothing is recorded.
func renderCreationSummary(res *workspace.Resolved, created string, h *workspace.Health) string {
	var b strings.Builder
	fmt.Fprintf(&b, "\n%s%s\n\n", created, healthSuffix(h))
	for _, p := range res.Projects {
		fmt.Fprintf(&b, "  %s\t%s\n", p.Name, p.Path)
	}
	if h != nil {
		b.WriteString("\n" + renderIssues(h) + fixHint(res.Ref))
		return b.String()
	}
	fmt.Fprintf(&b, "\ncrew launch %s\n", res.Ref)
	return b.String()
}

func healthSuffix(h *workspace.Health) string {
	if h == nil {
		return ""
	}
	return " — " + h.Summary()
}

func printIssues(h *workspace.Health) { fmt.Fprint(human, renderIssues(h)) }

// renderIssues is each issue with its stage and the last few lines of
// evidence, the way the terminal shows it.
func renderIssues(h *workspace.Health) string {
	var b strings.Builder
	for _, issue := range h.Issues {
		fmt.Fprintf(&b, "  ! %-9s %s\n", issue.Stage, issue.Name())
		lines := strings.Split(strings.TrimRight(issue.Detail, "\n"), "\n")
		if len(lines) > 4 {
			lines = lines[len(lines)-4:]
		}
		for _, line := range lines {
			if line != "" {
				fmt.Fprintf(&b, "      %s\n", line)
			}
		}
	}
	return b.String()
}

// cmdSetup is three commands: `crew setup <ref> [<project>…]` re-runs the
// installs (one runner per project), `crew setup status <ref>` shows the
// runners, `crew setup logs <ref> <project>` tails one.
func cmdSetup() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew setup <workspace>[/<worktree>] [<project>…] [--no-smoke] [--wait]\n       crew setup status <workspace>[/<worktree>] [--wait]\n       crew setup logs <workspace>[/<worktree>] <project> [--lines=N]\n")
		os.Exit(1)
	}
	switch os.Args[2] {
	case "status":
		cmdSetupStatus()
		return
	case "logs":
		cmdSetupLogs()
		return
	}
	res := mustResolve(os.Args[2])
	f := parseSetupFlags(os.Args[3:], true)

	fmt.Fprintf(human, "Setting up %s\n", res.Ref)
	err := workspace.Setup(res.Ref, workspace.CheckoutOptions{Install: true, Smoke: f.smoke}, f.projects)
	if errors.Is(err, workspace.ErrServersRunning) {
		fmt.Fprintf(os.Stderr, "Error: %s's servers are running — the smoke would restart them. crew dev stop %s first, or --no-smoke.\n", res.Ref, res.Ref)
		os.Exit(1)
	}
	exitOnRunnerError(err)
	finishRunners(res.Ref, f.wait, "checks out")
}

// exitOnRunnerError turns a refusal to start runners into the exit every
// caller wants.
func exitOnRunnerError(err error) {
	if err == nil {
		return
	}
	fmt.Fprintf(os.Stderr, "Error: %v\n", err)
	os.Exit(1)
}

// finishRunners is how setup and verify end: the status line with the
// runners going, or — with --wait — the table to the end, the issues, and
// exit 1 while anything is recorded.
func finishRunners(ref workspace.Ref, wait bool, passed string) {
	if !wait {
		if jsonOutput {
			printJSON(map[string]any{"ref": ref.String(), "running": true})
			return
		}
		fmt.Printf("Started — one runner per project.\n  crew setup status %s [--wait]\n", ref)
		return
	}
	reportVerdict(ref, func(st workspace.Status, h *workspace.Health) (map[string]any, string) {
		return jsonStatus(st, h), renderVerdict(ref, h, passed)
	})
}

// renderVerdict is the waited-for text of setup and verify: the issues
// and the way out, or the pass line. Pure.
func renderVerdict(ref workspace.Ref, h *workspace.Health, passed string) string {
	if h != nil {
		return "\n" + renderIssues(h) + fixHint(ref)
	}
	return fmt.Sprintf("\n%s %s\n", ref, passed)
}

// recordedHealth reads the worktree's record fresh, after the runners
// wrote it.
func recordedHealth(ref workspace.Ref) *workspace.Health {
	res, err := workspace.Resolve(ref)
	if err != nil {
		return nil
	}
	return res.Health
}

// jsonStatus is the runners' status as data, every list a list — a reader
// should never branch on null.
func jsonStatus(st workspace.Status, h *workspace.Health) map[string]any {
	projects := make([]workspace.ProjectStatus, 0, len(st.Projects))
	for _, p := range st.Projects {
		if p.Steps == nil {
			p.Steps = []workspace.RunStep{}
		}
		if p.Issues == nil {
			p.Issues = []workspace.Issue{}
		}
		projects = append(projects, p)
	}
	return map[string]any{"ref": st.Ref.String(), "running": st.Running(), "failed": st.Failed(), "projects": projects, "health": h}
}

// cmdSetupStatus: what each runner has done. Exit 2 while any is alive,
// 1 once all stopped with a failure, 0 otherwise; --wait stays to the end.
func cmdSetupStatus() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew setup status <workspace>[/<worktree>] [--wait]\n")
		os.Exit(1)
	}
	res := mustResolve(os.Args[3])
	f := parseSetupFlags(os.Args[4:], false)
	var st workspace.Status
	if f.wait {
		st = watchSetup(res.Ref)
	} else {
		var err error
		st, err = workspace.SetupStatus(res.Ref)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
	}
	if jsonOutput {
		printJSON(jsonStatus(st, recordedHealth(res.Ref)))
		os.Exit(st.ExitCode())
	}
	if !f.wait {
		if len(st.Projects) == 0 {
			fmt.Printf("no setup has run on %s\n", res.Ref)
			return
		}
		fmt.Print(workspace.RenderSetupTable(st, "▸"))
	}
	if h := recordedHealth(res.Ref); h != nil && !st.Running() {
		fmt.Println()
		printIssues(h)
		printFixHint(res.Ref)
	}
	os.Exit(st.ExitCode())
}

// cmdSetupLogs tails one runner's log: its steps and what its install
// printed — live while it runs.
func cmdSetupLogs() {
	if len(os.Args) < 5 {
		fmt.Fprintf(os.Stderr, "Usage: crew setup logs <workspace>[/<worktree>] <project> [--lines=N]\n")
		os.Exit(1)
	}
	res := mustResolve(os.Args[3])
	proj := os.Args[4]
	lines := 50
	for _, arg := range os.Args[5:] {
		switch {
		case strings.HasPrefix(arg, "--lines="):
			lines = intFlag("--lines", strings.TrimPrefix(arg, "--lines="), true)
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
			os.Exit(1)
		}
	}
	text, err := workspace.SetupLogs(res.Ref, proj, lines)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: no runner log for %s on %s — crew setup status %s\n", proj, res.Ref, res.Ref)
		os.Exit(1)
	}
	if jsonOutput {
		printJSON(logsDoc(res.Ref, proj, text))
		return
	}
	fmt.Println(text)
}

// logsDoc is `setup logs --json`: the lines as a list, never null. Pure.
func logsDoc(ref workspace.Ref, proj, text string) map[string]any {
	lines := []string{}
	if text != "" {
		lines = strings.Split(text, "\n")
	}
	return map[string]any{"ref": ref.String(), "project": proj, "lines": lines}
}

// printSmokeTails shows the last log lines of each server that died, and
// a note per idle one.
func printSmokeTails(results []workspace.SmokeResult) {
	for _, r := range workspace.SmokeFailures(results) {
		if r.State() == workspace.SmokeUnreached {
			fmt.Fprintf(human, "      running but nothing listens on :%d\n", r.Port)
		}
		for _, line := range strings.Split(r.Tail, "\n") {
			if line != "" {
				fmt.Fprintf(human, "      %s\n", line)
			}
		}
	}
	for _, note := range workspace.SmokeNotes(results) {
		fmt.Fprintf(human, "  · %s\n", note)
	}
}

// printFixHint is the way out of a recorded failure, printed wherever one
// is reported.
func printFixHint(ref workspace.Ref) { fmt.Fprint(human, fixHint(ref)) }

func fixHint(ref workspace.Ref) string {
	return fmt.Sprintf("    crew fix %s     Claude in the worktree with this failure\n    crew verify %s  finish what is missing and check again\n", ref, ref)
}

// printHealthWarning is the CLI's version of the locked page: say what is
// recorded and how to clear it, then carry on — warn, never block.
func printHealthWarning(res *workspace.Resolved) { fmt.Fprint(os.Stderr, healthWarningLine(res)) }

func healthWarningLine(res *workspace.Resolved) string {
	if res.Health == nil {
		return ""
	}
	return fmt.Sprintf("! %s: %s — crew fix %s / crew verify %s\n", res.Ref, res.Health.Summary(), res.Ref, res.Ref)
}

// startVerifyOrExit starts the verify's runners and turns a refusal into
// the exit every caller wants; the running-servers case names the way out.
func startVerifyOrExit(res *workspace.Resolved, only []string) {
	err := workspace.Verify(res, workspace.CheckoutOptions{Install: true, Smoke: true}, only)
	if errors.Is(err, workspace.ErrServersRunning) {
		fmt.Fprintf(os.Stderr, "Error: %s's servers are running — a verify restarts them. crew dev stop %s first.\n", res.Ref, res.Ref)
		os.Exit(1)
	}
	exitOnRunnerError(err)
}

func cmdVerify() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew verify <workspace>[/<worktree>] [<project>…] [--wait]\n")
		os.Exit(1)
	}
	res := mustResolve(os.Args[2])
	f := parseSetupFlags(os.Args[3:], true)
	fmt.Fprintf(human, "Verifying %s\n", res.Ref)
	startVerifyOrExit(res, f.projects)
	finishRunners(res.Ref, f.wait, "checks out — unlocked")
}

// fixAction is what crew fix does first, decided from what is known.
type fixAction int

const (
	fixNothingToCheck fixAction = iota // nothing recorded, no servers: say so
	fixVerifyFirst                     // nothing recorded: verify, then decide
	fixCheckRunning                    // nothing recorded, servers up: check them as they run
	fixNow                             // a failure is recorded: straight to Claude
)

func fixPlan(health *workspace.Health, hasServers, running bool) fixAction {
	switch {
	case health != nil:
		return fixNow
	case running:
		return fixCheckRunning
	case hasServers:
		return fixVerifyFirst
	default:
		return fixNothingToCheck
	}
}

// cmdFix opens Claude on the worktree with the recorded failure in front of
// it. Nothing recorded → verify first, so it is one command either way.
// --print hands the same prompt to whoever is already running — an agent
// fixing it itself needs the evidence, not another Claude.
func cmdFix() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew fix <workspace>[/<worktree>] [--print]\n")
		os.Exit(1)
	}
	printPrompt := false
	for _, arg := range os.Args[3:] {
		switch arg {
		case "--print":
			printPrompt = true
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
			os.Exit(1)
		}
	}
	if !printPrompt && !jsonOutput && !isTerminal() {
		// No terminal means a script or an agent: opening Claude is not an
		// option, the prompt itself is what they need. Same as --print.
		fmt.Fprintf(os.Stderr, "no terminal — printing the fix prompt (crew fix %s --print)\n", os.Args[2])
		printPrompt = true
	}
	if printPrompt {
		// stdout is the prompt and nothing else; a capturing agent must not
		// get the verify narration inside it.
		human = os.Stderr
	}

	res := mustResolve(os.Args[2])
	if jsonOutput {
		// The record as it stands; a check is crew verify --json's job.
		if res.Health == nil {
			fmt.Fprintf(os.Stderr, "nothing recorded on %s — crew verify %s --json checks\n", res.Ref, res.Ref)
			printJSON(workspace.Health{Issues: []workspace.Issue{}})
			return
		}
		printJSON(res.Health)
		return
	}
	health := res.Health
	running := dev.Running(res.Slug)
	switch fixPlan(res.Health, hasServers(res), running) {
	case fixNow:
		// Something recorded and servers up: the record plus what they are
		// doing right now.
		if running {
			health = workspace.MergeHealth(res.Health, workspace.CheckHealth(workspace.CheckServers(res)))
		}
	case fixNothingToCheck:
		fmt.Fprintf(human, "nothing recorded on %s, and no dev servers to check\n", res.Ref)
		return
	case fixCheckRunning:
		// A verify would restart what is running; look at it as it is.
		fmt.Fprintf(human, "Nothing recorded on %s — checking the running servers…\n\n", res.Ref)
		results := workspace.CheckServers(res)
		printSmokeTails(results)
		if health = workspace.CheckHealth(results); health == nil {
			fmt.Fprintf(human, "\nnothing wrong with what is running on %s\n", res.Ref)
			return
		}
		fmt.Fprintln(human)
	case fixVerifyFirst:
		// The fix needs the verdict, so this is the one verify that waits.
		fmt.Fprintf(human, "Nothing recorded on %s — verifying…\n\n", res.Ref)
		startVerifyOrExit(res, nil)
		watchSetup(res.Ref)
		if health = recordedHealth(res.Ref); health == nil {
			fmt.Fprintf(human, "\nnothing recorded — %s checks out\n", res.Ref)
			return
		}
		fmt.Fprintln(human)
	}
	if printPrompt {
		fmt.Print(workspace.RenderFixPrompt(res, health, workspace.FixAnomalies(res)))
		return
	}
	cmd, err := workspace.FixCommandFor(res, health, workspace.FixAnomalies(res))
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if err := os.Chdir(cmd.Dir); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	debug.Log("claude", "fix: exec %s in %s", strings.Join(cmd.Args, " "), cmd.Dir)
	if err := syscall.Exec(cmd.Path, cmd.Args, os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func hasServers(res *workspace.Resolved) bool {
	for _, p := range res.Projects {
		if len(p.DevServers) > 0 {
			return true
		}
	}
	return false
}

func cmdRmWorktree() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew rm worktree <workspace>/<name>\n")
		os.Exit(1)
	}

	ref := mustParseWorktreeRef(os.Args[3], "rm")
	if err := workspace.RemoveWorktree(ref.Workspace, ref.Worktree); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Removed worktree %s\n", ref)
}

func cmdLsWorktrees() {
	var names []string
	args, withSize := extractFlag(os.Args, "--size")
	if len(args) > 3 {
		names = []string{args[3]}
	} else {
		all, err := workspace.List()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		names = all
	}

	type worktreeOut struct {
		Ref        string `json:"ref"`
		Path       string `json:"path"`
		DevRunning bool   `json:"dev_running"`
		// Installing: setup runners are alive on it — crew setup status.
		Installing bool              `json:"installing"`
		SizeBytes  int64             `json:"size_bytes,omitempty"`
		Health     string            `json:"health,omitempty"`
		Issues     []workspace.Issue `json:"issues,omitempty"`
	}

	out := []worktreeOut{}
	for _, wsName := range names {
		ws, err := workspace.Load(wsName)
		if err != nil {
			continue
		}
		for _, ref := range workspace.Refs(ws) {
			row := worktreeOut{
				Ref:        ref.String(),
				Path:       workspace.WorktreeDir(ref),
				DevRunning: dev.Running(ref.Slug()),
				Installing: workspace.SetupRunning(ref),
			}
			if wt, err := workspace.WorktreeOf(ws, ref); err == nil {
				row.Health = wt.Health.Summary()
				if wt.Health != nil {
					row.Issues = wt.Health.Issues
				}
			}
			// A walk; a worktree with a full build inside takes a while.
			if withSize {
				row.SizeBytes = dirsize.Of(row.Path)
			}
			out = append(out, row)
		}
	}

	if jsonOutput {
		printJSON(out)
		return
	}
	for _, wt := range out {
		fmt.Println(worktreeRow(wt.Ref, wt.Path, wt.SizeBytes, withSize, wt.DevRunning, wt.Installing, wt.Health))
	}
}

// worktreeRow is one line of crew ls worktrees: the size column only when
// asked for, then "dev" or "installing", then the recorded failure, so a
// healthy layout without --size is unchanged.
func worktreeRow(ref, path string, sizeBytes int64, withSize, running, installing bool, health string) string {
	cols := []string{ref, path}
	if withSize {
		cols = append(cols, app.FormatBytes(sizeBytes))
	}
	switch {
	case running:
		cols = append(cols, "dev")
	case installing:
		cols = append(cols, "installing")
	default:
		cols = append(cols, "")
	}
	if health != "" {
		cols = append(cols, health)
	}
	return strings.Join(cols, "\t")
}

func cmdAddBinding() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew add binding <project> --var=<VAR> --url=<proj>[/<server>]\n")
		fmt.Fprintf(os.Stderr, "       crew add binding <project> --var=<VAR> --value=<template>\n")
		fmt.Fprintf(os.Stderr, "       crew add binding <project> --scan [--apply]\n")
		os.Exit(1)
	}

	projName := os.Args[3]
	var varName, value, urlTarget, portTarget, hostTarget string
	scan, apply := false, false

	for _, arg := range os.Args[4:] {
		switch {
		case arg == "--scan":
			scan = true
		case arg == "--apply":
			apply = true
		case strings.HasPrefix(arg, "--var="):
			varName = strings.TrimPrefix(arg, "--var=")
		case strings.HasPrefix(arg, "--value="):
			value = strings.TrimPrefix(arg, "--value=")
		case strings.HasPrefix(arg, "--url="):
			urlTarget = strings.TrimPrefix(arg, "--url=")
		case strings.HasPrefix(arg, "--port="):
			portTarget = strings.TrimPrefix(arg, "--port=")
		case strings.HasPrefix(arg, "--host="):
			hostTarget = strings.TrimPrefix(arg, "--host=")
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
			os.Exit(1)
		}
	}

	if scan {
		runBindingScan(projName, apply)
		return
	}

	value, err := bindingValue(urlTarget, hostTarget, portTarget, value)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if varName == "" {
		fmt.Fprintf(os.Stderr, "Error: --var is required\n")
		os.Exit(1)
	}

	if err := project.AddBinding(projName, project.Binding{Var: varName, Value: value}); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Bound %s in %s to %s\n", varName, projName, value)
}

// bindingValue turns the --url/--host/--port shorthands, or --value, into the
// template to store. Exactly one may be given; the shorthands take a bare
// "proj[/server]" and spell the token through dev.TokenFor.
func bindingValue(url, host, port, value string) (string, error) {
	given := 0
	for _, s := range []string{url, host, port, value} {
		if s != "" {
			given++
		}
	}
	if given != 1 {
		return "", fmt.Errorf("give one of --url, --host, --port or --value")
	}
	if value != "" {
		return value, nil
	}
	arg, accessor := url, dev.AccessorURL
	switch {
	case host != "":
		arg, accessor = host, dev.AccessorHost
	case port != "":
		arg, accessor = port, dev.AccessorPort
	}
	target, err := dev.ParseTarget(arg)
	if err != nil {
		return "", fmt.Errorf("--%s=%s: %w", accessor, arg, err)
	}
	return dev.TokenFor(target, accessor), nil
}

func cmdRmBinding() {
	if len(os.Args) < 5 {
		fmt.Fprintf(os.Stderr, "Usage: crew rm binding <project> <var>\n")
		os.Exit(1)
	}

	projName, varName := os.Args[3], os.Args[4]
	if err := project.RemoveBinding(projName, varName); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Removed binding %s from %s\n", varName, projName)
}

func cmdLsBindings() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew ls bindings <project> [--check=<workspace>/<worktree>]\n")
		os.Exit(1)
	}

	projName := os.Args[3]
	checkRef := ""
	for _, arg := range os.Args[4:] {
		switch {
		case strings.HasPrefix(arg, "--check="):
			checkRef = strings.TrimPrefix(arg, "--check=")
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
			os.Exit(1)
		}
	}

	p := project.Get(projName)
	if p == nil {
		fmt.Fprintf(os.Stderr, "Error: project '%s' not found\n", projName)
		os.Exit(1)
	}

	// Without --check the binding is shown as declared; with it, resolved
	// against a real worktree, which is what makes an edge that won't resolve
	// everywhere visible at declaration time instead of at start time.
	resolved := map[string]dev.Resolution{}
	if checkRef != "" {
		_, _, rs := mustResolveProject(checkRef, projName)
		for _, r := range rs {
			resolved[r.Var] = r
		}
	}

	type bindingOut struct {
		Var    string `json:"var"`
		Value  string `json:"value"`
		Result string `json:"result,omitempty"`
	}
	out := []bindingOut{}
	for _, b := range p.Bindings {
		row := bindingOut{Var: b.Var, Value: b.Value}
		if r, ok := resolved[b.Var]; ok {
			row.Result = bindingResult(r)
		}
		out = append(out, row)
	}

	if jsonOutput {
		printJSON(out)
		return
	}
	for _, row := range out {
		if row.Result != "" {
			fmt.Printf("%s\t%s\t%s\n", row.Var, row.Value, row.Result)
			continue
		}
		fmt.Printf("%s\t%s\n", row.Var, row.Value)
	}
}

func bindingResult(r dev.Resolution) string {
	if r.Resolved() {
		return r.Value
	}
	return "left alone — " + r.Detail
}

// runBindingScan reads a project's env files and proposes bindings for the
// values already pointing at ports crew allocates.
//
// This is what a project with no bindings should see first: the work is mostly
// done by the time you look, so setup is confirming what crew found rather
// than declaring six edges by hand.
func runBindingScan(projName string, apply bool) {
	p := project.Get(projName)
	if p == nil {
		fmt.Fprintf(os.Stderr, "Error: project '%s' not found\n", projName)
		os.Exit(1)
	}

	dirs := project.CheckoutDirs(projName)
	proposals := dev.ProposeBindings(project.ScanEnv(projName), project.ConfiguredPorts())

	declared := map[string]bool{}
	for _, b := range p.Bindings {
		declared[b.Var] = true
	}

	// One row per proposal, decided before anything prints, so the JSON and
	// text forms cannot drift.
	type scanRow struct {
		Var      string `json:"var"`
		Value    string `json:"value"`
		Port     int    `json:"port,omitempty"`
		Template string `json:"template,omitempty"`
		Status   string `json:"status"` // already bound | ambiguous | proposed | added | failed
		Detail   string `json:"detail,omitempty"`
	}
	rows := make([]scanRow, 0, len(proposals))
	applied := 0
	for _, prop := range proposals {
		row := scanRow{Var: prop.Var, Value: prop.Value, Port: prop.Port, Template: prop.Template}
		switch {
		case declared[prop.Var]:
			row.Status = "already bound"
		case prop.Ambiguous:
			row.Status, row.Detail = "ambiguous", fmt.Sprintf("two projects configured on :%d — pick one by hand", prop.Port)
		case apply:
			if err := project.AddBinding(projName, project.Binding{Var: prop.Var, Value: prop.Template}); err != nil {
				row.Status, row.Detail = "failed", err.Error()
			} else {
				row.Status = "added"
				applied++
			}
		default:
			row.Status = "proposed"
		}
		rows = append(rows, row)
	}

	if jsonOutput {
		printJSON(rows)
		return
	}
	if len(rows) == 0 {
		fmt.Printf("Scanned %d checkouts of %s — nothing in their env files points at a port crew allocates.\n", len(dirs), projName)
		return
	}
	fmt.Printf("Scanned %d checkouts of %s\n\n", len(dirs), projName)
	for _, r := range rows {
		switch r.Status {
		case "already bound":
			fmt.Printf("  · %-22s %-24s already bound\n", r.Var, r.Value)
		case "ambiguous":
			fmt.Printf("  ? %-22s %-24s %s\n", r.Var, r.Value, r.Detail)
		case "failed":
			fmt.Printf("  ! %-22s %s\n", r.Var, r.Detail)
		default:
			fmt.Printf("  ✓ %-22s %-24s → %s\n", r.Var, r.Value, r.Template)
		}
	}

	if apply {
		fmt.Printf("\nAdded %d bindings to %s.\n", applied, projName)
		return
	}
	fmt.Printf("\nRe-run with --apply to add these, or use the TUI to pick individually.\n")
}

// Overrides are the top precedence rung; a worktree pins a variable and the
// binding is ignored there. `crew add override` is also the acknowledgement
// for a binding that legitimately never resolves in one worktree — it stops
// printing as an anomaly on every start.
func cmdAddOverride() {
	if len(os.Args) < 5 {
		fmt.Fprintf(os.Stderr, "Usage: crew add override <workspace>/<worktree> <VAR>=<value>\n")
		fmt.Fprintf(os.Stderr, "       crew add override <workspace>/<worktree> <project>.<VAR>=<value>\n")
		os.Exit(1)
	}

	res := mustResolve(os.Args[3])
	key, value, found := strings.Cut(os.Args[4], "=")
	if !found || key == "" {
		fmt.Fprintf(os.Stderr, "Error: expected <VAR>=<value>, got '%s'\n", os.Args[4])
		os.Exit(1)
	}

	if err := workspace.SetOverride(res.Ref, key, value); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Override %s in %s\n", key, res.Ref)
}

func cmdRmOverride() {
	if len(os.Args) < 5 {
		fmt.Fprintf(os.Stderr, "Usage: crew rm override <workspace>/<worktree> <VAR>\n")
		os.Exit(1)
	}

	res := mustResolve(os.Args[3])
	if _, ok := res.Overrides[os.Args[4]]; !ok {
		fmt.Fprintf(os.Stderr, "Error: %s has no override for %s\n", res.Ref, os.Args[4])
		os.Exit(1)
	}
	if err := workspace.ClearOverride(res.Ref, os.Args[4]); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Removed override %s from %s\n", os.Args[4], res.Ref)
}

func cmdLsOverrides() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew ls overrides <workspace>/<worktree>\n")
		os.Exit(1)
	}

	res := mustResolve(os.Args[3])
	if jsonOutput {
		printJSON(res.Overrides)
		return
	}
	keys := make([]string, 0, len(res.Overrides))
	for k := range res.Overrides {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Printf("%s\t%s\n", k, res.Overrides[k])
	}
}
