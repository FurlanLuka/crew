package voice

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/debug"
)

// afterOpen runs between opening a log's files and reading them: tests rotate there.
var afterOpen = func() {}

// LogRead is what one log's files gave.
type LogRead struct {
	Lines []LogLine
	// KeptFrom is the time of the oldest line still kept, "" when an older file
	// was left out by its mtime (the log reaches further back than asked) or
	// when there is no log at all.
	KeptFrom string
	Files    int
}

// RotatedOut says when the log no longer reaches back to start. Pure.
func (r LogRead) RotatedOut(start time.Time) string {
	switch {
	case r.Files == 0:
		return "no Voice OS log on this machine"
	case r.KeptFrom != "" && start.UTC().Format(isoMillis) < r.KeptFrom:
		return fmt.Sprintf("the log before %s has rotated out; showing what is kept", r.KeptFrom)
	}
	return ""
}

// ReadLog reads one log and its rotations (files newest first, as
// RotatedFiles) and keeps the newest n matching lines, oldest first (n <= 0:
// all). Every file is opened before any is read: a rotation mid-query renames
// files under open handles, so no line is skipped or read twice.
func ReadLog(files []string, f LogFilter, n int, machine string) (LogRead, error) {
	var opened []*os.File
	defer func() {
		for _, file := range opened {
			file.Close()
		}
	}()
	var read LogRead
	skippedOlder := false
	for _, path := range files {
		file, err := os.Open(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return read, err
		}
		read.Files++
		// A file last written before the window holds nothing in it.
		if info, err := file.Stat(); err == nil && !f.Since.IsZero() && info.ModTime().Before(f.Since) {
			file.Close()
			skippedOlder = true
			continue
		}
		opened = append(opened, file)
	}
	afterOpen()

	m := f.matcher()
	lines := []LogLine{}
	for i := len(opened) - 1; i >= 0; i-- {
		oldest, err := scanLog(opened[i], m, func(line LogLine) {
			line.Machine = machine
			lines = append(lines, line)
			// Keeps memory to about 2n on a big log.
			if n > 0 && len(lines) >= 2*n {
				lines = append(lines[:0], lines[len(lines)-n:]...)
			}
		})
		if err != nil {
			return read, err
		}
		if i == len(opened)-1 && !skippedOlder {
			read.KeptFrom = oldest
		}
	}
	read.Lines = Newest(lines, n)
	return read, nil
}

// scanLog goes forward through one file and returns the time of its first
// line. A malformed line is skipped, and so is a last line with no newline:
// Voice OS may be halfway through writing it.
func scanLog(file *os.File, m lineMatcher, keep func(LogLine)) (string, error) {
	reader := bufio.NewReaderSize(file, 1<<20)
	first := ""
	for {
		raw, err := reader.ReadBytes('\n')
		if errors.Is(err, io.EOF) {
			return first, nil
		}
		if err != nil {
			return first, err
		}
		raw = raw[:len(raw)-1]
		if first == "" {
			if ts, ok := leadingTS(raw); ok {
				first = ts
			}
		}
		if line, ok := m.match(raw); ok {
			keep(line)
		}
	}
}

// LocalLogs is this machine's Voice OS logs, the main's and the remote
// daemon's (a machine may have been both), labelled machine.
func LocalLogs(f LogFilter, n int, machine string) ([]LogLine, error) {
	var groups [][]LogLine
	for _, base := range []string{LogFile(), RemoteLogFile()} {
		debug.Log("voice", "read %s (+%d rotated)", base, keptLogs)
		read, err := ReadLog(RotatedFiles(base), f, n, machine)
		if err != nil {
			return nil, err
		}
		groups = append(groups, read.Lines)
	}
	return Newest(MergeByTime(groups...), n), nil
}

// ReadDebugNotes is every debug note on this machine; none is not an error.
func ReadDebugNotes() ([]DebugNote, error) {
	data, err := os.ReadFile(DebugNotesFile())
	if errors.Is(err, os.ErrNotExist) {
		return []DebugNote{}, nil
	}
	if err != nil {
		return nil, err
	}
	return ParseDebugNotes(data), nil
}

// ReadNotes is the notes of the given keys, or of every workspace with notes
// when keys is nil, in key order.
func ReadNotes(keys []string) (map[string][]Note, []string, error) {
	if keys == nil {
		entries, err := os.ReadDir(NotesDir())
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, nil, err
		}
		keys = []string{}
		for _, e := range entries {
			if key, ok := notesKeyOf(e.Name()); ok && !e.IsDir() {
				keys = append(keys, key)
			}
		}
		sort.Strings(keys)
	}
	byKey := map[string][]Note{}
	for _, key := range keys {
		data, err := os.ReadFile(filepath.Join(NotesDir(), NotesFileName(key)))
		if errors.Is(err, os.ErrNotExist) {
			byKey[key] = []Note{}
			continue
		}
		if err != nil {
			return nil, nil, err
		}
		byKey[key] = ParseNotes(key, data)
	}
	return byKey, keys, nil
}
