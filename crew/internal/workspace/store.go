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

// Summary holds display info for the workspace list view.
type Summary struct {
	Name         string `json:"name"`
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

	summaries := make([]Summary, 0, len(names))
	for _, name := range names {
		ws, err := Load(name)
		projCount := 0
		if err == nil {
			projCount = len(ws.Projects)
		}
		summaries = append(summaries, Summary{
			Name:         name,
			Path:         WorkspaceDir(name),
			ProjectCount: projCount,
			DevRunning:   devRoutesExist(name),
		})
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
