package voice

import (
	"os"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

// Every test logs somewhere of its own: debug.Log writes under
// config.ConfigDir, never into the package or the real ~/.crew.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "crew-voice-test-*")
	if err != nil {
		panic(err)
	}
	config.ConfigDir = dir
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}
