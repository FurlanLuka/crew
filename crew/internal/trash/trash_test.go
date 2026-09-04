package trash

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

func setup(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	config.ConfigDir = tmp
	config.WorkspacesDir = filepath.Join(tmp, "workspaces")
	config.TrashDir = filepath.Join(tmp, "trash")
	os.MkdirAll(config.WorkspacesDir, 0o755)
	DisableSweepForTest(t)
	return tmp
}

func checkout(t *testing.T, rel string, size int) string {
	t.Helper()
	dir := filepath.Join(config.WorkspacesDir, rel)
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "f"), make([]byte, size), 0o644)
	return dir
}

func TestPut_MovesUnderTrash(t *testing.T) {
	setup(t)
	src := checkout(t, "ws/wrk1/api", 10)

	dest, err := Put(src)
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Error("source should be gone")
	}
	if filepath.Dir(dest) != config.TrashDir || !strings.HasSuffix(dest, "-api") {
		t.Errorf("dest = %q", dest)
	}
	if _, err := os.Stat(filepath.Join(dest, "f")); err != nil {
		t.Errorf("contents not moved: %v", err)
	}
	if n := Entries(); n != 1 {
		t.Errorf("Entries = %d, want 1", n)
	}
}

func TestPut_RefusesOutsideWorkspaces(t *testing.T) {
	tmp := setup(t)
	outside := filepath.Join(tmp, "elsewhere")
	os.MkdirAll(outside, 0o755)

	if _, err := Put(outside); err == nil || !strings.Contains(err.Error(), "refusing") {
		t.Fatalf("err = %v, want refusal", err)
	}
	if _, err := Put(config.WorkspacesDir); err == nil {
		t.Error("the workspaces root itself must be refused")
	}
	if _, err := os.Stat(outside); err != nil {
		t.Error("refused path must be untouched")
	}
}

func TestPut_MissingIsNoop(t *testing.T) {
	setup(t)
	dest, err := Put(filepath.Join(config.WorkspacesDir, "ws", "gone"))
	if err != nil || dest != "" {
		t.Errorf("Put(missing) = %q, %v", dest, err)
	}
}

func TestSizeAndEmpty(t *testing.T) {
	setup(t)
	Put(checkout(t, "ws/wrk1/api", 100))
	Put(checkout(t, "ws/wrk2/api", 250))

	bytes, n := Size()
	if bytes != 350 || n != 2 {
		t.Errorf("Size = %d, %d; want 350, 2", bytes, n)
	}
	if err := Empty(); err != nil {
		t.Fatalf("Empty: %v", err)
	}
	if bytes, n := Size(); bytes != 0 || n != 0 {
		t.Errorf("after Empty: %d, %d", bytes, n)
	}
}

func TestSweep_SpawnsPerEntry(t *testing.T) {
	setup(t)
	Put(checkout(t, "ws/wrk1/api", 1))
	Put(checkout(t, "ws/wrk2/api", 1))

	var swept []string
	sweep = func(p string) { swept = append(swept, p) }
	Sweep()
	if len(swept) != 2 {
		t.Errorf("swept %v, want 2 entries", swept)
	}
}
