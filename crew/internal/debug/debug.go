package debug

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

func logPath() string {
	return filepath.Join(config.ConfigDir, "debug.log")
}

const maxLogSize = 1 << 20 // 1 MB

// Log appends a timestamped line to the debug log file.
// Truncates the file to the last half when it exceeds 1 MB.
func Log(category, format string, args ...any) {
	path := logPath()
	truncateIfNeeded(path)

	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()

	ts := time.Now().Format("2006-01-02 15:04:05")
	msg := fmt.Sprintf(format, args...)
	fmt.Fprintf(f, "%s [%s] %s\n", ts, category, msg)
}

func truncateIfNeeded(path string) {
	info, err := os.Stat(path)
	if err != nil || info.Size() <= maxLogSize {
		return
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return
	}

	// Keep the last half, starting at the next newline boundary
	half := data[len(data)/2:]
	if idx := bytes.IndexByte(half, '\n'); idx >= 0 {
		half = half[idx+1:]
	}

	os.WriteFile(path, half, 0o644)
}

// DefaultTail is how much of the log a reader gets when they did not say.
const DefaultTail = 200

// ReadTail returns the last n lines from the debug log file.
func ReadTail(n int) string {
	return strings.Join(TailLines(n), "\n")
}

// TailLines is the last n lines of the log, oldest first.
func TailLines(n int) []string {
	f, err := os.Open(logPath())
	if err != nil {
		return nil
	}
	defer f.Close()

	var lines []string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines
}

// Entry is one log line as data: what Log wrote, split back apart.
type Entry struct {
	At       string `json:"at"`
	Category string `json:"category"`
	Message  string `json:"message"`
}

// ParseLines turns log lines into entries. A line that is not in Log's
// shape (a continuation, a truncation marker) keeps its text as the message
// with no time or category. Pure.
func ParseLines(lines []string) []Entry {
	entries := make([]Entry, 0, len(lines)) // never nil: --json prints [] on a fresh install
	for _, l := range lines {
		entries = append(entries, parseLine(l))
	}
	return entries
}

func parseLine(l string) Entry {
	// "2006-01-02 15:04:05 [category] message"
	if len(l) > 20 && l[10] == ' ' && l[19] == ' ' && strings.HasPrefix(l[20:], "[") {
		rest := l[21:]
		if end := strings.Index(rest, "] "); end > 0 {
			return Entry{At: l[:19], Category: rest[:end], Message: rest[end+2:]}
		}
	}
	return Entry{Message: l}
}
