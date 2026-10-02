package main

import (
	"fmt"
	"os"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// printRemovalCost is a removal's --dry-run: nothing removed, every checkout
// it would take and what is in it.
func printRemovalCost(cost workspace.RemovalCost, err error) {
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if jsonOutput {
		printJSON(cost)
		return
	}
	for _, c := range cost.Checkouts {
		fmt.Println(costLine(c))
	}
	if cost.Last {
		fmt.Fprintln(human, "the last worktree goes only with its workspace — crew rm <workspace>")
	}
}

// costLine is one checkout: ref, project, path, then what goes with it —
// always the six columns of the output format; a checkout that loses
// nothing says why in the fourth and "-" in the rest. Pure.
func costLine(c workspace.CheckoutCost) string {
	what := fmt.Sprintf("%d uncommitted\t%d commits not on the base\t%s", c.Uncommitted, c.Commits, app.FormatBytes(c.SizeBytes))
	switch {
	case c.Direct:
		what = "direct — the canonical checkout is kept\t-\t-"
	case c.Missing:
		what = "no checkout on disk\t-\t-"
	}
	return c.Ref + "\t" + c.Project + "\t" + c.Path + "\t" + what
}
