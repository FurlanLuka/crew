package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// cmdScanCheckouts is crew add project --scan: the checkouts this machine
// already has, for a first run to pick from. Listed, never added.
func cmdScanCheckouts() {
	home, err := os.UserHomeDir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	pool, err := project.List()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	rows := project.ScanCheckouts(os.DirFS(home), home, config.ConfigDir, pool)
	if jsonOutput {
		printJSON(rows)
		return
	}
	for _, r := range rows {
		fmt.Println(checkoutLine(r))
	}
	if len(rows) == 0 {
		fmt.Fprintf(human, "no checkouts under ~/%s\n", strings.Join(project.ScanRoots, ", ~/"))
	}
}

// checkoutLine is one row: name, path, remote or "-", known or new. Pure.
func checkoutLine(c project.Checkout) string {
	remote, state := c.Remote, "new"
	if remote == "" {
		remote = "-"
	}
	if c.Known {
		state = "known"
	}
	return c.Name + "\t" + c.Path + "\t" + remote + "\t" + state
}
