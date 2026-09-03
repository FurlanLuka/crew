package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

func cmdMigrate() {
	dryRun := false
	for _, arg := range os.Args[2:] {
		switch arg {
		case "--dry-run":
			dryRun = true
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\nUsage: crew migrate [--dry-run]\n", arg)
			os.Exit(1)
		}
	}

	plan, err := workspace.PlanMigration()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Print(workspace.FormatPlan(plan))
	if len(plan.Moves) == 0 {
		return
	}

	if len(plan.Conflicts) > 0 {
		fmt.Fprintf(os.Stderr, "\nMigration stopped — resolve the conflicts above first.\n")
		os.Exit(1)
	}

	if dryRun {
		fmt.Printf("\nDry run — nothing was moved. Re-run without --dry-run to apply.\n")
		return
	}

	backup := workspace.BackupDir(time.Now())
	fmt.Printf("\nThis moves git worktrees on disk and rewrites workspace config.\n")
	fmt.Printf("Workspace and route files will be copied to %s first.\n", backup)
	if !confirm("Proceed? [y/N] ") {
		fmt.Println("Cancelled.")
		return
	}

	if err := workspace.ApplyMigration(plan, backup); err != nil {
		fmt.Fprintf(os.Stderr, "\nError: %v\n", err)
		fmt.Fprintf(os.Stderr, "Previous state is in %s. Nothing was deleted.\n", backup)
		os.Exit(1)
	}

	fmt.Printf("\nMigrated %d workspaces.\n", len(plan.Moves))

	// Anything holding an old path breaks — agent memory, CLAUDE.md orientation,
	// shell aliases. Print the mapping so it can be fixed in one pass.
	if pairs := workspace.MigratedPaths(plan); len(pairs) > 0 {
		fmt.Printf("\nPaths that changed — update anything holding them:\n\n")
		for _, pair := range pairs {
			fmt.Printf("  %s\n  → %s\n\n", pair[0], pair[1])
		}
	}
	if venvs := workspace.MovedVenvs(plan); len(venvs) > 0 {
		fmt.Printf("Python venvs relocated (shebangs rewritten, nothing reinstalled):\n\n")
		for _, v := range venvs {
			fmt.Printf("  %s\n", v)
		}
		fmt.Println()
	}
	fmt.Printf("Backup: %s\n", backup)
}

func confirm(prompt string) bool {
	fmt.Print(prompt)
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		return false
	}
	answer := strings.ToLower(strings.TrimSpace(line))
	return answer == "y" || answer == "yes"
}
