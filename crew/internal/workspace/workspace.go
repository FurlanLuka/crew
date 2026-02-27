package workspace

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/FurlanLuka/homebrew-tap/crew/internal/config"
)

type Project struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Role string `json:"role"`
}

type WorktreeInfo struct {
	BaseWorkspace string `json:"base_workspace"`
	Name          string `json:"name"`
}

type Workspace struct {
	Name     string        `json:"name"`
	Worktree *WorktreeInfo `json:"worktree,omitempty"`
	Projects []Project     `json:"projects"`
}

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

func Remove(name string) error {
	return os.Remove(config.WorkspaceFile(name))
}

// List returns all base workspace names (excludes worktree workspaces).
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
		if strings.Contains(name, "--") {
			continue
		}
		names = append(names, name)
	}
	return names, nil
}

// WorktreeWorkspaceName returns the composite workspace name for a worktree.
func WorktreeWorkspaceName(base, wtName string) string {
	return base + "--" + wtName
}

// ListWorktrees returns worktree names for a base workspace.
func ListWorktrees(base string) ([]string, error) {
	entries, err := os.ReadDir(config.WorkspacesDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	prefix := base + "--"
	var names []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		name := strings.TrimSuffix(e.Name(), ".json")
		if strings.HasPrefix(name, prefix) {
			names = append(names, strings.TrimPrefix(name, prefix))
		}
	}
	return names, nil
}

// CountWorktrees returns the number of worktrees for a base workspace.
func CountWorktrees(base string) int {
	wts, _ := ListWorktrees(base)
	return len(wts)
}

// Summary holds display info for the workspace list view.
type Summary struct {
	Name          string
	ProjectCount  int
	WorktreeCount int
}

// ListSummaries returns summaries for all base workspaces.
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
			Name:          name,
			ProjectCount:  projCount,
			WorktreeCount: CountWorktrees(name),
		})
	}
	return summaries, nil
}

// Create creates a new empty workspace.
func Create(name string) error {
	ws := &Workspace{
		Name:     name,
		Projects: []Project{},
	}
	return Save(ws)
}

// AddProject adds a project to a workspace.
func AddProject(wsName string, proj Project) error {
	ws, err := Load(wsName)
	if err != nil {
		return err
	}
	ws.Projects = append(ws.Projects, proj)
	return Save(ws)
}

// RemoveProject removes a project by name from a workspace.
func RemoveProject(wsName, projName string) error {
	ws, err := Load(wsName)
	if err != nil {
		return err
	}
	filtered := ws.Projects[:0]
	for _, p := range ws.Projects {
		if p.Name != projName {
			filtered = append(filtered, p)
		}
	}
	ws.Projects = filtered
	return Save(ws)
}

// NormalizeName converts slashes to dashes for filesystem safety.
func NormalizeName(name string) string {
	return strings.ReplaceAll(name, "/", "-")
}

// PromptFilePath returns the path for the workspace prompt file.
func PromptFilePath(wsName string) string {
	return filepath.Join(config.ConfigDir, "prompt-"+wsName+".md")
}

// CodeWorkspaceFilePath returns the .code-workspace file path.
func CodeWorkspaceFilePath(wsName string) string {
	return filepath.Join(config.ConfigDir, wsName+".code-workspace")
}
