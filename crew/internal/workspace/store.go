package workspace

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
)

func Load(name string) (*Workspace, error) {
	data, err := os.ReadFile(config.WorkspaceFile(name))
	if err != nil {
		return nil, err
	}
	var ws Workspace
	if err := json.Unmarshal(data, &ws); err != nil {
		return nil, err
	}
	return &ws, nil
}

// Save writes the workspace whole. Atomic — written beside the file and
// renamed over it — so a reader never sees a truncated file: the setup
// runners write health per project while the list, the page and `crew
// setup status` read the same file every couple of seconds.
func Save(ws *Workspace) error {
	data, err := json.MarshalIndent(ws, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(config.WorkspaceFile(ws.Name), data)
}

// Update is every read-modify-write on a workspace file: load, apply fn,
// save, under an exclusive lock on <name>.json.lock. The runners of one
// worktree record their health concurrently, and a user's `crew add
// override` can land in between — without the lock, whichever saved last
// would silently drop the others' writes. fn returning an error saves
// nothing.
func Update(name string, fn func(*Workspace) error) error {
	unlock, err := lockWorkspace(name)
	if err != nil {
		return err
	}
	defer unlock()

	ws, err := Load(name)
	if err != nil {
		return err
	}
	if err := fn(ws); err != nil {
		return err
	}
	return Save(ws)
}

// lockWorkspace takes the file lock for one workspace; the returned func
// releases it. flock is per open file description, so every caller opens
// its own descriptor — two goroutines sharing one would not exclude each
// other.
func lockWorkspace(name string) (func(), error) {
	path := config.WorkspaceFile(name) + ".lock"
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, fmt.Errorf("lock %s: %w", name, err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return nil, fmt.Errorf("lock %s: %w", name, err)
	}
	return func() {
		syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		f.Close()
	}, nil
}

// writeAtomic writes data to a temp file in the same directory and renames
// it over path — a reader sees the old file or the new one, never a part.
func writeAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func Exists(name string) bool {
	_, err := os.Stat(config.WorkspaceFile(name))
	return err == nil
}

// List returns all workspace names.
func List() ([]string, error) {
	entries, err := os.ReadDir(config.WorkspacesDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var names []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		name := strings.TrimSuffix(e.Name(), ".json")
		names = append(names, name)
	}
	return names, nil
}

// Summary is one worktree as the list view shows it. The list is flat — one
// row per worktree, not per workspace — because every action a row offers
// (launch, dev servers, git, editor) acts on a working copy, and a row that is
// already one leaves nothing to pick.
type Summary struct {
	Ref          Ref    `json:"-"`
	Name         string `json:"name"` // "store-front/wrk2"
	Workspace    string `json:"workspace"`
	Worktree     string `json:"worktree"`
	Path         string `json:"path"`
	ProjectCount int    `json:"project_count"`
	DevRunning   bool   `json:"dev_running"`
	// Installing: a setup runner is alive on this worktree — creation, a
	// verify or a setup still going.
	Installing bool   `json:"installing"`
	Health     string `json:"health,omitempty"` // Health.Summary(), "" when fine
}

// ListSummaries returns summaries for all workspaces.
func ListSummaries() ([]Summary, error) {
	names, err := List()
	if err != nil {
		return nil, err
	}

	var summaries []Summary
	for _, name := range names {
		ws, err := Load(name)
		if err != nil {
			continue
		}
		for _, ref := range Refs(ws) {
			sm := Summary{
				Ref:          ref,
				Name:         ref.String(),
				Workspace:    ref.Workspace,
				Worktree:     ref.Worktree,
				Path:         WorktreeDir(ref),
				ProjectCount: len(ws.Projects),
				DevRunning:   dev.Running(ref.Slug()),
				Installing:   SetupRunning(ref),
			}
			if wt, err := selectWorktree(ws, ref.Worktree); err == nil {
				sm.Health = wt.Health.Summary()
			}
			summaries = append(summaries, sm)
		}
	}
	return summaries, nil
}

// devRoutesExist reports whether any of a workspace's worktrees has dev
// servers running.
func devRoutesExist(wsName string) bool {
	ws, err := Load(wsName)
	if err != nil {
		return dev.Running(dev.Slug(wsName))
	}
	for _, ref := range Refs(ws) {
		if dev.Running(ref.Slug()) {
			return true
		}
	}
	return false
}
