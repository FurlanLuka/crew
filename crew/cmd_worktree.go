package main

import (
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
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
		fmt.Fprintf(os.Stderr, "Usage: crew add worktree <workspace>/<name> [--no-install] [--no-smoke]\n")
		os.Exit(1)
	}

	ref := mustParseWorktreeRef(os.Args[3], "add")
	install, smoke := parseCheckoutFlags(os.Args[4:])

	ws, err := workspace.Load(ref.Workspace)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: workspace '%s' not found\n", ref.Workspace)
		os.Exit(1)
	}

	statuses := workspace.BaseStatuses(ws)
	fmt.Printf("Branching from\n\n%s", workspace.FormatBaseStatuses(statuses))
	if warn := workspace.StaleWarning(statuses); warn != "" {
		fmt.Printf("\n  %s\n", warn)
	}

	fmt.Printf("\nCreating %s\n\n", ref)
	opts := workspace.CheckoutOptions{Install: install, Progress: printSetupProgress}
	err = workspace.AddWorktree(ref.Workspace, ref.Worktree, opts)
	var setupErr *workspace.SetupError
	if errors.As(err, &setupErr) {
		fmt.Fprintf(os.Stderr, "\n! %v\n", err)
		fmt.Fprintf(os.Stderr, "  The worktree exists. Fix the step, then: crew setup %s\n", ref)
		fmt.Fprintf(os.Stderr, "  Or set an explicit install command: crew add project <name> <path> --setup=<cmd>\n")
		smoke = false
	} else if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	res, err := workspace.Resolve(ref)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	if smoke && install {
		runSmoke(res)
	}

	fmt.Printf("\nWorktree %s\n\n", ref)
	for _, p := range res.Projects {
		fmt.Printf("  %s\t%s\n", p.Name, p.Path)
	}
	fmt.Printf("\ncrew launch %s\n", ref)
}

func cmdSetup() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew setup <workspace>[/<worktree>] [--no-smoke]\n")
		os.Exit(1)
	}
	res := mustResolve(os.Args[2])
	_, smoke := parseCheckoutFlags(os.Args[3:])

	fmt.Printf("Setting up %s\n\n", res.Ref)
	err := workspace.Setup(res.Ref, workspace.CheckoutOptions{Install: true, Progress: printSetupProgress})
	if err != nil {
		fmt.Fprintf(os.Stderr, "\n! %v\n", err)
		os.Exit(1)
	}
	if smoke {
		runSmoke(res)
	}
}

// parseCheckoutFlags reads --no-install / --no-smoke. Exits on anything else.
func parseCheckoutFlags(args []string) (install, smoke bool) {
	install, smoke = true, true
	for _, arg := range args {
		switch arg {
		case "--no-install":
			install = false
		case "--no-smoke":
			smoke = false
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
			os.Exit(1)
		}
	}
	return install, smoke
}

// printSetupProgress is one line per finished install step.
func printSetupProgress(project string, r exec.SetupResult) {
	mark := "✓"
	if r.Err != nil {
		mark = "✗"
	}
	fmt.Printf("  %-16s %s %-14s %s\n", project, mark, r.Step.Name, r.Duration.Round(time.Second))
}

// runSmoke starts the servers, reports which survived a few seconds, and
// stops them again. Failures print their last log lines; nothing blocks.
func runSmoke(res *workspace.Resolved) {
	if !hasServers(res) {
		return
	}
	fmt.Printf("\nSmoke-starting dev servers (%s)…\n\n", "stopped again afterwards")

	results, err := workspace.SmokeStart(res)
	if err != nil {
		fmt.Fprintf(os.Stderr, "  could not start: %v\n", err)
		return
	}
	for _, r := range results {
		if r.Alive {
			fmt.Printf("  %-16s ✓ %s\n", r.Project, r.Server)
			continue
		}
		fmt.Printf("  %-16s ✗ %s exited within seconds\n", r.Project, r.Server)
		for _, line := range strings.Split(r.Tail, "\n") {
			if line != "" {
				fmt.Printf("      %s\n", line)
			}
		}
	}
	if failed := workspace.SmokeFailures(results); len(failed) > 0 {
		fmt.Printf("\n  ! %d server(s) died on start — check dependencies and env in the new checkout. crew dev logs %s <server> has the full output.\n", len(failed), res.Ref)
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
	if len(os.Args) > 3 {
		names = []string{os.Args[3]}
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
	}

	out := []worktreeOut{}
	for _, wsName := range names {
		ws, err := workspace.Load(wsName)
		if err != nil {
			continue
		}
		for _, ref := range workspace.Refs(ws) {
			out = append(out, worktreeOut{
				Ref:        ref.String(),
				Path:       workspace.WorktreeDir(ref),
				DevRunning: dev.Running(ref.Slug()),
			})
		}
	}

	if jsonOutput {
		printJSON(out)
		return
	}
	for _, wt := range out {
		running := ""
		if wt.DevRunning {
			running = "dev"
		}
		fmt.Printf("%s\t%s\t%s\n", wt.Ref, wt.Path, running)
	}
}

func cmdAddBinding() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew add binding <project> --var=<VAR> --url=<proj>[/<server>]\n")
		fmt.Fprintf(os.Stderr, "       crew add binding <project> --var=<VAR> --value=<template>\n")
		fmt.Fprintf(os.Stderr, "       crew add binding <project> --scan [--apply]\n")
		os.Exit(1)
	}

	projName := os.Args[3]
	var varName, value, urlTarget, portTarget string
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
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
			os.Exit(1)
		}
	}

	if scan {
		runBindingScan(projName, apply)
		return
	}

	switch {
	case urlTarget != "":
		value = "{{url:" + urlTarget + "}}"
	case portTarget != "":
		value = "{{port:" + portTarget + "}}"
	}

	if varName == "" || value == "" {
		fmt.Fprintf(os.Stderr, "Error: --var and one of --url/--port/--value are required\n")
		os.Exit(1)
	}

	if err := project.AddBinding(projName, project.Binding{Var: varName, Value: value}); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Bound %s in %s to %s\n", varName, projName, value)
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
	if len(proposals) == 0 {
		fmt.Printf("Scanned %d checkouts of %s — nothing in their env files points at a port crew allocates.\n", len(dirs), projName)
		return
	}

	declared := map[string]bool{}
	for _, b := range p.Bindings {
		declared[b.Var] = true
	}

	fmt.Printf("Scanned %d checkouts of %s\n\n", len(dirs), projName)
	applied := 0
	for _, prop := range proposals {
		switch {
		case declared[prop.Var]:
			fmt.Printf("  · %-22s %-24s already bound\n", prop.Var, prop.Value)
		case prop.Ambiguous:
			fmt.Printf("  ? %-22s %-24s two projects configured on :%d — pick one by hand\n",
				prop.Var, prop.Value, prop.Port)
		default:
			if apply {
				if err := project.AddBinding(projName, project.Binding{Var: prop.Var, Value: prop.Template}); err != nil {
					fmt.Printf("  ! %-22s %s\n", prop.Var, err)
					continue
				}
				applied++
			}
			fmt.Printf("  ✓ %-22s %-24s → %s\n", prop.Var, prop.Value, prop.Template)
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
