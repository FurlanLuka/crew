package voice

import "testing"

func TestDecideDaemon(t *testing.T) {
	cases := []struct {
		name                      string
		running                   bool
		runningVersion, installed string
		want                      DaemonAction
	}{
		{"not running → start", false, "", "1.4.0", DaemonStart},
		{"same release → keep", true, "1.4.0", "1.4.0", DaemonKeep},
		{"a leading v is the same release", true, "1.4.0", "v1.4.0", DaemonKeep},
		{"another release → restart at once, sessions working or not", true, "1.3.0", "1.4.0", DaemonRestart},
		{"a dev build → never forced", true, "dev", "1.4.0", DaemonKeep},
		{"no stamp → never forced", true, "1.3.0", "", DaemonKeep},
	}
	for _, c := range cases {
		if got := DecideDaemon(c.running, c.runningVersion, c.installed); got != c.want {
			t.Errorf("%s: got %s, want %s", c.name, got, c.want)
		}
	}
}

func TestRemoteCommand(t *testing.T) {
	got := RemoteCommand(RemoteSpec{Binary: "/h/.crew/bin/voiceos", CrewBin: "/h/.local/bin/crew", Home: "/h", ClaudeBin: "/h/bin/claude"})
	want := "HOME='/h' CREW_BIN='/h/.local/bin/crew' VOICEOS_CLAUDE_BIN='/h/bin/claude' '/h/.crew/bin/voiceos' remote serve"
	if got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestCommandPassesTheSSHAgent(t *testing.T) {
	got := Command(LaunchSpec{Binary: "/b", CrewBin: "/c", Home: "/h", Port: 1, SSHAuthSock: "/tmp/agent.sock"})
	want := "HOME='/h' CREW_BIN='/c' PORT=1 VOICEOS_PROXY_HOST='' VOICEOS_PROXY_PORT=0 SSH_AUTH_SOCK='/tmp/agent.sock' VOICEOS_RECORD_STATE=1 '/b'"
	if got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}
