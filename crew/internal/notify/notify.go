package notify

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

func hookScriptPath() string {
	return filepath.Join(config.ClaudeConfigDir, "hooks", "crew-ntfy.sh")
}

func settingsPath() string {
	return filepath.Join(config.ClaudeConfigDir, "settings.json")
}

// ExtractTopic reads the ntfy topic from the hook script.
func ExtractTopic() string {
	data, err := os.ReadFile(hookScriptPath())
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, `NTFY_TOPIC="`) {
			return strings.Trim(strings.TrimPrefix(line, `NTFY_TOPIC=`), `"`)
		}
	}
	return ""
}

// GenerateTopic generates a random ntfy topic.
func GenerateTopic() string {
	b := make([]byte, 4)
	rand.Read(b)
	return "crew-" + hex.EncodeToString(b)
}

// Setup writes the hook script and updates settings.json.
func Setup(topic string) error {
	script := hookScript(topic)
	dir := filepath.Dir(hookScriptPath())
	os.MkdirAll(dir, 0o755)
	if err := os.WriteFile(hookScriptPath(), []byte(script), 0o755); err != nil {
		return err
	}
	return updateSettings(true)
}

// RemoveHook removes the hook script and cleans settings.
func RemoveHook() error {
	os.Remove(hookScriptPath())
	return updateSettings(false)
}

// TestNotification sends a test notification.
func TestNotification(topic string) error {
	req, err := http.NewRequest("POST", "https://ntfy.sh/"+topic, strings.NewReader("Test: Claude is waiting for input"))
	if err != nil {
		return err
	}
	req.Header.Set("Title", "Claude idle — test")
	req.Header.Set("Tags", "white_check_mark")
	req.Header.Set("Priority", "default")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return fmt.Errorf("ntfy returned %d", resp.StatusCode)
	}
	return nil
}

func hookScript(topic string) string {
	return `#!/usr/bin/env bash
NTFY_TOPIC="` + topic + `"

INPUT=$(cat)
TYPE=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('notification_type',''))" 2>/dev/null)
MSG=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('message',''))" 2>/dev/null)
CWD=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('cwd',''))" 2>/dev/null)
PROJECT=$(basename "$CWD")

case "$TYPE" in
  idle_prompt)       TITLE="Claude idle — $PROJECT"; TAGS="white_check_mark"; PRIO="default" ;;
  permission_prompt) TITLE="Permission needed — $PROJECT"; TAGS="lock"; PRIO="high" ;;
  auth_success)      TITLE="Auth success — $PROJECT"; TAGS="key"; PRIO="low" ;;
  elicitation_dialog) TITLE="Input needed — $PROJECT"; TAGS="question"; PRIO="high" ;;
  *)                 TITLE="Claude — $PROJECT"; TAGS="bell"; PRIO="default" ;;
esac

curl -sf \
  -H "Title: $TITLE" \
  -H "Tags: $TAGS" \
  -H "Priority: $PRIO" \
  -d "$MSG" \
  "ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1

exit 0
`
}

func updateSettings(add bool) error {
	os.MkdirAll(config.ClaudeConfigDir, 0o755)

	path := settingsPath()
	var settings map[string]interface{}

	data, err := os.ReadFile(path)
	if err == nil {
		json.Unmarshal(data, &settings)
	}
	if settings == nil {
		settings = make(map[string]interface{})
	}

	hooks, _ := settings["hooks"].(map[string]interface{})
	if hooks == nil {
		hooks = make(map[string]interface{})
	}

	notifHooks, _ := hooks["Notification"].([]interface{})

	// Remove existing crew-ntfy hooks
	filtered := make([]interface{}, 0)
	for _, h := range notifHooks {
		hMap, ok := h.(map[string]interface{})
		if !ok {
			filtered = append(filtered, h)
			continue
		}
		hooksList, _ := hMap["hooks"].([]interface{})
		isCrewHook := false
		for _, hk := range hooksList {
			hkMap, ok := hk.(map[string]interface{})
			if !ok {
				continue
			}
			cmd, _ := hkMap["command"].(string)
			if strings.Contains(cmd, "crew-ntfy.sh") || strings.Contains(cmd, "ntfy.sh/") {
				isCrewHook = true
				break
			}
		}
		if !isCrewHook {
			filtered = append(filtered, h)
		}
	}

	if add {
		entry := map[string]interface{}{
			"hooks": []interface{}{
				map[string]interface{}{
					"type":    "command",
					"command": hookScriptPath(),
				},
			},
		}
		filtered = append(filtered, entry)
	}

	if len(filtered) > 0 {
		hooks["Notification"] = filtered
	} else {
		delete(hooks, "Notification")
	}

	if len(hooks) > 0 {
		settings["hooks"] = hooks
	} else {
		delete(settings, "hooks")
	}

	out, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(out, '\n'), 0o644)
}
