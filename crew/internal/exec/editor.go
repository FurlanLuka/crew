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

// GenerateCodeWorkspace creates a .code-workspace file and returns its path.
// Claude runs in a separate tmux session, not as a VS Code task.
func GenerateCodeWorkspace(filePath string, projects []WorkspaceProject) error {
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

	// Terminal per project
	for _, p := range projects {
		ws.Tasks.Tasks = append(ws.Tasks.Tasks, codeWorkspaceTask{
			Label:          p.Name,
			Type:           "shell",
			Command:        "",
			Options:        map[string]string{"cwd": p.Path},
			IsBackground:   true,
			ProblemMatcher: []interface{}{},
			Presentation: map[string]interface{}{
				"group":  "terminals",
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
