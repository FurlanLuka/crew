package debug

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

func setupTempLog(t *testing.T) {
	t.Helper()
	tmp := t.TempDir()
	config.ConfigDir = tmp
}

func TestLog_CreatesFile(t *testing.T) {
	setupTempLog(t)

	Log("test", "hello %s", "world")

	data, err := os.ReadFile(logPath())
	if err != nil {
		t.Fatalf("log file not created: %v", err)
	}

	content := string(data)
	if !strings.Contains(content, "[test] hello world") {
		t.Errorf("log content = %q, want to contain %q", content, "[test] hello world")
	}
}

func TestLog_AppendsMultipleLines(t *testing.T) {
	setupTempLog(t)

	Log("git", "worktree add /tmp/wt")
	Log("tmux", "new-session -d -s crew-ws")
	Log("editor", "cursor /tmp/ws.code-workspace")

	data, err := os.ReadFile(logPath())
	if err != nil {
		t.Fatal(err)
	}

	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 3 {
		t.Fatalf("got %d lines, want 3", len(lines))
	}

	if !strings.Contains(lines[0], "[git]") {
		t.Errorf("line 0 = %q, want [git] category", lines[0])
	}
	if !strings.Contains(lines[1], "[tmux]") {
		t.Errorf("line 1 = %q, want [tmux] category", lines[1])
	}
	if !strings.Contains(lines[2], "[editor]") {
		t.Errorf("line 2 = %q, want [editor] category", lines[2])
	}
}

func TestLog_TimestampFormat(t *testing.T) {
	setupTempLog(t)

	Log("test", "check timestamp")

	data, err := os.ReadFile(logPath())
	if err != nil {
		t.Fatal(err)
	}

	line := strings.TrimSpace(string(data))
	// Format: "2026-03-04 19:24:01 [test] check timestamp"
	// Timestamp is 19 chars, then space, then bracket
	if len(line) < 20 || line[4] != '-' || line[7] != '-' || line[10] != ' ' || line[13] != ':' || line[16] != ':' {
		t.Errorf("unexpected timestamp format in: %q", line)
	}
}

func TestLog_SilentOnInvalidPath(t *testing.T) {
	config.ConfigDir = "/nonexistent/path/that/does/not/exist"

	// Should not panic
	Log("test", "should not crash")
}

func TestReadTail_EmptyFile(t *testing.T) {
	setupTempLog(t)

	result := ReadTail(10)
	if result != "" {
		t.Errorf("ReadTail on missing file = %q, want empty", result)
	}
}

func TestReadTail_FewerLinesThanN(t *testing.T) {
	setupTempLog(t)

	Log("a", "line one")
	Log("b", "line two")

	result := ReadTail(10)
	lines := strings.Split(result, "\n")
	if len(lines) != 2 {
		t.Fatalf("got %d lines, want 2", len(lines))
	}
}

func TestReadTail_ExactlyN(t *testing.T) {
	setupTempLog(t)

	Log("a", "one")
	Log("b", "two")
	Log("c", "three")

	result := ReadTail(3)
	lines := strings.Split(result, "\n")
	if len(lines) != 3 {
		t.Fatalf("got %d lines, want 3", len(lines))
	}
}

func TestReadTail_TruncatesOldLines(t *testing.T) {
	setupTempLog(t)

	for i := 0; i < 10; i++ {
		Log("test", "line %d", i)
	}

	result := ReadTail(3)
	lines := strings.Split(result, "\n")
	if len(lines) != 3 {
		t.Fatalf("got %d lines, want 3", len(lines))
	}

	if !strings.Contains(lines[0], "line 7") {
		t.Errorf("first tail line = %q, want line 7", lines[0])
	}
	if !strings.Contains(lines[2], "line 9") {
		t.Errorf("last tail line = %q, want line 9", lines[2])
	}
}

func TestReadTail_MissingFile(t *testing.T) {
	config.ConfigDir = t.TempDir()

	result := ReadTail(100)
	if result != "" {
		t.Errorf("ReadTail on missing file = %q, want empty", result)
	}
}

func TestLog_TruncatesLargeFile(t *testing.T) {
	setupTempLog(t)

	// Write a file just over the 1MB limit
	path := filepath.Join(config.ConfigDir, "debug.log")
	bigLine := strings.Repeat("x", 200) + "\n"
	var content strings.Builder
	for content.Len() < maxLogSize+1000 {
		content.WriteString(bigLine)
	}
	os.WriteFile(path, []byte(content.String()), 0o644)

	// Verify file is over limit
	info, _ := os.Stat(path)
	if info.Size() <= maxLogSize {
		t.Fatal("test setup: file should be over 1MB")
	}

	// Log triggers truncation
	Log("test", "after truncation")

	info, _ = os.Stat(path)
	if info.Size() > maxLogSize {
		t.Errorf("file size after truncation = %d, want <= %d", info.Size(), maxLogSize)
	}

	// New log line should be present
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), "after truncation") {
		t.Error("new log line missing after truncation")
	}
}

func TestLogPath(t *testing.T) {
	config.ConfigDir = "/tmp/test-crew"
	got := logPath()
	want := filepath.Join("/tmp/test-crew", "debug.log")
	if got != want {
		t.Errorf("logPath() = %q, want %q", got, want)
	}
}
