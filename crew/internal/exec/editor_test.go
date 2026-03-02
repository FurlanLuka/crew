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

func TestGenerateCodeWorkspace(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "test.code-workspace")

	projects := []WorkspaceProject{
		{Name: "api", Path: "/tmp/api"},
		{Name: "web", Path: "/tmp/web"},
	}

	err := GenerateCodeWorkspace(filePath, projects, "/tmp/prompt.md", "/tmp/api", "/custom/claude", true)
	if err != nil {
		t.Fatalf("GenerateCodeWorkspace: %v", err)
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}

	var ws map[string]interface{}
	if err := json.Unmarshal(data, &ws); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}

	folders, ok := ws["folders"].([]interface{})
	if !ok {
		t.Fatal("missing folders")
	}
	if len(folders) != 2 {
		t.Errorf("folders = %d, want 2", len(folders))
	}

	settings, ok := ws["settings"].(map[string]interface{})
	if !ok {
		t.Fatal("missing settings")
	}
	if settings["task.allowAutomaticTasks"] != "on" {
		t.Error("missing task.allowAutomaticTasks setting")
	}

	tasks, ok := ws["tasks"].(map[string]interface{})
	if !ok {
		t.Fatal("missing tasks")
	}
	taskList, ok := tasks["tasks"].([]interface{})
	if !ok {
		t.Fatal("missing tasks.tasks")
	}
	// 1 agent task + 2 project terminal tasks = 3
	if len(taskList) != 3 {
		t.Errorf("tasks = %d, want 3", len(taskList))
	}
}

func TestGenerateCodeWorkspace_WithAgents(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "agents.code-workspace")
	projects := []WorkspaceProject{{Name: "api", Path: "/tmp/api"}}

	if err := GenerateCodeWorkspace(filePath, projects, "/tmp/prompt.md", "/tmp/api", "", true); err != nil {
		t.Fatalf("GenerateCodeWorkspace: %v", err)
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var ws map[string]interface{}
	if err := json.Unmarshal(data, &ws); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	tasks, ok := ws["tasks"].(map[string]interface{})
	if !ok {
		t.Fatal("missing tasks")
	}
	taskList, ok := tasks["tasks"].([]interface{})
	if !ok {
		t.Fatal("missing tasks.tasks")
	}

	agentTask, ok := taskList[0].(map[string]interface{})
	if !ok {
		t.Fatal("first task is not a map")
	}
	if agentTask["label"] != "agents" {
		t.Errorf("first task label = %q, want %q", agentTask["label"], "agents")
	}

	cmd, _ := agentTask["command"].(string)
	if cmd == "" {
		t.Error("agent task command is empty")
	}
	if !strings.Contains(cmd, "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1") {
		t.Error("agent command should contain AGENT_TEAMS env var")
	}
	if !strings.Contains(cmd, "teammate-mode") {
		t.Error("agent command should contain teammate-mode flag")
	}
}

func TestGenerateCodeWorkspace_AddDir(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "adddir.code-workspace")
	projects := []WorkspaceProject{
		{Name: "api", Path: "/tmp/api"},
		{Name: "web", Path: "/tmp/web"},
	}

	if err := GenerateCodeWorkspace(filePath, projects, "/tmp/prompt.md", "/tmp/api", "", true); err != nil {
		t.Fatalf("GenerateCodeWorkspace: %v", err)
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var ws map[string]interface{}
	if err := json.Unmarshal(data, &ws); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	tasks := ws["tasks"].(map[string]interface{})
	taskList := tasks["tasks"].([]interface{})
	agentTask := taskList[0].(map[string]interface{})
	cmd := agentTask["command"].(string)

	if !strings.Contains(cmd, "--add-dir /tmp/web") {
		t.Errorf("agent command should contain '--add-dir /tmp/web', got: %s", cmd)
	}
	if strings.Contains(cmd, "--add-dir /tmp/api") {
		t.Error("agent command should NOT contain '--add-dir /tmp/api' (lead project is CWD)")
	}
}

func TestGenerateCodeWorkspace_AddDir_SingleProject(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "single.code-workspace")
	projects := []WorkspaceProject{{Name: "api", Path: "/tmp/api"}}

	if err := GenerateCodeWorkspace(filePath, projects, "/tmp/prompt.md", "/tmp/api", "", true); err != nil {
		t.Fatalf("GenerateCodeWorkspace: %v", err)
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var ws map[string]interface{}
	if err := json.Unmarshal(data, &ws); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	tasks := ws["tasks"].(map[string]interface{})
	taskList := tasks["tasks"].([]interface{})
	agentTask := taskList[0].(map[string]interface{})
	cmd := agentTask["command"].(string)

	if strings.Contains(cmd, "--add-dir") {
		t.Errorf("single-project workspace should not contain --add-dir, got: %s", cmd)
	}
}

func TestGenerateCodeWorkspace_NoAgents(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "no-agents.code-workspace")
	projects := []WorkspaceProject{{Name: "api", Path: "/tmp/api"}}

	if err := GenerateCodeWorkspace(filePath, projects, "/tmp/prompt.md", "/tmp/api", "", false); err != nil {
		t.Fatalf("GenerateCodeWorkspace: %v", err)
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var ws map[string]interface{}
	if err := json.Unmarshal(data, &ws); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	tasks, ok := ws["tasks"].(map[string]interface{})
	if !ok {
		t.Fatal("missing tasks")
	}
	taskList, ok := tasks["tasks"].([]interface{})
	if !ok {
		t.Fatal("missing tasks.tasks")
	}

	if len(taskList) != 1 {
		t.Errorf("tasks = %d, want 1 (no agent task)", len(taskList))
	}
	task, ok := taskList[0].(map[string]interface{})
	if !ok {
		t.Fatal("first task is not a map")
	}
	if task["label"] != "api" {
		t.Errorf("task label = %q, want %q", task["label"], "api")
	}
}
