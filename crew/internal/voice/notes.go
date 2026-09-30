package voice

import (
	"regexp"
	"strings"
	"time"
)

// The developer's own notes, one Markdown file per workspace on the main
// (voiceos/src/memory/notes.ts): the key rule and the line format, pure.

// GeneralNotes is the key of the notes that belong to no workspace
// (voiceos/src/shared/notes.ts GENERAL_NOTES).
const GeneralNotes = "(general)"

// jsSpace is JavaScript's \s: Go's \s is ASCII only, and the key must match Voice OS's.
const jsSpace = `\s\x{0B}\p{Zs}\x{FEFF}\x{2028}\x{2029}`

var (
	notesSpace  = regexp.MustCompile(`[` + jsSpace + `]+`)
	notesUnsafe = regexp.MustCompile(`[^a-z0-9._-]+`)
	notesTrim   = regexp.MustCompile(`^[` + jsSpace + `]+|[` + jsSpace + `]+$`)
)

// ToNotesKey is voiceos/src/shared/notes.ts toNotesKey, one spelling for a
// workspace however it is named; the shared table notes-keys.json pins both. Pure.
func ToNotesKey(name string) string {
	if name == GeneralNotes {
		return name
	}
	key := strings.ToLower(notesTrim.ReplaceAllString(name, ""))
	key = notesUnsafe.ReplaceAllString(notesSpace.ReplaceAllString(key, "-"), "-")
	if key == "" {
		return GeneralNotes
	}
	return key
}

func NotesFileName(key string) string {
	if key == GeneralNotes {
		return "_general.md"
	}
	return key + ".md"
}

func notesKeyOf(fileName string) (string, bool) {
	if !strings.HasSuffix(fileName, ".md") {
		return "", false
	}
	if fileName == "_general.md" {
		return GeneralNotes, true
	}
	return strings.TrimSuffix(fileName, ".md"), true
}

// NameNotes is how a key is shown: the general notes as "general". Pure.
func NameNotes(key string) string {
	if key == GeneralNotes {
		return "general"
	}
	return key
}

// Note is one of the developer's notes. At is the local "YYYY-MM-DD HH:MM" it was said.
type Note struct {
	Workspace string `json:"workspace"`
	At        string `json:"at"`
	Text      string `json:"text"`
}

var noteStamp = regexp.MustCompile(`^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) — (.*)$`)

// ParseNotes reads a notes file (voiceos/src/memory/notes.ts formatNoteLine). Pure.
func ParseNotes(key string, data []byte) []Note {
	notes := []Note{}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "- ") {
			continue
		}
		note := Note{Workspace: NameNotes(key), Text: strings.TrimPrefix(line, "- ")}
		if m := noteStamp.FindStringSubmatch(line); m != nil {
			note.At, note.Text = m[1], m[2]
		}
		notes = append(notes, note)
	}
	return notes
}

// FilterNotes keeps notes said since f.Since whose text holds grep; a note's
// time is the local clock of the main that wrote it. An unstamped note has no
// time and passes no --since. Pure.
func FilterNotes(notes []Note, f LogFilter, loc *time.Location) []Note {
	kept := []Note{}
	grep := strings.ToLower(f.Grep)
	for _, note := range notes {
		if !f.Since.IsZero() {
			at, err := time.ParseInLocation("2006-01-02 15:04", note.At, loc)
			if err != nil || at.Before(f.Since.Truncate(time.Minute)) {
				continue
			}
		}
		if grep != "" && !strings.Contains(strings.ToLower(note.Text), grep) {
			continue
		}
		kept = append(kept, note)
	}
	return kept
}
