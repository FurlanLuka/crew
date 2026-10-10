package main

import (
	"fmt"
	"os"

	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// whichOutput is `crew which <path> --json`.
type whichOutput struct {
	Ref     string `json:"ref"`
	Root    string `json:"root"`
	Project string `json:"project"`
}

// cmdWhich maps a folder to the worktree that owns it — how the crew pane
// in a Claude session knows where it is when nothing set CREW_REF.
func cmdWhich() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew which <path>\n")
		os.Exit(1)
	}
	owner, ok, err := workspace.WhichPath(os.Args[2])
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if !ok {
		fmt.Fprintf(os.Stderr, "%s is not in a crew worktree\n", os.Args[2])
		os.Exit(1)
	}
	if jsonOutput {
		printJSON(whichOutput{Ref: owner.Ref.String(), Root: workspace.WorktreeDir(owner.Ref), Project: owner.Project})
		return
	}
	proj := owner.Project
	if proj == "" {
		proj = "-"
	}
	fmt.Printf("%s\t%s\n", owner.Ref, proj)
}
