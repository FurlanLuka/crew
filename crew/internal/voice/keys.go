package voice

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/debug"
)

// Voice OS reads its API keys from files, never from the shell: an exported
// ANTHROPIC_API_KEY would switch every Claude Code session to per-token billing.
var KeyNames = []string{"anthropic", "soniox"}

// keyEnv is what Voice OS also accepts in its own environment, per key.
var keyEnv = map[string][]string{
	"anthropic": {"VOICEOS_ANTHROPIC_API_KEY"},
	"soniox":    {"SONIOX_API_KEY"},
}

var keyUse = map[string]string{
	"anthropic": "the kernel and narrator (Claude API)",
	"soniox":    "speech in and out (Soniox)",
}

// ErrKeyRejected is the service saying no: the key is wrong, not the network.
var ErrKeyRejected = errors.New("the key was rejected")

type KeyStatus struct {
	Name string `json:"name"`
	Set  bool   `json:"set"`
	// file or env; empty when not set.
	Source string `json:"source"`
	Path   string `json:"path"`
	Use    string `json:"use"`
}

// KeysDir matches Voice OS's own lookup (src/config.ts).
func KeysDir() string {
	if dir := os.Getenv("VOICEOS_KEYS_DIR"); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = os.Getenv("HOME")
	}
	return filepath.Join(home, ".config", "crew-voiceos")
}

func KeyPath(name string) string { return filepath.Join(KeysDir(), name+".key") }

func IsKeyName(name string) bool {
	for _, known := range KeyNames {
		if name == known {
			return true
		}
	}
	return false
}

func readKey(name string) string {
	data, err := os.ReadFile(KeyPath(name))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func InspectKeys() []KeyStatus {
	statuses := make([]KeyStatus, 0, len(KeyNames))
	for _, name := range KeyNames {
		st := KeyStatus{Name: name, Path: KeyPath(name), Use: keyUse[name]}
		switch {
		case readKey(name) != "":
			st.Set, st.Source = true, "file"
		case envKey(name) != "":
			st.Set, st.Source = true, "env"
		}
		statuses = append(statuses, st)
	}
	return statuses
}

func envKey(name string) string {
	for _, variable := range keyEnv[name] {
		if value := os.Getenv(variable); value != "" {
			return value
		}
	}
	return ""
}

// MissingKeys names the keys Voice OS would start without.
func MissingKeys() []string {
	var missing []string
	for _, st := range InspectKeys() {
		if !st.Set {
			missing = append(missing, st.Name)
		}
	}
	return missing
}

// SaveKey writes the key readable by its owner only; the directory likewise.
// The optional Discord token goes through it too, without being one of KeyNames.
func SaveKey(name, value string) error {
	value = strings.TrimSpace(value)
	if !IsKeyName(name) && name != DiscordKey {
		return fmt.Errorf("unknown key %q (want %s)", name, strings.Join(KeyNames, " or "))
	}
	if value == "" {
		return errors.New("the key is empty")
	}
	if err := os.MkdirAll(KeysDir(), 0o700); err != nil {
		return err
	}
	debug.Log("voice", "save %s key to %s", name, KeyPath(name))
	return os.WriteFile(KeyPath(name), []byte(value+"\n"), 0o600)
}

// keyCheckURL is a var so tests point the check at a local server.
var keyCheckURL = map[string]string{
	"anthropic": "https://api.anthropic.com/v1/models?limit=1",
	"soniox":    "https://api.soniox.com/v1/models",
}

var keyCheckClient = &http.Client{Timeout: 10 * time.Second}

// CheckKey asks the service whether it takes the key. Only a 401 or 403 is
// ErrKeyRejected; anything else (offline, an outage) is a plain error, so the
// caller can keep a key it could not verify.
func CheckKey(name, value string) error {
	req, err := http.NewRequest(http.MethodGet, keyCheckURL[name], nil)
	if err != nil {
		return err
	}
	switch name {
	case "anthropic":
		req.Header.Set("x-api-key", value)
		req.Header.Set("anthropic-version", "2023-06-01")
	case "soniox":
		req.Header.Set("Authorization", "Bearer "+value)
	}
	// The key itself is never logged.
	debug.Log("voice", "check %s key: GET %s", name, keyCheckURL[name])
	resp, err := keyCheckClient.Do(req)
	if err != nil {
		debug.Log("voice", "check %s key: %v", name, err)
		return err
	}
	defer resp.Body.Close()
	debug.Log("voice", "check %s key: %d", name, resp.StatusCode)
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return ErrKeyRejected
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return nil
	default:
		return fmt.Errorf("could not verify: %s answered %d", name, resp.StatusCode)
	}
}

// SaveChecked keeps a key the service accepts, or one it could not be asked
// about (offline, an outage): verified says which. A rejected key is not
// written — ErrKeyRejected.
func SaveChecked(name, value string) (verified bool, err error) {
	value = strings.TrimSpace(value)
	checkErr := CheckKey(name, value)
	if errors.Is(checkErr, ErrKeyRejected) {
		return false, checkErr
	}
	if err := SaveKey(name, value); err != nil {
		return false, err
	}
	return checkErr == nil, nil
}
