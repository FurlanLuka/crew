package workspace

import (
	"encoding/json"
	"os"
	"strings"

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

func Save(ws *Workspace) error {
	data, err := json.MarshalIndent(ws, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(config.WorkspaceFile(ws.Name), data, 0o644)
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
	Name         string `json:"name"` // "phone-speak/wrk2"
	Workspace    string `json:"workspace"`
	Worktree     string `json:"worktree"`
	Path         string `json:"path"`
	ProjectCount int    `json:"project_count"`
	DevRunning   bool   `json:"dev_running"`
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
		for _, ref := range workspaceRefs(ws) {
			summaries = append(summaries, Summary{
				Ref:          ref,
				Name:         ref.String(),
				Workspace:    ref.Workspace,
				Worktree:     ref.Worktree,
				Path:         WorktreeDir(ref),
				ProjectCount: len(ws.Projects),
				DevRunning:   dev.Running(ref.Slug()),
			})
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
	for _, ref := range workspaceRefs(ws) {
		if dev.Running(ref.Slug()) {
			return true
		}
	}
	return false
}
