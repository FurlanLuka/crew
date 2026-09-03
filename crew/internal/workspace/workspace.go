package workspace

import (
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

// Worktree is one working copy of a workspace's projects. Overrides pin a
// variable for this worktree only, beating whatever binding would otherwise
// resolve it; keys are "VAR" or "project.VAR", and the qualified form wins.
type Worktree struct {
	Name      string            `json:"name"`
	Overrides map[string]string `json:"overrides,omitempty"`
}

type Workspace struct {
	Name      string             `json:"name"`
	Projects  []WorkspaceProject `json:"projects"`
	Worktrees []Worktree         `json:"worktrees,omitempty"`
}

// selectWorktree picks the named worktree, or the only one when unnamed.
//
// A workspace with no worktrees at all predates the nested layout. It resolves
// to a single unnamed worktree so its paths and slug stay flat, which is what
// keeps crew working against un-migrated state.
func selectWorktree(ws *Workspace, name string) (Worktree, error) {
	if len(ws.Worktrees) == 0 {
		return Worktree{}, nil
	}
	if name == "" {
		if len(ws.Worktrees) == 1 {
			return ws.Worktrees[0], nil
		}
		return Worktree{}, fmt.Errorf("workspace '%s' has %d worktrees (%s) — say which: %s/<worktree>",
			ws.Name, len(ws.Worktrees), strings.Join(WorktreeNames(ws), ", "), ws.Name)
	}
	for _, wt := range ws.Worktrees {
		if wt.Name == name {
			return wt, nil
		}
	}
	return Worktree{}, fmt.Errorf("workspace '%s' has no worktree '%s' (have: %s)",
		ws.Name, name, strings.Join(WorktreeNames(ws), ", "))
}

// WorktreeNames lists a workspace's worktree names in declaration order.
func WorktreeNames(ws *Workspace) []string {
	names := make([]string, 0, len(ws.Worktrees))
	for _, wt := range ws.Worktrees {
		names = append(names, wt.Name)
	}
	return names
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
		wtDir := WorktreePath(Ref{Workspace: wsName}, projName)
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
	dev.StopAll(dev.Slug(name))
	dev.StopProxyIfIdle()
	os.Remove(PromptFilePath(Ref{Workspace: name}))
	os.Remove(legacyNoTeamsPromptFilePath(name))

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
	wtDir := WorktreePath(Ref{Workspace: wsName}, wp.Name)

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
