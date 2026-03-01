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
)

type DevServer struct {
	Name    string `json:"name"`
	Port    int    `json:"port"`
	Command string `json:"command"`
	Dir     string `json:"dir,omitempty"`
}

type Project struct {
	Name       string      `json:"name"`
	Path       string      `json:"path"`
	Role       string      `json:"role"`
	DevServers []DevServer `json:"dev_servers,omitempty"`
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
	DevRunning    bool
	TmuxActive    bool
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
			DevRunning:    devRoutesExist(name),
			TmuxActive:    exec.TmuxSessionExists("crew-" + name),
		})
	}
	return summaries, nil
}

func devRoutesExist(wsName string) bool {
	info, err := os.Stat(dev.RoutesFilePath(wsName))
	return err == nil && info.Size() > 2 // more than just "[]"
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

// worktreeDirsExist checks whether the git worktree directories for all
// projects in the base workspace actually exist on disk.
func worktreeDirsExist(base, safeName string) bool {
	ws, err := Load(base)
	if err != nil {
		return false
	}
	for _, p := range ws.Projects {
		dir := p.Path + "/.claude/worktrees/" + safeName
		if _, err := os.Stat(dir); os.IsNotExist(err) {
			return false
		}
	}
	return true
}

// CreateWorktree creates git worktrees for all projects in the base workspace
// and saves a worktree workspace JSON. It is idempotent — if the worktree
// already exists, it returns the normalized name without error.
func CreateWorktree(base, name, fromBranch string) (string, error) {
	safeName := NormalizeName(name)
	wtWs := WorktreeWorkspaceName(base, safeName)

	if Exists(wtWs) {
		if worktreeDirsExist(base, safeName) {
			return safeName, nil
		}
		// Stale JSON without actual worktree dirs — clean up.
		Remove(wtWs)
	}

	ws, err := Load(base)
	if err != nil {
		return "", err
	}
	if len(ws.Projects) == 0 {
		return "", fmt.Errorf("workspace '%s' has no projects", base)
	}

	branch := "worktree-" + name

	// 1. Create git worktrees FIRST — rollback on failure
	var created []int
	for i, p := range ws.Projects {
		wtDir := p.Path + "/.claude/worktrees/" + safeName
		if err := exec.CreateGitWorktree(p.Path, wtDir, branch, fromBranch); err != nil {
			for _, ci := range created {
				cp := ws.Projects[ci]
				exec.RemoveGitWorktree(cp.Path, cp.Path+"/.claude/worktrees/"+safeName)
			}
			return "", fmt.Errorf("failed to create worktree for %s: %w", p.Name, err)
		}
		created = append(created, i)
		exec.EnsureGitignore(p.Path)
		exec.CopyEnvFiles(p.Path, wtDir)
		exec.RunNpmInstall(wtDir)
	}

	// 2. Save workspace JSON after all git worktrees succeed
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
			Name:       p.Name,
			Path:       p.Path + "/.claude/worktrees/" + safeName,
			Role:       p.Role,
			DevServers: p.DevServers,
		}
	}
	if err := Save(wtWorkspace); err != nil {
		for _, ci := range created {
			cp := ws.Projects[ci]
			exec.RemoveGitWorktree(cp.Path, cp.Path+"/.claude/worktrees/"+safeName)
		}
		return "", err
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

	// Include dev server URLs if configured
	hasDevServers := false
	for _, p := range ws.Projects {
		if len(p.DevServers) > 0 {
			hasDevServers = true
			break
		}
	}
	if hasDevServers {
		b.WriteString("Dev servers are configured for this workspace. Each project's dev servers:\n")
		for _, p := range ws.Projects {
			for _, ds := range p.DevServers {
				dir := ""
				if ds.Dir != "" {
					dir = " (dir: " + ds.Dir + ")"
				}
				fmt.Fprintf(&b, "- %s/%s: port %d, command: %s%s\n", p.Name, ds.Name, ds.Port, ds.Command, dir)
			}
		}
		b.WriteString("\n")
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

// BuildDevProjects converts workspace projects into dev.DevProject slice.
// baseWs provides the dev server config, srcProjects provides the paths
// (which may be worktree paths).
func BuildDevProjects(baseWs *Workspace, srcProjects []Project) []dev.DevProject {
	var projects []dev.DevProject
	for _, sp := range srcProjects {
		var servers []dev.DevServerConfig
		for _, bp := range baseWs.Projects {
			if bp.Name == sp.Name {
				for _, ds := range bp.DevServers {
					servers = append(servers, dev.DevServerConfig{
						Name:    ds.Name,
						Port:    ds.Port,
						Command: ds.Command,
						Dir:     ds.Dir,
					})
				}
				break
			}
		}
		if len(servers) > 0 {
			projects = append(projects, dev.DevProject{
				Path:       sp.Path,
				DevServers: servers,
			})
		}
	}
	return projects
}
