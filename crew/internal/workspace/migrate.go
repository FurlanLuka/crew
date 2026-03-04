package workspace

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// oldProject matches the pre-migration workspace project shape.
type oldProject struct {
	Name       string              `json:"name"`
	Path       string              `json:"path"`
	Role       string              `json:"role"`
	DevServers []project.DevServer `json:"dev_servers,omitempty"`
}

// oldWorkspace matches the pre-migration workspace shape.
type oldWorkspace struct {
	Name     string `json:"name"`
	Worktree *struct {
		BaseWorkspace string `json:"base_workspace"`
		Name          string `json:"name"`
	} `json:"worktree,omitempty"`
	Projects []oldProject `json:"projects"`
}

// Migrate performs a one-time migration from the old workspace model to the new one.
// It copies dev server configs from workspace projects to the global project pool,
// then deletes old workspace JSONs and cleans up stale worktree tracking.
func Migrate() {
	entries, err := os.ReadDir(config.WorkspacesDir)
	if err != nil {
		return
	}

	var oldFiles []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		oldFiles = append(oldFiles, e.Name())
	}

	if len(oldFiles) == 0 {
		return
	}

	// Check if any workspace has old-style data (projects with Path field or Worktree field)
	needsMigration := false
	var oldWorkspaces []oldWorkspace

	for _, f := range oldFiles {
		data, err := os.ReadFile(filepath.Join(config.WorkspacesDir, f))
		if err != nil {
			continue
		}
		var ow oldWorkspace
		if err := json.Unmarshal(data, &ow); err != nil {
			continue
		}
		oldWorkspaces = append(oldWorkspaces, ow)

		// Check for old-style indicators
		if ow.Worktree != nil {
			needsMigration = true
			continue
		}
		for _, p := range ow.Projects {
			if p.Path != "" {
				needsMigration = true
				break
			}
		}
	}

	if !needsMigration {
		return
	}

	// Step 1: Copy dev server configs from workspace projects to global project pool
	for _, ow := range oldWorkspaces {
		if ow.Worktree != nil {
			continue // skip worktree workspaces, only process base workspaces
		}
		for _, op := range ow.Projects {
			if len(op.DevServers) == 0 {
				continue
			}
			p := project.Get(op.Name)
			if p == nil {
				continue
			}
			// Only copy if the project doesn't already have dev servers
			if len(p.DevServers) > 0 {
				continue
			}
			p.DevServers = op.DevServers
			project.Update(*p)
		}
	}

	// Step 2: Delete all old workspace JSON files that are worktree workspaces
	// (composite names with --)
	for _, f := range oldFiles {
		name := strings.TrimSuffix(f, ".json")
		if strings.Contains(name, "--") {
			os.Remove(filepath.Join(config.WorkspacesDir, f))
		}
	}

	// Step 3: Rewrite remaining base workspace JSONs to new format
	for _, ow := range oldWorkspaces {
		if ow.Worktree != nil {
			continue // already deleted above
		}

		hasOldData := false
		for _, p := range ow.Projects {
			if p.Path != "" {
				hasOldData = true
				break
			}
		}
		if !hasOldData {
			continue
		}

		// Convert to new format
		newProjects := make([]WorkspaceProject, len(ow.Projects))
		for i, op := range ow.Projects {
			newProjects[i] = WorkspaceProject{
				Name: op.Name,
				Role: op.Role,
			}
		}
		os.MkdirAll(WorkspaceDir(ow.Name), 0o755)
		ws := &Workspace{
			Name:     ow.Name,
			Projects: newProjects,
		}
		Save(ws)
	}

	// Step 4: Clean up stale git worktree tracking in each project
	projects, _ := project.List()
	for _, p := range projects {
		exec.PruneWorktrees(p.Path)

		// Remove .claude/worktrees/ directories
		wtDir := filepath.Join(p.Path, ".claude", "worktrees")
		os.RemoveAll(wtDir)
	}
}
