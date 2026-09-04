package dirsize

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOf(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "a", "b"), 0o755)
	os.WriteFile(filepath.Join(root, "one"), make([]byte, 100), 0o644)
	os.WriteFile(filepath.Join(root, "a", "two"), make([]byte, 250), 0o644)
	os.WriteFile(filepath.Join(root, "a", "b", "three"), make([]byte, 7), 0o644)
	// A symlink to a file elsewhere is not followed, and not counted.
	os.WriteFile(filepath.Join(t.TempDir(), "outside"), make([]byte, 5000), 0o644)
	os.Symlink(filepath.Join(root, "one"), filepath.Join(root, "link"))

	if got := Of(root); got != 357 {
		t.Errorf("Of = %d, want 357", got)
	}
	if got := Of(filepath.Join(root, "missing")); got != 0 {
		t.Errorf("Of(missing) = %d, want 0", got)
	}
}
