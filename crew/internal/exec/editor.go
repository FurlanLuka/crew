package exec

import (
	"encoding/json"
	"os"
	"os/exec"

	"github.com/FurlanLuka/crew/crew/internal/debug"
)

// DetectEditor returns "cursor", "code", or "" based on available editors.
func DetectEditor() string {
	if _, err := exec.LookPath("cursor"); err == nil {
		return "cursor"
	}
	if _, err := exec.LookPath("code"); err == nil {
		return "code"
	}
	return ""
}

// EditorProcessName returns the process name for AppleScript.
func EditorProcessName(editor string) string {
	switch editor {
	case "cursor":
		return "Cursor"
	case "code":
		return "Code"
	}
	return ""
}

type codeWorkspaceFolder struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

type codeWorkspaceTask struct {
	Label          string                 `json:"label"`
	Type           string                 `json:"type"`
	Command        string                 `json:"command"`
	Options        map[string]string      `json:"options,omitempty"`
	IsBackground   bool                   `json:"isBackground"`
	ProblemMatcher []interface{}          `json:"problemMatcher"`
	Presentation   map[string]interface{} `json:"presentation,omitempty"`
	RunOptions     map[string]string      `json:"runOptions,omitempty"`
}

type codeWorkspace struct {
	Folders  []codeWorkspaceFolder `json:"folders"`
	Settings map[string]string     `json:"settings"`
	Tasks    struct {
		Version string              `json:"version"`
		Tasks   []codeWorkspaceTask `json:"tasks"`
	} `json:"tasks"`
}

type WorkspaceProject struct {
	Name string
	Path string
}

// ClaudeTask configures the Claude task in the .code-workspace file.
// Nil means no Claude task. For single-project, set AgentTeams=false.
type ClaudeTask struct {
	PromptFile      string // Path to prompt file (required for agent teams)
	LeadPath        string // Working directory for Claude
	ClaudeConfigDir string // Custom CLAUDE_CONFIG_DIR (empty = default)
	AgentTeams      bool   // Enable agent teams (multi-project)
	SkipPermissions bool   // Add --dangerously-skip-permissions
}

// GenerateCodeWorkspace creates a .code-workspace file.
// Pass a non-nil ClaudeTask to include a Claude terminal task that auto-runs on open.
func GenerateCodeWorkspace(filePath string, projects []WorkspaceProject, claude *ClaudeTask) error {
	ws := codeWorkspace{
		Settings: map[string]string{
			"task.allowAutomaticTasks": "on",
		},
	}
	ws.Tasks.Version = "2.0.0"

	for _, p := range projects {
		ws.Folders = append(ws.Folders, codeWorkspaceFolder{
			Path: p.Path,
			Name: p.Name,
		})
	}

	if claude != nil {
		var parts []string

		if claude.SkipPermissions {
			parts = append(parts, "IS_SANDBOX=1")
		}

		if claude.ClaudeConfigDir != "" {
			parts = append(parts, "CLAUDE_CONFIG_DIR='"+claude.ClaudeConfigDir+"'")
		}

		if claude.AgentTeams {
			parts = append(parts, "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1")
		}

		parts = append(parts, "claude")

		if claude.SkipPermissions {
			parts = append(parts, "--dangerously-skip-permissions")
		}

		if claude.AgentTeams {
			for _, p := range projects[1:] {
				parts = append(parts, "--add-dir", p.Path)
			}
			if claude.PromptFile != "" {
				parts = append(parts, "--teammate-mode", "in-process", "\"$(cat "+claude.PromptFile+")\"")
			}
		}

		claudeCmd := ""
		for i, p := range parts {
			if i > 0 {
				claudeCmd += " "
			}
			claudeCmd += p
		}

		ws.Tasks.Tasks = append(ws.Tasks.Tasks, codeWorkspaceTask{
			Label:          "claude",
			Type:           "shell",
			Command:        claudeCmd,
			Options:        map[string]string{"cwd": claude.LeadPath},
			IsBackground:   true,
			ProblemMatcher: []interface{}{},
			Presentation: map[string]interface{}{
				"group":  "claude",
				"focus":  true,
				"reveal": "always",
			},
			RunOptions: map[string]string{"runOn": "folderOpen"},
		})
	}

	data, err := json.MarshalIndent(ws, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filePath, data, 0o644)
}

// OpenEditor opens a file in the detected editor.
func OpenEditor(editor, path string) error {
	debug.Log("editor", "%s -n %s", editor, path)
	cmd := exec.Command(editor, "-n", path)
	if err := cmd.Start(); err != nil {
		debug.Log("editor", "%s %s → error: %v", editor, path, err)
		return err
	}
	return nil
}

// CloseEditorWindow closes an editor window by workspace name (macOS).
func CloseEditorWindow(processName, wsName string) {
	if processName == "" {
		return
	}
	debug.Log("editor", "close window %s containing %s", processName, wsName)
	script := `tell application "System Events"
		if exists process "` + processName + `" then
			tell process "` + processName + `"
				repeat with w in (every window)
					if name of w contains "` + wsName + `" then
						click button 1 of w
					end if
				end repeat
			end tell
		end if
	end tell`
	exec.Command("osascript", "-e", script).Run()
}
