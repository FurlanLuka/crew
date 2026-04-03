package exec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEditorProcessName(t *testing.T) {
	tests := []struct {
		editor string
		want   string
	}{
		{"cursor", "Cursor"},
		{"code", "Code"},
		{"unknown", ""},
		{"", ""},
	}

	for _, tt := range tests {
		t.Run(tt.editor, func(t *testing.T) {
			got := EditorProcessName(tt.editor)
			if got != tt.want {
				t.Errorf("EditorProcessName(%q) = %q, want %q", tt.editor, got, tt.want)
			}
		})
	}
}

func TestGenerateCodeWorkspace_NoClaude(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "test.code-workspace")
	projects := []WorkspaceProject{
		{Name: "api", Path: "/tmp/api"},
		{Name: "web", Path: "/tmp/web"},
	}

	if err := GenerateCodeWorkspace(filePath, projects, nil); err != nil {
		t.Fatalf("GenerateCodeWorkspace: %v", err)
	}

	ws := readWorkspace(t, filePath)

	folders := ws["folders"].([]interface{})
	if len(folders) != 2 {
		t.Errorf("folders = %d, want 2", len(folders))
	}

	tasks := ws["tasks"].(map[string]interface{})
	taskList, _ := tasks["tasks"].([]interface{})
	if len(taskList) != 0 {
		t.Errorf("tasks = %d, want 0 (no claude, no terminals)", len(taskList))
	}
}

func TestGenerateCodeWorkspace_ClaudeSingleProject(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "single.code-workspace")
	projects := []WorkspaceProject{{Name: "api", Path: "/tmp/api"}}

	claude := &ClaudeTask{LeadPath: "/tmp/api"}

	if err := GenerateCodeWorkspace(filePath, projects, claude); err != nil {
		t.Fatalf("GenerateCodeWorkspace: %v", err)
	}

	ws := readWorkspace(t, filePath)
	tasks := ws["tasks"].(map[string]interface{})
	taskList := tasks["tasks"].([]interface{})

	if len(taskList) != 1 {
		t.Fatalf("tasks = %d, want 1", len(taskList))
	}

	task := taskList[0].(map[string]interface{})
	cmd := task["command"].(string)

	if strings.Contains(cmd, "AGENT_TEAMS") {
		t.Error("single-project should not have agent teams")
	}
	if strings.Contains(cmd, "--add-dir") {
		t.Error("single-project should not have --add-dir")
	}
	if strings.Contains(cmd, "--teammate-mode") {
		t.Error("single-project should not have --teammate-mode")
	}
}

func TestGenerateCodeWorkspace_ClaudeMultiProject(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "multi.code-workspace")
	projects := []WorkspaceProject{
		{Name: "api", Path: "/tmp/api"},
		{Name: "web", Path: "/tmp/web"},
	}

	claude := &ClaudeTask{
		LeadPath:   "/tmp/ws",
		PromptFile: "/tmp/prompt.md",
		AgentTeams: true,
	}

	if err := GenerateCodeWorkspace(filePath, projects, claude); err != nil {
		t.Fatalf("GenerateCodeWorkspace: %v", err)
	}

	ws := readWorkspace(t, filePath)
	tasks := ws["tasks"].(map[string]interface{})
	taskList := tasks["tasks"].([]interface{})

	if len(taskList) != 1 {
		t.Fatalf("tasks = %d, want 1", len(taskList))
	}

	task := taskList[0].(map[string]interface{})
	cmd := task["command"].(string)

	if !strings.Contains(cmd, "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1") {
		t.Error("multi-project should contain AGENT_TEAMS env var")
	}
	if !strings.Contains(cmd, "--add-dir /tmp/web") {
		t.Error("multi-project should contain --add-dir for second project")
	}
	if strings.Contains(cmd, "--add-dir /tmp/api") {
		t.Error("should NOT contain --add-dir for lead project")
	}
	if !strings.Contains(cmd, "--teammate-mode") {
		t.Error("multi-project should contain --teammate-mode")
	}
}

func TestGenerateCodeWorkspace_SkipPermissions(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "yolo.code-workspace")
	projects := []WorkspaceProject{{Name: "api", Path: "/tmp/api"}}

	claude := &ClaudeTask{
		LeadPath:        "/tmp/api",
		SkipPermissions: true,
	}

	if err := GenerateCodeWorkspace(filePath, projects, claude); err != nil {
		t.Fatalf("GenerateCodeWorkspace: %v", err)
	}

	ws := readWorkspace(t, filePath)
	tasks := ws["tasks"].(map[string]interface{})
	taskList := tasks["tasks"].([]interface{})
	task := taskList[0].(map[string]interface{})
	cmd := task["command"].(string)

	if !strings.Contains(cmd, "--dangerously-skip-permissions") {
		t.Error("should contain --dangerously-skip-permissions")
	}
}

func TestGenerateCodeWorkspace_ClaudeConfigDir(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "config.code-workspace")
	projects := []WorkspaceProject{{Name: "api", Path: "/tmp/api"}}

	claude := &ClaudeTask{
		LeadPath:        "/tmp/api",
		ClaudeConfigDir: "/custom/claude",
	}

	if err := GenerateCodeWorkspace(filePath, projects, claude); err != nil {
		t.Fatalf("GenerateCodeWorkspace: %v", err)
	}

	ws := readWorkspace(t, filePath)
	tasks := ws["tasks"].(map[string]interface{})
	taskList := tasks["tasks"].([]interface{})
	task := taskList[0].(map[string]interface{})
	cmd := task["command"].(string)

	if !strings.Contains(cmd, "CLAUDE_CONFIG_DIR='/custom/claude'") {
		t.Errorf("should contain CLAUDE_CONFIG_DIR, got: %s", cmd)
	}
}

func readWorkspace(t *testing.T, path string) map[string]interface{} {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var ws map[string]interface{}
	if err := json.Unmarshal(data, &ws); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	return ws
}
