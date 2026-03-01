package notify

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/homebrew-tap/crew/internal/config"
)

func setupTestConfig(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	config.ConfigDir = tmp
	config.WorkspacesDir = filepath.Join(tmp, "workspaces")
	config.ClaudeConfigDir = filepath.Join(tmp, "claude")
	os.MkdirAll(config.WorkspacesDir, 0o755)
	os.MkdirAll(config.ClaudeConfigDir, 0o755)
	return tmp
}

func TestGenerateTopic(t *testing.T) {
	topic := GenerateTopic()

	if !strings.HasPrefix(topic, "crew-") {
		t.Errorf("topic %q should start with 'crew-'", topic)
	}
	// "crew-" (5) + 8 hex chars = 13
	if len(topic) != 13 {
		t.Errorf("topic length = %d, want 13", len(topic))
	}

	// Verify hex suffix
	suffix := topic[5:]
	for _, c := range suffix {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			t.Errorf("topic suffix %q contains non-hex char %c", suffix, c)
		}
	}
}

func TestGenerateTopic_Unique(t *testing.T) {
	t1 := GenerateTopic()
	t2 := GenerateTopic()
	if t1 == t2 {
		t.Errorf("two GenerateTopic calls returned same value: %q", t1)
	}
}

func TestExtractTopic(t *testing.T) {
	setupTestConfig(t)

	topic := "crew-abcd1234"
	script := hookScript(topic)

	dir := filepath.Dir(hookScriptPath())
	os.MkdirAll(dir, 0o755)
	os.WriteFile(hookScriptPath(), []byte(script), 0o755)

	got := ExtractTopic()
	if got != topic {
		t.Errorf("ExtractTopic = %q, want %q", got, topic)
	}
}

func TestExtractTopic_Missing(t *testing.T) {
	setupTestConfig(t)

	got := ExtractTopic()
	if got != "" {
		t.Errorf("ExtractTopic with no file = %q, want empty", got)
	}
}

func TestIsEnabled(t *testing.T) {
	setupTestConfig(t)

	if IsEnabled() {
		t.Error("IsEnabled should be false without hook script")
	}

	script := hookScript("crew-test1234")
	dir := filepath.Dir(hookScriptPath())
	os.MkdirAll(dir, 0o755)
	os.WriteFile(hookScriptPath(), []byte(script), 0o755)

	if !IsEnabled() {
		t.Error("IsEnabled should be true with hook script")
	}
}

func TestHookScript(t *testing.T) {
	topic := "crew-deadbeef"
	script := hookScript(topic)

	if !strings.Contains(script, topic) {
		t.Error("hook script should contain the topic")
	}
	if !strings.HasPrefix(script, "#!/usr/bin/env bash") {
		t.Error("hook script should start with shebang")
	}
	if !strings.Contains(script, "case") {
		t.Error("hook script should contain case statement")
	}
}

func TestSetupAndRemove(t *testing.T) {
	setupTestConfig(t)

	topic := "crew-setup123"
	if err := Setup(topic); err != nil {
		t.Fatalf("Setup: %v", err)
	}

	// Hook script should exist
	if _, err := os.Stat(hookScriptPath()); err != nil {
		t.Error("hook script should exist after setup")
	}

	// Settings should be updated
	settingsData, err := os.ReadFile(settingsPath())
	if err != nil {
		t.Fatalf("ReadFile settings: %v", err)
	}
	if !strings.Contains(string(settingsData), "crew-ntfy.sh") {
		t.Error("settings should reference crew-ntfy.sh")
	}

	// Remove
	if err := RemoveHook(); err != nil {
		t.Fatalf("RemoveHook: %v", err)
	}

	if _, err := os.Stat(hookScriptPath()); !os.IsNotExist(err) {
		t.Error("hook script should be gone after remove")
	}

	// Settings should not contain crew hook
	settingsData, _ = os.ReadFile(settingsPath())
	if strings.Contains(string(settingsData), "crew-ntfy.sh") {
		t.Error("settings should not reference crew-ntfy.sh after remove")
	}
}

func TestUpdateSettings_PreservesExisting(t *testing.T) {
	setupTestConfig(t)

	// Write initial settings with a custom key
	initial := map[string]interface{}{
		"customKey": "customValue",
		"hooks": map[string]interface{}{
			"OtherHook": []interface{}{"something"},
		},
	}
	data, err := json.MarshalIndent(initial, "", "  ")
	if err != nil {
		t.Fatalf("MarshalIndent: %v", err)
	}
	if err := os.WriteFile(settingsPath(), data, 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	// Setup should preserve existing keys
	if err := Setup("crew-preserve1"); err != nil {
		t.Fatalf("Setup: %v", err)
	}

	settingsData, err := os.ReadFile(settingsPath())
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var settings map[string]interface{}
	if err := json.Unmarshal(settingsData, &settings); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	if settings["customKey"] != "customValue" {
		t.Error("Setup should preserve existing settings keys")
	}

	hooks, _ := settings["hooks"].(map[string]interface{})
	if hooks["OtherHook"] == nil {
		t.Error("Setup should preserve existing hooks")
	}
}
