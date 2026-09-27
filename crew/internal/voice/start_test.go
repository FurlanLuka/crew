package voice

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// isolate points crew at a temp config dir and a test-only tmux session and
// proxy, so Start and Stop never touch a real Voice OS or dev proxy.
func isolate(t *testing.T) string {
	t.Helper()
	if !crewExec.HasTmux() {
		t.Skip("tmux not available")
	}
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not available for the fake Voice OS")
	}
	tmp := t.TempDir()
	prevConfig, prevSession, prevProxy, prevBin := config.ConfigDir, SessionName, dev.ProxySessionName, crewExec.CrewBinary
	config.ConfigDir = tmp
	name := fmt.Sprintf("crew-test-voice-%d-%s", os.Getpid(), strings.ToLower(t.Name()))
	SessionName = name
	dev.ProxySessionName = fmt.Sprintf("crew-test-proxy-voice-%d-%s", os.Getpid(), strings.ToLower(t.Name()))
	crewExec.CrewBinary = func() (string, error) { return "/usr/bin/true", nil }
	t.Cleanup(func() {
		crewExec.KillTmuxSession(SessionName)
		crewExec.KillTmuxSession(dev.ProxySessionName)
		config.ConfigDir, SessionName, dev.ProxySessionName, crewExec.CrewBinary = prevConfig, prevSession, prevProxy, prevBin
	})
	return tmp
}

// fakeBinary is a stand-in Voice OS: it answers /healthz on $PORT, or exits
// at once when exitImmediately is set.
func fakeBinary(t *testing.T, exitImmediately bool) {
	t.Helper()
	// Its own directory: a file named voiceos in the config dir would sit
	// exactly where Voice OS keeps its state directory.
	dir := t.TempDir()
	serve := filepath.Join(dir, "serve")
	os.MkdirAll(serve, 0o755)
	os.WriteFile(filepath.Join(serve, "healthz"), []byte("ok"), 0o644)
	script := fmt.Sprintf("#!/bin/sh\ncd %q && exec python3 -m http.server \"$PORT\" --bind 127.0.0.1\n", serve)
	if exitImmediately {
		script = "#!/bin/sh\nexit 3\n"
	}
	bin := filepath.Join(dir, "voiceos")
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CREW_VOICEOS_BIN", bin)
}

func TestStartStop(t *testing.T) {
	isolate(t)
	fakeBinary(t, false)

	st, err := Start()
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !st.Healthy || st.Port == 0 || !strings.Contains(st.LocalhostURL, fmt.Sprintf("localhost:%d", st.Port)) {
		t.Fatalf("Start status = %+v, want running on a port", st)
	}
	routes, _ := dev.LoadRoutes(dev.Slug(workspace.VoiceSlug))
	if len(routes) != 1 || routes[0].InternalPort != st.Port || routes[0].ServerName != RouteServer {
		t.Errorf("route = %+v, want voice on port %d", routes, st.Port)
	}

	again, err := Start()
	if err != nil || again.Port != st.Port {
		t.Errorf("second Start = %+v, %v; want the running instance on port %d", again, err, st.Port)
	}

	Stop()
	if crewExec.TmuxSessionExists(SessionName) {
		t.Error("session still exists after Stop")
	}
	if routes, _ := dev.LoadRoutes(dev.Slug(workspace.VoiceSlug)); len(routes) != 0 {
		t.Errorf("route still recorded after Stop: %+v", routes)
	}
}

func TestStartWithoutBinaryNamesTheInstallStep(t *testing.T) {
	isolate(t)
	t.Setenv("CREW_VOICEOS_BIN", filepath.Join(t.TempDir(), "missing"))

	_, err := Start()
	if err == nil || !strings.Contains(err.Error(), "bun run install-dev") {
		t.Fatalf("Start error = %v, want one naming bun run install-dev", err)
	}
}

func TestStartReportsABinaryThatExits(t *testing.T) {
	isolate(t)
	fakeBinary(t, true)

	_, err := Start()
	if err == nil || !strings.Contains(err.Error(), "exited during start") {
		t.Fatalf("Start error = %v, want exited during start", err)
	}
}
