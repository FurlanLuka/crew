package workspace

import (
	"path/filepath"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

// WorktreeDir returns the directory holding one worktree's project checkouts.
// A ref with no worktree is the pre-nesting layout, where the workspace
// directory holds the checkouts directly.
func WorktreeDir(ref Ref) string {
	if ref.Worktree == "" {
		return filepath.Join(config.WorkspacesDir, ref.Workspace)
	}
	return filepath.Join(config.WorkspacesDir, ref.Workspace, ref.Worktree)
}

// WorktreePath returns the checkout directory for one project in one worktree.
// This is a pure path helper; it does not check whether the project is in
// worktree mode. Resolve gives you the path already decided.
func WorktreePath(ref Ref, projName string) string {
	return filepath.Join(WorktreeDir(ref), projName)
}

// WorkspaceDir returns the root directory for a workspace.
func WorkspaceDir(wsName string) string {
	return filepath.Join(config.WorkspacesDir, wsName)
}

// PromptFilePath returns the path for the workspace's prompt file.
func PromptFilePath(ref Ref) string {
	return filepath.Join(config.ConfigDir, "prompt-"+string(ref.Slug())+".md")
}

// legacyNoTeamsPromptFilePath is the prompt path crew wrote while teams and
// no-teams launch modes coexisted. Kept only so Remove still cleans up files
// left on disk by older versions; drop it after a release or two.
func legacyNoTeamsPromptFilePath(wsName string) string {
	return filepath.Join(config.ConfigDir, "prompt-"+wsName+"-noteams.md")
}

// CodeWorkspaceFilePath returns the .code-workspace file path.
func CodeWorkspaceFilePath(ref Ref) string {
	return filepath.Join(config.ConfigDir, string(ref.Slug())+".code-workspace")
}
