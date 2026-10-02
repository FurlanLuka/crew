package voice

import (
	"fmt"
	"os"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

// Every test logs somewhere of its own: debug.Log writes under
// config.ConfigDir, never into the package or the real ~/.crew.
// shippedSessionNames are the package's own names, read at init — before
// TestMain points every one at a per-process name — so a test can pin what
// a released crew actually uses.
var shippedSessionNames = struct{ server, remote, legacy, legacyRemote string }{
	SessionName, RemoteSessionName, LegacySessionName, LegacyRemoteSessionName,
}

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "crew-voice-test-*")
	if err != nil {
		panic(err)
	}
	config.ConfigDir = dir
	// No test may see or stop a real server — neither name of it.
	SessionName = fmt.Sprintf("crew-test-server-%d", os.Getpid())
	LegacySessionName = fmt.Sprintf("crew-test-legacy-%d", os.Getpid())
	RemoteSessionName = SessionName + "-remote"
	LegacyRemoteSessionName = LegacySessionName + "-remote"
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}
