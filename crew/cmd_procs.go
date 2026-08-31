package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/procs"
)

// cmdPs lists what crew is currently responsible for, one row per line so the
// output pipes like the other list commands.
func cmdPs() {
	// --json is stripped from os.Args at startup and exposed as jsonOutput,
	// the same way the other list commands consume it.
	for _, arg := range os.Args[2:] {
		fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
		os.Exit(1)
	}

	inv, err := procs.Collect()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	if jsonOutput {
		inv.JSONSlices()
		printJSON(inv)
		return
	}

	for _, s := range inv.Sessions {
		for _, p := range s.Procs {
			fmt.Printf("session\t%d\t%s\t%s\n", p.PID, s.Name, p.Command)
		}
	}
	for _, o := range inv.Orphans {
		fmt.Printf("orphan\t%d\t%s\t%s\n", o.PID, o.CWD, o.Command)
	}
	for _, a := range inv.Attached {
		fmt.Printf("attached\t%d\t%s\t%s\n", a.PID, a.CWD, a.Command)
	}

	if inv.ScanNote != "" {
		fmt.Fprintf(os.Stderr, "%s\n", inv.ScanNote)
	}
	fmt.Fprintf(os.Stderr, "%s\n", procs.Summary(inv))
}

// cmdKill stops crew's sessions and reclaims the processes that leaked out of
// them. No confirmation prompt — destructive CLI commands in crew don't ask
// (see `crew rm`) — but --dry-run shows the targets without touching them.
func cmdKill() {
	dryRun := false
	for _, arg := range os.Args[2:] {
		switch arg {
		case "--dry-run", "-n":
			dryRun = true
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
			os.Exit(1)
		}
	}

	inv, err := procs.Collect()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	targets, err := procs.Killable(inv)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	if inv.ScanNote != "" {
		fmt.Fprintf(os.Stderr, "%s\n\n", inv.ScanNote)
	}

	if len(inv.Sessions) == 0 && len(targets) == 0 {
		fmt.Println("Nothing to reclaim.")
		fmt.Println(procs.Summary(inv))
		return
	}

	for _, s := range inv.Sessions {
		fmt.Printf("session  %s (%d processes)\n", s.Name, len(s.Procs))
	}
	for _, o := range inv.Orphans {
		fmt.Printf("orphan   %d  %s\n", o.PID, truncate(o.Command, 70))
	}
	if len(inv.Attached) > 0 {
		fmt.Printf("\n%d process(es) in the workspace tree still have a live parent and are left alone.\n",
			len(inv.Attached))
	}

	if dryRun {
		fmt.Println("\n--dry-run: nothing was killed.")
		return
	}

	report, err := procs.Reclaim(inv)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("\nStopped %d session(s), reclaimed %d process(es).\n",
		len(report.Sessions), len(report.Killed))

	if len(report.Restore) > 0 {
		fmt.Println("\nRestore with:")
		for _, cmd := range report.Restore {
			fmt.Printf("  %s\n", cmd)
		}
	}
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}
