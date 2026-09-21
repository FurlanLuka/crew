package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// cmdSetupRunner is `crew _setup <ref> <project> [--no-install] [--no-smoke]`:
// one project's pipeline, run in a window of the worktree's setup session.
// Not a command anyone types — StartSetup spawns it — so it is out of the
// help and the skill. The signal trap is the reason it exists as its own
// process: a killed window (tmux kill-window, rm worktree, a reboot's
// HUP) ends with the interruption recorded, never a clean row.
func cmdSetupRunner() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew _setup <workspace>/<worktree> <project> [--no-install] [--no-smoke]\n")
		os.Exit(1)
	}
	ref, err := workspace.ParseRef(os.Args[2])
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	job := workspace.ProjectJob{Project: os.Args[3], Install: true, Smoke: true}
	for _, arg := range os.Args[4:] {
		switch arg {
		case "--no-install":
			job.Install = false
		case "--no-smoke":
			job.Smoke = false
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
			os.Exit(1)
		}
	}

	runner, err := workspace.NewRunner(ref, job)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGHUP, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		sig := <-signals
		debug.Log("setup", "%s/%s: runner got %s", ref, job.Project, sig)
		runner.Abort(sig.String())
		os.Exit(1)
	}()
	if err := runner.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
