package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/words"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

func cmdMigrate() {
	dryRun, yes := false, false
	for _, arg := range os.Args[2:] {
		switch arg {
		case "--dry-run":
			dryRun = true
		case "--yes":
			yes = true
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\nUsage: crew migrate [--dry-run] [--yes]\n", arg)
			os.Exit(1)
		}
	}

	plan, err := workspace.PlanMigration()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	if jsonOutput && dryRun {
		// crew's page reads the moves; the plan text is narration, on stderr under --json.
		fmt.Fprint(human, workspace.FormatPlan(plan))
		printJSON(migrationRows(plan))
		if len(plan.Conflicts) > 0 {
			os.Exit(1)
		}
		return
	}

	// Under --json the narration is on stderr and stdout carries one
	// document: how many workspaces moved.
	fmt.Fprint(human, workspace.FormatPlan(plan))
	if len(plan.Moves) == 0 {
		printMigrated(0)
		return
	}

	if len(plan.Conflicts) > 0 {
		fmt.Fprintf(os.Stderr, "\nMigration stopped — resolve the conflicts above first.\n")
		os.Exit(1)
	}

	if dryRun {
		fmt.Fprintf(human, "\nDry run — nothing was moved. Re-run without --dry-run to apply.\n")
		return
	}

	backup := workspace.BackupDir(time.Now())
	fmt.Fprintf(human, "\nThis moves git worktrees on disk and rewrites workspace config.\n")
	fmt.Fprintf(human, "Workspace and route files will be copied to %s first.\n", backup)
	if !yes && !confirm("Proceed? [y/N] ") {
		fmt.Fprintln(human, "Cancelled.")
		printMigrated(0)
		return
	}

	if err := workspace.ApplyMigration(plan, backup); err != nil {
		fmt.Fprintf(os.Stderr, "\nError: %v\n", err)
		fmt.Fprintf(os.Stderr, "Previous state is in %s. Nothing was deleted.\n", backup)
		os.Exit(1)
	}

	fmt.Fprintf(human, "\nMigrated %s.\n", words.Count(len(plan.Moves), "workspace"))

	// Anything holding an old path breaks — agent memory, CLAUDE.md orientation,
	// shell aliases. Print the mapping so it can be fixed in one pass.
	if pairs := workspace.MigratedPaths(plan); len(pairs) > 0 {
		fmt.Fprintf(human, "\nPaths that changed — update anything holding them:\n\n")
		for _, pair := range pairs {
			fmt.Fprintf(human, "  %s\n  → %s\n\n", pair[0], pair[1])
		}
	}
	if venvs := workspace.MovedVenvs(plan); len(venvs) > 0 {
		fmt.Fprintf(human, "Python venvs relocated (shebangs rewritten, nothing reinstalled):\n\n")
		for _, v := range venvs {
			fmt.Fprintf(human, "  %s\n", v)
		}
		fmt.Fprintln(human)
	}
	fmt.Fprintf(human, "Backup: %s\n", backup)
	printMigrated(len(plan.Moves))
}

// printMigrated is crew migrate --json's document; nothing in text mode,
// where the narration already said it.
func printMigrated(n int) {
	if jsonOutput {
		printJSON(migratedDoc(n))
	}
}

// migratedDoc is crew migrate --json: how many workspaces moved. Pure.
func migratedDoc(n int) map[string]int {
	return map[string]int{"migrated": n}
}

func confirm(prompt string) bool {
	fmt.Fprint(human, prompt)
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		return false
	}
	answer := strings.ToLower(strings.TrimSpace(line))
	return answer == "y" || answer == "yes"
}

// migrationRow is one move of `crew migrate --dry-run --json`.
type migrationRow struct {
	Workspace string `json:"workspace"`
	Ref       string `json:"ref"`
}

// migrationRows is the plan's moves as rows, [] when there are none. Pure.
func migrationRows(plan *workspace.MigrationPlan) []migrationRow {
	rows := make([]migrationRow, 0, len(plan.Moves))
	for _, m := range plan.Moves {
		rows = append(rows, migrationRow{Workspace: m.OldWorkspace, Ref: m.Ref.String()})
	}
	return rows
}
