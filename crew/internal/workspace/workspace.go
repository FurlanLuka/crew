package workspace

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// WorkspaceProject references a global project with a workspace-specific role.
type WorkspaceProject struct {
	Name string `json:"name"`
	Role string `json:"role"`
}

type Workspace struct {
	Name     string             `json:"name"`
	Projects []WorkspaceProject `json:"projects"`
}

// ProjectPath returns the worktree directory for a project within a workspace.
func ProjectPath(wsName, projName string) string {
	return filepath.Join(config.WorkspacesDir, wsName, projName)
}

// WorkspaceDir returns the root directory for a workspace.
func WorkspaceDir(wsName string) string {
	return filepath.Join(config.WorkspacesDir, wsName)
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
	Name         string
	ProjectCount int
	DevRunning   bool
	TmuxActive   bool
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
			ProjectCount: projCount,
			DevRunning:   devRoutesExist(name),
			TmuxActive: exec.TmuxSessionExists("crew-"+name+"-claude") ||
				exec.TmuxSessionExists("crew-"+name+"-servers") ||
				exec.TmuxSessionExists("crew-"+name+"-git") ||
				exec.TmuxSessionExists("crew-"+name), // backward compat
		})
	}
	return summaries, nil
}

func devRoutesExist(wsName string) bool {
	info, err := os.Stat(dev.RoutesFilePath(wsName))
	return err == nil && info.Size() > 2 // more than just "[]"
}

// Create creates a new empty workspace with its directory.
func Create(name string) error {
	if _, err := os.Stat(config.WorkspaceFile(name)); err == nil {
		return fmt.Errorf("workspace '%s' already exists", name)
	}
	if err := os.MkdirAll(WorkspaceDir(name), 0o755); err != nil {
		return err
	}
	ws := &Workspace{
		Name:     name,
		Projects: []WorkspaceProject{},
	}
	return Save(ws)
}

// DetectDefaultBranch returns the best base branch for a project repo.
// Tries develop, main, then falls back to HEAD.
func DetectDefaultBranch(projectPath string) string {
	for _, branch := range []string{"develop", "main"} {
		out, err := exec.RunGitCommand(projectPath, "rev-parse", "--verify", branch)
		if err == nil && strings.TrimSpace(out) != "" {
			return branch
		}
	}
	return "HEAD"
}

// AddProject creates a git worktree and adds a project to a workspace.
func AddProject(wsName, projName, role string) error {
	p := project.Get(projName)
	if p == nil {
		return fmt.Errorf("project '%s' not found in pool", projName)
	}

	// Load workspace first to check for duplicates before creating worktree
	ws, err := Load(wsName)
	if err != nil {
		return err
	}
	for _, existing := range ws.Projects {
		if existing.Name == projName {
			return fmt.Errorf("project '%s' already in workspace", projName)
		}
	}

	wtDir := ProjectPath(wsName, projName)
	baseBranch := DetectDefaultBranch(p.Path)

	branchName := "crew/" + wsName + "/" + projName
	if err := exec.CreateGitWorktree(p.Path, wtDir, branchName, baseBranch); err != nil {
		return fmt.Errorf("failed to create worktree for %s: %w", projName, err)
	}

	exec.CopyEnvFiles(p.Path, wtDir)
	exec.RunNpmInstall(wtDir)

	ws.Projects = append(ws.Projects, WorkspaceProject{Name: projName, Role: role})
	return Save(ws)
}

// RemoveProject removes a git worktree and project from a workspace.
func RemoveProject(wsName, projName string) error {
	wtDir := ProjectPath(wsName, projName)

	// Try to remove git worktree properly
	p := project.Get(projName)
	if p != nil {
		exec.RemoveGitWorktree(p.Path, wtDir)
	}
	os.RemoveAll(wtDir) // fallback cleanup

	ws, err := Load(wsName)
	if err != nil {
		return err
	}
	var filtered []WorkspaceProject
	for _, wp := range ws.Projects {
		if wp.Name != projName {
			filtered = append(filtered, wp)
		}
	}
	ws.Projects = filtered
	return Save(ws)
}

// Remove fully removes a workspace: stops session, removes git worktrees,
// deletes workspace directory and JSON.
func Remove(name string) error {
	StopSession(name)

	ws, err := Load(name)
	if err == nil {
		for _, wp := range ws.Projects {
			wtDir := ProjectPath(name, wp.Name)
			p := project.Get(wp.Name)
			if p != nil {
				exec.RemoveGitWorktree(p.Path, wtDir)
			}
		}
	}

	os.RemoveAll(WorkspaceDir(name))
	os.Remove(config.WorkspaceFile(name))
	return nil
}

// PromptFilePath returns the path for the workspace prompt file.
func PromptFilePath(wsName string) string {
	return filepath.Join(config.ConfigDir, "prompt-"+wsName+".md")
}

// CodeWorkspaceFilePath returns the .code-workspace file path.
func CodeWorkspaceFilePath(wsName string) string {
	return filepath.Join(config.ConfigDir, wsName+".code-workspace")
}

// GeneratePrompt builds the agent team prompt, writes it to the prompt file,
// and returns the text.
func GeneratePrompt(ws *Workspace) (string, error) {
	var b strings.Builder
	b.WriteString("Create an agent team and spawn these teammates:\n")
	for _, wp := range ws.Projects {
		path := ProjectPath(ws.Name, wp.Name)
		fmt.Fprintf(&b, "- **%s** (working directory: %s): %s\n", wp.Name, path, wp.Role)
	}
	b.WriteString("\n")

	b.WriteString("IMPORTANT: Each project directory is a git worktree — an isolated working copy with its own branch.\n")
	b.WriteString("All changes stay isolated from the main codebase until explicitly merged.\n\n")

	b.WriteString("Each teammate should cd into their project directory before starting work.\n")
	b.WriteString("Create a shared task list so I can see status.\n")
	b.WriteString("Wait for my instructions on what to build.\n")

	text := b.String()
	promptFile := PromptFilePath(ws.Name)
	if err := os.WriteFile(promptFile, []byte(text), 0o644); err != nil {
		return "", err
	}
	return text, nil
}

// StopSession kills the tmux session, stops dev servers, and removes the
// prompt file for a workspace.
func StopSession(wsName string) {
	exec.KillTmuxSession("crew-" + wsName + "-claude")
	exec.KillTmuxSession("crew-" + wsName + "-servers")
	exec.KillTmuxSession("crew-" + wsName + "-git")
	// Backward compat
	exec.KillTmuxSession("crew-" + wsName)
	exec.KillTmuxSession("crew-git-" + wsName)
	dev.StopAll(wsName)
	os.Remove(PromptFilePath(wsName))
}

// BuildDevProjects converts workspace projects into dev.DevProject slice
// using project pool for config and workspace dir for paths.
func BuildDevProjects(wsName string, wsProjects []WorkspaceProject) []dev.DevProject {
	var projects []dev.DevProject
	for _, wp := range wsProjects {
		p := project.Get(wp.Name)
		if p == nil || len(p.DevServers) == 0 {
			continue
		}
		var servers []dev.DevServerConfig
		for _, ds := range p.DevServers {
			servers = append(servers, dev.DevServerConfig{
				Name:    ds.Name,
				Port:    ds.Port,
				Command: ds.Command,
				Dir:     ds.Dir,
			})
		}
		projects = append(projects, dev.DevProject{
			Path:       ProjectPath(wsName, wp.Name),
			DevServers: servers,
		})
	}
	return projects
}
