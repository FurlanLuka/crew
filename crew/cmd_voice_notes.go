package main

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/voice"
)

// crew voice debug-notes [show <n>] and crew voice notes: what the developer
// said to Voice OS, read on the main (a remote reaches them through relayToMain).

func mustDebugNotes() []voice.DebugNote {
	notes, err := voice.ReadDebugNotes()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	return notes
}

func listDebugNotes(q logsQuery) {
	notes := voice.Newest(voice.FilterDebugNotes(mustDebugNotes(), q.filter), q.lines)
	rows := make([]voice.DebugNoteRow, 0, len(notes))
	for _, note := range notes {
		rows = append(rows, note.Row())
	}
	if jsonOutput {
		printJSON(map[string]any{"notes": rows})
		return
	}
	for _, r := range rows {
		fmt.Printf("%d\t%s\t%s\t%s\n", r.N, r.At, r.View, voice.OneLine(r.Text))
	}
}

func showDebugNote(q logsQuery) {
	note, err := voice.FindDebugNote(mustDebugNotes(), q.note)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	at, err := time.Parse(time.RFC3339Nano, note.At)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: debug note %d has no readable time (%q)\n", q.note, note.At)
		os.Exit(1)
	}
	window := voice.LogFilter{Since: at.Add(-q.around), Until: at.Add(q.around)}
	read, err := voice.ReadLog(voice.RotatedFiles(voice.LogFile()), window, 0, voice.MainMachine)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if warning := read.RotatedOut(window.Since); warning != "" {
		fmt.Fprintf(os.Stderr, "! %s\n", warning)
	}
	if jsonOutput {
		printJSON(map[string]any{"note": note, "lines": read.Lines})
		return
	}
	fmt.Print(renderDebugNote(note))
	fmt.Printf("\nlog %s … %s:\n", voice.FormatWhen(window.Since), voice.FormatWhen(window.Until))
	for _, line := range read.Lines {
		fmt.Println(voice.FormatLogRow(line))
	}
}

// renderDebugNote is show's human form: the note, then what was around it. Pure.
func renderDebugNote(n voice.DebugNote) string {
	var b strings.Builder
	fmt.Fprintf(&b, "debug note %d\t%s\t%s\n", n.N, n.At, n.View)
	fmt.Fprintf(&b, "note: %s\n", voice.OneLine(n.Text))
	if n.Said != nil {
		fmt.Fprintf(&b, "said: %s\n", voice.OneLine(*n.Said))
	}
	if len(n.HeardHere) > 0 {
		b.WriteString("heard here:\n")
		for _, h := range n.HeardHere {
			fmt.Fprintf(&b, "  %s\t%q\tdid %s\treply %q\n", h.At, h.Utterance, strings.Join(h.Did, ", "), h.Reply)
		}
	}
	if len(n.Sessions) > 0 {
		b.WriteString("sessions:\n")
		for _, s := range n.Sessions {
			fmt.Fprintf(&b, "  %s\t%s\tqueued %d", s.Ref, s.Status, s.Queued)
			if s.NeedsUser != nil {
				fmt.Fprintf(&b, "\tneeds %q", *s.NeedsUser)
			}
			if s.LastAsked != nil {
				fmt.Fprintf(&b, "\tlast asked %q", *s.LastAsked)
			}
			b.WriteString("\n")
		}
	}
	if len(n.Asks) > 0 {
		b.WriteString("asks:\n")
		for _, a := range n.Asks {
			fmt.Fprintf(&b, "  %s\t%s\n", a.Ref, a.Kind)
		}
	}
	if len(n.Spoken) > 0 {
		b.WriteString("spoken:\n")
		for _, s := range n.Spoken {
			fmt.Fprintf(&b, "  %s\t%s\t%q\n", s.At, s.Source, s.Text)
		}
	}
	if n.DevOffer != nil {
		fmt.Fprintf(&b, "dev offer: %s\n", *n.DevOffer)
	}
	return b.String()
}

func listNotes(q logsQuery) {
	var keys []string
	if !q.all {
		keys = []string{voice.ToNotesKey(q.workspace)}
	}
	byKey, order, err := voice.ReadNotes(keys)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	notes := []voice.Note{}
	for _, key := range order {
		// --lines counts per workspace: --all is one list per workspace, as Voice OS reads them.
		notes = append(notes, voice.Newest(voice.FilterNotes(byKey[key], q.filter, time.Local), q.lines)...)
	}
	if jsonOutput {
		printJSON(map[string]any{"notes": notes})
		return
	}
	if len(notes) == 0 && !q.all && q.filter.Grep == "" && q.filter.Since.IsZero() {
		fmt.Fprintf(os.Stderr, "No notes for %s yet.\n", voice.NameNotes(keys[0]))
	}
	for _, n := range notes {
		fmt.Printf("%s\t%s\t%s\n", n.Workspace, n.At, n.Text)
	}
}
