package main

import (
	"fmt"
	"os"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/uninstall"
)

func cmdUninstall() {
	purge := false
	for _, arg := range os.Args[2:] {
		switch arg {
		case "--purge":
			purge = true
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\nUsage: crew uninstall [--purge]\n", arg)
			os.Exit(1)
		}
	}

	bin, _ := os.Executable()
	fmt.Printf("This stops every dev server and removes %s.\n", bin)
	if purge {
		fmt.Printf("--purge also removes every workspace's checkouts and %s. Uncommitted work in them is lost.\n", config.ConfigDir)
	} else {
		fmt.Printf("%s and its worktree checkouts are kept. Add --purge to remove them too.\n", config.ConfigDir)
	}
	if !confirm("Proceed? [y/N] ") {
		fmt.Println("Cancelled.")
		return
	}

	report, err := uninstall.Run(purge)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Removed %s\n", report.Binary)
	for _, ws := range report.Workspaces {
		fmt.Printf("Removed workspace %s\n", ws)
	}
	if report.Kept != "" {
		fmt.Printf("Kept %s\n", report.Kept)
	}
}
