package workspace

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/FurlanLuka/homebrew-tap/crew/internal/config"
	"github.com/FurlanLuka/homebrew-tap/crew/internal/exec"
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

// CreateWorktree creates a worktree workspace JSON and git worktrees for all
// projects. It is idempotent — if the worktree already exists, it returns the
// normalized name without error.
func CreateWorktree(base, name, fromBranch string) (string, error) {
	safeName := NormalizeName(name)
	wtWs := WorktreeWorkspaceName(base, safeName)

	if Exists(wtWs) {
		return safeName, nil
	}

	ws, err := Load(base)
	if err != nil {
		return "", err
	}
	if len(ws.Projects) == 0 {
		return "", fmt.Errorf("workspace '%s' has no projects", base)
	}

	branch := "worktree-" + name
	wtWorkspace := &Workspace{
		Name: wtWs,
		Worktree: &WorktreeInfo{
			BaseWorkspace: base,
			Name:          safeName,
		},
		Projects: make([]Project, len(ws.Projects)),
	}
	for i, p := range ws.Projects {
		wtWorkspace.Projects[i] = Project{
			Name: p.Name,
			Path: p.Path + "/.claude/worktrees/" + safeName,
			Role: p.Role,
		}
	}
	if err := Save(wtWorkspace); err != nil {
		return "", err
	}

	for _, p := range ws.Projects {
		wtDir := p.Path + "/.claude/worktrees/" + safeName
		if err := exec.CreateGitWorktree(p.Path, wtDir, branch, fromBranch); err != nil {
			return "", fmt.Errorf("failed to create worktree for %s: %w", p.Name, err)
		}
		exec.EnsureGitignore(p.Path)
		exec.CopyEnvFiles(p.Path, wtDir)
		exec.RunNpmInstall(wtDir)
	}

	return safeName, nil
}

// GeneratePrompt builds the agent team prompt, writes it to the prompt file,
// and returns the text.
func GeneratePrompt(ws *Workspace) (string, error) {
	var b strings.Builder
	b.WriteString("Create an agent team and spawn these teammates:\n")
	for _, p := range ws.Projects {
		fmt.Fprintf(&b, "- **%s** (working directory: %s): %s\n", p.Name, p.Path, p.Role)
	}
	b.WriteString("\n")

	if ws.Worktree != nil {
		b.WriteString("IMPORTANT: Each project directory is a git worktree — an isolated working copy with its own branch.\n")
		b.WriteString("All changes stay isolated from the main codebase until explicitly merged.\n\n")
	}

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
