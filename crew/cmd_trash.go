package main

import (
	"fmt"
	"os"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/trash"
	"github.com/FurlanLuka/crew/crew/internal/words"
)

// cmdTrash: removed checkouts are cleared in the background; this is where
// to see whether that happened, and the way to force it.
func cmdTrash() {
	if len(os.Args) > 2 && os.Args[2] == "empty" {
		bytes, entries := trash.Size()
		if entries > 0 {
			fmt.Fprintf(human, "Emptying %s — %s in %s, this can take a while…\n", config.TrashDir, app.FormatBytes(bytes), words.CountOf(entries, "entry", "entries"))
		}
		if err := trash.Empty(); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		if jsonOutput {
			printJSON(emptiedDoc{FreedBytes: bytes, Entries: entries})
			return
		}
		fmt.Printf("Emptied %s — %s in %s\n", config.TrashDir, app.FormatBytes(bytes), words.CountOf(entries, "entry", "entries"))
		return
	}
	if len(os.Args) > 2 {
		fmt.Fprintf(os.Stderr, "Usage: crew trash [empty]\n")
		os.Exit(1)
	}

	doc := trashDoc{Path: config.TrashDir}
	doc.Bytes, doc.Entries = trash.Size()
	if jsonOutput {
		printJSON(doc)
		return
	}
	fmt.Println(trashLine(doc))
}

// trashDoc is crew trash --json: what is still clearing.
type trashDoc struct {
	Path    string `json:"path"`
	Bytes   int64  `json:"bytes"`
	Entries int    `json:"entries"`
}

// trashLine is the text form. Pure.
func trashLine(d trashDoc) string {
	if d.Entries == 0 {
		return d.Path + "\tempty"
	}
	return fmt.Sprintf("%s\t%s\t%s\tclearing in background — crew trash empty deletes now", d.Path, app.FormatBytes(d.Bytes), words.CountOf(d.Entries, "entry", "entries"))
}

// emptiedDoc is crew trash empty --json: what the delete freed.
type emptiedDoc struct {
	FreedBytes int64 `json:"freed_bytes"`
	Entries    int   `json:"entries"`
}
