package exec

import (
	"encoding/json"
	"os"
	"path/filepath"
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

	err := GenerateCodeWorkspace(filePath, projects)
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
	// 2 project terminal tasks (no agent task — Claude runs in tmux)
	if len(taskList) != 2 {
		t.Errorf("tasks = %d, want 2", len(taskList))
	}
}

func TestGenerateCodeWorkspace_SingleProject(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "single.code-workspace")
	projects := []WorkspaceProject{{Name: "api", Path: "/tmp/api"}}

	if err := GenerateCodeWorkspace(filePath, projects); err != nil {
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

	folders := ws["folders"].([]interface{})
	if len(folders) != 1 {
		t.Errorf("folders = %d, want 1", len(folders))
	}

	tasks := ws["tasks"].(map[string]interface{})
	taskList := tasks["tasks"].([]interface{})
	if len(taskList) != 1 {
		t.Errorf("tasks = %d, want 1", len(taskList))
	}

	task := taskList[0].(map[string]interface{})
	if task["label"] != "api" {
		t.Errorf("task label = %q, want %q", task["label"], "api")
	}
}

func TestGenerateCodeWorkspace_TerminalPerProject(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "terminals.code-workspace")
	projects := []WorkspaceProject{
		{Name: "api", Path: "/tmp/api"},
		{Name: "web", Path: "/tmp/web"},
		{Name: "worker", Path: "/tmp/worker"},
	}

	if err := GenerateCodeWorkspace(filePath, projects); err != nil {
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
	if len(taskList) != 3 {
		t.Errorf("tasks = %d, want 3", len(taskList))
	}

	for i, name := range []string{"api", "web", "worker"} {
		task := taskList[i].(map[string]interface{})
		if task["label"] != name {
			t.Errorf("task[%d] label = %q, want %q", i, task["label"], name)
		}
	}
}
