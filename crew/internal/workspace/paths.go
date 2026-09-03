package workspace

import (
	"path/filepath"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// WorktreePath returns the worktree directory for a project within a workspace.
// This is a pure path helper; it does not check whether the project is in
// worktree mode. Use ResolvePath when you have a WorkspaceProject in scope.
func WorktreePath(wsName, projName string) string {
	return filepath.Join(config.WorkspacesDir, wsName, projName)
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

// PromptFilePath returns the path for the workspace's prompt file.
func PromptFilePath(wsName string) string {
	return filepath.Join(config.ConfigDir, "prompt-"+wsName+".md")
}

// legacyNoTeamsPromptFilePath is the prompt path crew wrote while teams and
// no-teams launch modes coexisted. Kept only so Remove still cleans up files
// left on disk by older versions; drop it after a release or two.
func legacyNoTeamsPromptFilePath(wsName string) string {
	return filepath.Join(config.ConfigDir, "prompt-"+wsName+"-noteams.md")
}

// CodeWorkspaceFilePath returns the .code-workspace file path.
func CodeWorkspaceFilePath(wsName string) string {
	return filepath.Join(config.ConfigDir, wsName+".code-workspace")
}
