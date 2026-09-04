// Package trash is where removed checkouts go so removal returns at once.
//
// Deleting a worktree with a full Xcode build inside can take a minute;
// renaming it into ~/.crew/trash takes no time on the same volume. A detached
// rm then clears it, and the next crew run retries anything left behind.
package trash

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/dirsize"
)

// Put moves path into the trash and returns where it went. Only paths under
// config.WorkspacesDir are accepted: this is the one place a checkout is
// moved out of the tree, so the guard against deleting something else lives
// here. When the rename fails (another volume), the path is removed in place
// and "" is returned.
func Put(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	root, err := filepath.Abs(config.WorkspacesDir)
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(abs, root+string(os.PathSeparator)) {
		return "", fmt.Errorf("refusing to trash %s: not under %s", abs, root)
	}
	if _, err := os.Lstat(abs); errors.Is(err, os.ErrNotExist) {
		return "", nil
	}

	if config.TrashDir == "" {
		return "", errors.New("trash directory is not configured")
	}
	if err := os.MkdirAll(config.TrashDir, 0o755); err != nil {
		return "", err
	}
	dest := filepath.Join(config.TrashDir, fmt.Sprintf("%d-%s", time.Now().UnixNano(), filepath.Base(abs)))
	debug.Log("trash", "move %s → %s", abs, dest)
	if err := rename(abs, dest); err != nil {
		debug.Log("trash", "rename failed, removing in place: %v", err)
		return "", os.RemoveAll(abs)
	}
	return dest, nil
}

// Sweep starts a detached delete of every trash entry and returns without
// waiting. Safe to call repeatedly — two rm's on one entry just race to
// nothing.
func Sweep() {
	entries, err := os.ReadDir(config.TrashDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		sweep(filepath.Join(config.TrashDir, e.Name()))
	}
}

// rename and sweep are variables so tests can fail the move and keep the
// entries around to look at.
var (
	rename = os.Rename
	sweep  = spawnRemove
)

func spawnRemove(path string) {
	debug.Log("trash", "rm -rf %s (detached)", path)
	cmd := exec.Command("rm", "-rf", path)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Stdout, cmd.Stderr = nil, nil
	if err := cmd.Start(); err != nil {
		debug.Log("trash", "rm -rf %s → error: %v", path, err)
		return
	}
	// Reap it: a TUI session can outlive many of these.
	go cmd.Wait()
}

// Empty deletes every entry now, for the case where the background delete
// never finished.
func Empty() error {
	entries, err := os.ReadDir(config.TrashDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	for _, e := range entries {
		path := filepath.Join(config.TrashDir, e.Name())
		debug.Log("trash", "empty: rm %s", path)
		if err := os.RemoveAll(path); err != nil {
			debug.Log("trash", "empty %s → error: %v", path, err)
			return err
		}
	}
	return nil
}

// Entries is how many things are waiting to be cleared. Cheap: one readdir.
func Entries() int {
	entries, err := os.ReadDir(config.TrashDir)
	if err != nil {
		return 0
	}
	return len(entries)
}

// Size walks the trash. Slow on a big one — call it off the UI thread.
func Size() (bytes int64, entries int) {
	list, err := os.ReadDir(config.TrashDir)
	if err != nil {
		return 0, 0
	}
	for _, e := range list {
		bytes += dirsize.Of(filepath.Join(config.TrashDir, e.Name()))
	}
	return bytes, len(list)
}

// DisableSweepForTest keeps trashed entries on disk for the test to inspect.
func DisableSweepForTest(t interface{ Cleanup(func()) }) {
	prev := sweep
	sweep = func(string) {}
	t.Cleanup(func() { sweep = prev })
}
