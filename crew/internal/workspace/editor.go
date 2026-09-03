package workspace

import (
	"fmt"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/exec"
)

// ClaudeTaskFor builds the editor's Claude task for a worktree. It mirrors
// buildClaudeParts, which does the same job for the terminal launch mode — the
// two must agree on working directory and exposed directories.
func ClaudeTaskFor(res *Resolved) *exec.ClaudeTask {
	claude := &exec.ClaudeTask{
		LeadPath:        res.Projects[0].Path,
		SkipPermissions: true,
	}
	if config.UserSetClaudeConfig {
		claude.ClaudeConfigDir = config.ClaudeConfigDir
	}

	if res.MultiProject() {
		claude.LeadPath = res.Dir
		for _, p := range res.Projects {
			claude.AddDirs = append(claude.AddDirs, p.Path)
		}
	}
	if NeedsPrompt(res) {
		claude.PromptFile = PromptFilePath(res.Ref)
	}
	return claude
}

// EditorRemotePath returns the path an editor should open for a worktree: the
// single project's directory, or a generated .code-workspace listing them all.
//
// claude is attached to the generated workspace file when non-nil; the CLI's
// remote-open path passes nil because it only produces a link.
func EditorRemotePath(res *Resolved, claude *exec.ClaudeTask) (string, error) {
	if len(res.Projects) == 0 {
		return "", fmt.Errorf("workspace '%s' has no projects", res.Ref)
	}
	if !res.MultiProject() {
		return res.Projects[0].Path, nil
	}

	projects := make([]exec.WorkspaceProject, len(res.Projects))
	for i, p := range res.Projects {
		projects[i] = exec.WorkspaceProject{Name: p.Name, Path: p.Path}
	}

	wsFile := CodeWorkspaceFilePath(res.Ref)
	if err := exec.GenerateCodeWorkspace(wsFile, projects, claude); err != nil {
		return "", err
	}
	return wsFile, nil
}

// EditorLinks renders OSC 8 hyperlinks that open the worktree over SSH remote
// in each supported editor.
func EditorLinks(res *Resolved, sshHost string) (string, error) {
	remotePath, err := EditorRemotePath(res, nil)
	if err != nil {
		return "", err
	}

	var b strings.Builder
	for _, ed := range []struct{ name, scheme string }{
		{"cursor", "cursor://"},
		{"vscode", "vscode://"},
	} {
		uri := ed.scheme + "vscode-remote/ssh-remote+" + sshHost + remotePath
		display := ed.name + " → " + res.Ref.String()
		fmt.Fprintf(&b, "\033]8;;%s\033\\%s\033]8;;\033\\\n", uri, display)
	}
	return b.String(), nil
}
