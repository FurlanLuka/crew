package workspace

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

var validWSName = regexp.MustCompile(`^[a-z0-9-]+$`)

// Mode constants for WorkspaceProject.Mode.
const (
	ModeWorktree = "worktree"
	ModeDirect   = "direct"
)

// WorkspaceProject references a global project with a workspace-specific role.
//
// Mode controls path resolution:
//   - "" or "worktree" — workspace gets its own git worktree (default).
//   - "direct" — workspace points at the project's canonical checkout. No worktree
//     is created, and removing the project does NOT touch the underlying repo.
type WorkspaceProject struct {
	Name string `json:"name"`
	Role string `json:"role"`
	Mode string `json:"mode,omitempty"`
}

// IsDirect reports whether a workspace project uses direct mode (no worktree).
func IsDirect(wp WorkspaceProject) bool {
	return wp.Mode == ModeDirect
}

type Workspace struct {
	Name     string             `json:"name"`
	TeamID   string             `json:"team_id,omitempty"`
	Projects []WorkspaceProject `json:"projects"`
}

// WorktreePath returns the worktree directory for a project within a workspace.
// This is a pure path helper; it does not check whether the project is in
// worktree mode. Use ResolvePath when you have a WorkspaceProject in scope.
func WorktreePath(wsName, projName string) string {
	return filepath.Join(config.WorkspacesDir, wsName, projName)
}

// ProjectPath is a deprecated alias for WorktreePath; prefer ResolvePath when
// possible so direct-mode projects resolve to their canonical repo.
func ProjectPath(wsName, projName string) string {
	return WorktreePath(wsName, projName)
}

// ResolvePath returns the working directory for a workspace project: the
// canonical project path for direct mode, or the worktree path otherwise.
// Falls back to the worktree path if the project pool entry is missing.
func ResolvePath(wsName string, wp WorkspaceProject) string {
	if IsDirect(wp) {
		if p := project.Get(wp.Name); p != nil {
			return p.Path
		}
	}
	return WorktreePath(wsName, wp.Name)
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
	if !validWSName.MatchString(name) {
		return fmt.Errorf("workspace name '%s' is invalid — only lowercase letters, digits, and hyphens allowed", name)
	}
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

// Duplicate creates a new workspace with the same projects as the source.
// Each worktree-mode project gets a fresh worktree branched from the default
// branch. Direct-mode projects propagate to the new workspace too, but only
// if no other workspace already direct-mounts the same project.
func Duplicate(srcName, dstName string) error {
	src, err := Load(srcName)
	if err != nil {
		return fmt.Errorf("source workspace: %w", err)
	}
	if err := Create(dstName); err != nil {
		return err
	}
	for _, wp := range src.Projects {
		if err := AddProject(dstName, wp.Name, wp.Role, wp.Mode); err != nil {
			return fmt.Errorf("adding project '%s': %w", wp.Name, err)
		}
	}
	return nil
}

// detectDefaultBranch returns the best base branch for a project repo.
// Tries develop, main, then falls back to HEAD.
func detectDefaultBranch(projectPath string) string {
	for _, branch := range []string{"develop", "main"} {
		out, err := exec.RunGitCommand(projectPath, "rev-parse", "--verify", branch)
		if err == nil && strings.TrimSpace(out) != "" {
			return branch
		}
	}
	return "HEAD"
}

// AddProject adds a project to a workspace. In worktree mode (default) it
// creates a git worktree under the workspace directory; in direct mode it
// records a pointer to the project's canonical checkout without creating a
// worktree.
func AddProject(wsName, projName, role, mode string) error {
	if mode == "" {
		mode = ModeWorktree
	}
	if mode != ModeWorktree && mode != ModeDirect {
		return fmt.Errorf("invalid mode '%s' (expected 'worktree' or 'direct')", mode)
	}

	p := project.Get(projName)
	if p == nil {
		return fmt.Errorf("project '%s' not found in pool", projName)
	}

	// Load workspace first to check for duplicates before any side effects.
	ws, err := Load(wsName)
	if err != nil {
		return err
	}
	for _, existing := range ws.Projects {
		if existing.Name == projName {
			return fmt.Errorf("project '%s' already in workspace", projName)
		}
	}

	if mode == ModeDirect {
		if err := assertNoOtherDirect(projName, wsName); err != nil {
			return err
		}
		if err := assertGitRepo(p.Path); err != nil {
			return fmt.Errorf("project '%s' cannot be used in direct mode: %w", projName, err)
		}
	} else {
		wtDir := WorktreePath(wsName, projName)
		baseBranch := detectDefaultBranch(p.Path)
		branchName := "crew/" + wsName + "/" + projName
		if err := exec.CreateGitWorktree(p.Path, wtDir, branchName, baseBranch); err != nil {
			return fmt.Errorf("failed to create worktree for %s: %w", projName, err)
		}
		exec.CopyEnvFiles(p.Path, wtDir)
		exec.RunNpmInstall(wtDir)
	}

	persistedMode := mode
	if persistedMode == ModeWorktree {
		// Keep JSON tidy: empty string means default (worktree).
		persistedMode = ""
	}
	ws.Projects = append(ws.Projects, WorkspaceProject{Name: projName, Role: role, Mode: persistedMode})
	return Save(ws)
}

// RemoveProject removes a project from a workspace. For worktree-mode projects
// the git worktree is destroyed; for direct-mode projects only the workspace
// entry is removed — the canonical project repo is left untouched.
func RemoveProject(wsName, projName string) error {
	ws, err := Load(wsName)
	if err != nil {
		return err
	}

	for _, wp := range ws.Projects {
		if wp.Name == projName {
			cleanupWorktree(wsName, wp)
			break
		}
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

// Remove fully removes a workspace: stops dev servers, removes git worktrees
// for worktree-mode entries (direct-mode entries are left alone), deletes the
// workspace directory and JSON.
func Remove(name string) error {
	dev.StopAll(name)
	dev.StopProxyIfIdle()
	os.Remove(PromptFilePath(name))

	ws, err := Load(name)
	if err == nil {
		for _, wp := range ws.Projects {
			cleanupWorktree(name, wp)
		}
	}

	// WorkspaceDir is bounded to ~/.claude/workspaces/<name>/. Direct-mode
	// projects' canonical paths live elsewhere, so this RemoveAll cannot reach
	// them — keep it for cleaning up the worktree shells and prompt artifacts.
	os.RemoveAll(WorkspaceDir(name))
	os.Remove(config.WorkspaceFile(name))
	return nil
}

// cleanupWorktree is the single place destructive worktree teardown happens.
// No-ops for direct-mode entries. Defensively asserts the path being deleted
// lives under config.WorkspacesDir before touching it.
func cleanupWorktree(wsName string, wp WorkspaceProject) {
	if IsDirect(wp) {
		return
	}
	wtDir := WorktreePath(wsName, wp.Name)

	// Defensive guard: never delete anything outside the workspaces tree.
	abs, err := filepath.Abs(wtDir)
	if err != nil {
		return
	}
	rootAbs, err := filepath.Abs(config.WorkspacesDir)
	if err != nil {
		return
	}
	if !strings.HasPrefix(abs, rootAbs+string(os.PathSeparator)) {
		return
	}
	// And never the canonical project repo itself.
	if p := project.Get(wp.Name); p != nil {
		pAbs, _ := filepath.Abs(p.Path)
		if pAbs == abs {
			return
		}
		exec.RemoveGitWorktree(p.Path, wtDir)
	}
	os.RemoveAll(wtDir)
}

// assertNoOtherDirect returns an error if any workspace other than excludeWs
// already has a direct-mode entry pointing at projName. Two workspaces sharing
// the same canonical checkout would clobber each other's branch state.
func assertNoOtherDirect(projName, excludeWs string) error {
	names, err := List()
	if err != nil {
		return nil
	}
	for _, name := range names {
		if name == excludeWs {
			continue
		}
		ws, err := Load(name)
		if err != nil {
			continue
		}
		for _, wp := range ws.Projects {
			if wp.Name == projName && IsDirect(wp) {
				return fmt.Errorf("project '%s' is already attached to workspace '%s' in direct mode — only one workspace at a time can use a project directly", projName, name)
			}
		}
	}
	return nil
}

// AssertNoOtherDirect is the exported form for callers outside this package
// (e.g. CLI start paths) that need to defend against direct-mode collisions.
func AssertNoOtherDirect(projName, excludeWs string) error {
	return assertNoOtherDirect(projName, excludeWs)
}

// AssertDirectProjectsAvailable runs the direct-mode collision check across
// every direct-mode project in ws. Call this before starting dev servers,
// launching editors, or doing any other work that assumes the canonical repo
// is bound to ws and not somewhere else.
func AssertDirectProjectsAvailable(ws *Workspace) error {
	for _, wp := range ws.Projects {
		if !IsDirect(wp) {
			continue
		}
		if err := assertNoOtherDirect(wp.Name, ws.Name); err != nil {
			return err
		}
	}
	return nil
}

// assertGitRepo verifies that path is a git repository with a HEAD ref. Used
// when adding a project in direct mode — the agent prompt and dev workflows
// assume a real repo there.
func assertGitRepo(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("path %s: %w", path, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("path %s is not a directory", path)
	}
	if _, err := exec.RunGitCommand(path, "rev-parse", "--git-dir"); err != nil {
		return fmt.Errorf("path %s is not a git repository", path)
	}
	if _, err := exec.RunGitCommand(path, "rev-parse", "HEAD"); err != nil {
		return fmt.Errorf("repository at %s has no commits (HEAD is unborn)", path)
	}
	return nil
}

// currentBranch returns the current branch name at path, or "" if it cannot be
// determined (detached HEAD, missing repo, etc.).
func currentBranch(path string) string {
	out, err := exec.RunGitCommand(path, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return ""
	}
	branch := strings.TrimSpace(out)
	if branch == "HEAD" {
		return ""
	}
	return branch
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
	if ws.TeamID == "" {
		var buf [4]byte
		if _, err := rand.Read(buf[:]); err != nil {
			return "", fmt.Errorf("generate team id: %w", err)
		}
		ws.TeamID = hex.EncodeToString(buf[:])
		if err := Save(ws); err != nil {
			return "", fmt.Errorf("persist team id: %w", err)
		}
	}
	teamName := "crew-" + ws.Name + "-" + ws.TeamID
	var b strings.Builder
	fmt.Fprintf(&b, "Create an agent team named exactly `%s` (use this exact name — it uniquely identifies this workspace) and spawn these teammates:\n", teamName)

	hasWorktree := false
	hasDirect := false
	for _, wp := range ws.Projects {
		path := ResolvePath(ws.Name, wp)
		modeLabel := "worktree"
		if IsDirect(wp) {
			modeLabel = "direct"
			hasDirect = true
		} else {
			hasWorktree = true
		}
		fmt.Fprintf(&b, "- **%s** [%s] (working directory: %s): %s\n", wp.Name, modeLabel, path, wp.Role)
	}
	b.WriteString("\n")

	if hasWorktree {
		b.WriteString("IMPORTANT: `[worktree]` projects are git worktrees — isolated working copies with their own branches.\n")
		b.WriteString("All changes in worktree projects stay isolated from the main codebase until explicitly merged.\n\n")
	}

	if hasDirect {
		b.WriteString("CAUTION: `[direct]` projects point at the canonical repository — changes are NOT isolated. ")
		b.WriteString("Confirm with the user before committing or switching branches in a direct project.\n")
		for _, wp := range ws.Projects {
			if !IsDirect(wp) {
				continue
			}
			path := ResolvePath(ws.Name, wp)
			branch := currentBranch(path)
			if branch == "" {
				fmt.Fprintf(&b, "  - **%s** is on a detached HEAD or unknown branch at %s.\n", wp.Name, path)
			} else {
				fmt.Fprintf(&b, "  - **%s** is currently on branch `%s` at %s.\n", wp.Name, branch, path)
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
			Path:       ResolvePath(wsName, wp),
			DevServers: servers,
		})
	}
	return projects
}
