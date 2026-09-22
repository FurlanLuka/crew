package main

import (
	"fmt"
	"os"

	"github.com/FurlanLuka/crew/crew/internal/housekeeping"
)

// cmdClean: the sweep every start runs hourly, now, plus a git worktree
// prune on every pool repo — the one thing kept off the start path.
func cmdClean() {
	args, dryRun := extractFlag(os.Args[2:], "--dry-run")
	if len(args) > 0 {
		fmt.Fprintf(os.Stderr, "Usage: crew clean [--dry-run]\n")
		os.Exit(1)
	}
	actions := housekeeping.Sweep(housekeeping.Options{DryRun: dryRun, Prune: true})
	if jsonOutput {
		if actions == nil {
			actions = []housekeeping.Action{}
		}
		printJSON(actions)
		return
	}
	fmt.Print(housekeeping.RenderReport(actions, dryRun))
}
