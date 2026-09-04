package main

import (
	"fmt"
	"os"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/trash"
)

// cmdTrash: removed checkouts are cleared in the background; this is where
// to see whether that happened, and the way to force it.
func cmdTrash() {
	if len(os.Args) > 2 && os.Args[2] == "empty" {
		bytes, entries := trash.Size()
		if err := trash.Empty(); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		if jsonOutput {
			printJSON(map[string]any{"freed_bytes": bytes, "entries": entries})
			return
		}
		fmt.Printf("Emptied %s — %s in %d entries\n", config.TrashDir, app.FormatBytes(bytes), entries)
		return
	}
	if len(os.Args) > 2 {
		fmt.Fprintf(os.Stderr, "Usage: crew trash [empty]\n")
		os.Exit(1)
	}

	bytes, entries := trash.Size()
	if jsonOutput {
		printJSON(map[string]any{"path": config.TrashDir, "bytes": bytes, "entries": entries})
		return
	}
	if entries == 0 {
		fmt.Printf("%s\tempty\n", config.TrashDir)
		return
	}
	fmt.Printf("%s\t%s\t%d entries\tclearing in background — crew trash empty deletes now\n", config.TrashDir, app.FormatBytes(bytes), entries)
}
