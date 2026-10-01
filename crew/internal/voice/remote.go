package voice

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/debug"
	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

// RemoteSessionName is the tmux session a remote machine's Voice OS daemon
// runs in: the sessions it drives live as long as it does, whatever happens
// to the SSH link a main reaches it through. Under crew's dev prefix, so
// uninstall stops it with the rest. A var so tests use their own.
var RemoteSessionName = SessionName + "-remote"

// socketWait is how long _attach waits for a daemon it just started to listen.
var socketWait = 5 * time.Second

// RemoteDir is the remote daemon's own folder: this machine may have been a
// main once, and the two never share a registry, media or log.
func RemoteDir() string { return filepath.Join(Dir(), "remote") }

func RemoteSocket() string { return filepath.Join(RemoteDir(), "remote.sock") }

// RemoteQuerySocket is where a remote's crew asks the main a query through
// the daemon's link (voiceos/src/remote/cli.ts).
func RemoteQuerySocket() string { return filepath.Join(RemoteDir(), "query.sock") }

func RemoteLogFile() string { return filepath.Join(RemoteDir(), "logs", "voiceos-remote.log") }

func daemonFile() string { return filepath.Join(RemoteDir(), "daemon.json") }

// Daemon is what the running daemon writes about itself (voiceos remote serve).
type Daemon struct {
	PID       int    `json:"pid"`
	Version   string `json:"version"`
	Busy      bool   `json:"busy"`
	StartedAt string `json:"started_at"`
}

type RemoteStatus struct {
	Running   bool   `json:"running"`
	PID       int    `json:"pid"`
	Version   string `json:"version"`
	Installed string `json:"installed"`
	// Busy: a Claude session is working (a restart would end its turn; it resumes after).
	Busy   bool   `json:"busy"`
	Socket string `json:"socket"`
}

func readDaemon() Daemon {
	var d Daemon
	data, err := os.ReadFile(daemonFile())
	if err != nil {
		return d
	}
	if err := json.Unmarshal(data, &d); err != nil {
		debug.Log("voice", "daemon.json unreadable: %v", err)
	}
	return d
}

// InspectRemote reports the remote daemon on this machine.
func InspectRemote() RemoteStatus {
	d := readDaemon()
	st := RemoteStatus{
		Running:   crewExec.TmuxSessionExists(RemoteSessionName),
		Installed: installedVersion(),
		Socket:    RemoteSocket(),
	}
	if st.Running {
		st.PID, st.Version, st.Busy = d.PID, d.Version, d.Busy
	}
	return st
}

// CockpitRunning: this machine runs Voice OS as a main. A machine is a main or
// a remote, never both — two drivers on one worktree's Claude would fight.
func CockpitRunning() bool { return crewExec.TmuxSessionExists(SessionName) }

func RemoteRunning() bool { return crewExec.TmuxSessionExists(RemoteSessionName) }

// DaemonAction is what ensuring the daemon does. Pure.
type DaemonAction string

const (
	DaemonStart   DaemonAction = "start"
	DaemonKeep    DaemonAction = "keep"
	DaemonRestart DaemonAction = "restart"
)

func normalizeVersion(v string) string { return strings.TrimPrefix(strings.TrimSpace(v), "v") }

// DecideDaemon picks the action: a daemon of another release than the one
// installed restarts at once — its sessions resume on the new release, and a
// main of the new release cannot attach to the old one. A plain dev build or a
// missing stamp is unknown and never forces one; a pushed "dev-<sha>" build is
// exact, so it replaces a daemon of any other version. Pure.
func DecideDaemon(running bool, runningVersion, installed string) DaemonAction {
	if !running {
		return DaemonStart
	}
	have, want := normalizeVersion(runningVersion), normalizeVersion(installed)
	if have == "" || want == "" || have == "dev" || want == "dev" || have == want {
		return DaemonKeep
	}
	return DaemonRestart
}

// RemoteSpec is what the daemon is started with.
type RemoteSpec struct {
	Binary    string
	CrewBin   string
	Home      string
	ClaudeBin string
}

// RemoteCommand is the line the daemon's tmux session runs; HOME, CREW_BIN and
// VOICEOS_CLAUDE_BIN for the same reasons as Command. Pure.
func RemoteCommand(spec RemoteSpec) string {
	parts := envPrelude(spec.Home, spec.CrewBin)
	if spec.ClaudeBin != "" {
		parts = append(parts, "VOICEOS_CLAUDE_BIN="+crewExec.ShellQuote(spec.ClaudeBin))
	}
	parts = append(parts, crewExec.ShellQuote(spec.Binary), "remote", "serve")
	return strings.Join(parts, " ")
}

// EnsureRemote starts, keeps or restarts the daemon (DecideDaemon) and waits
// until it listens.
func EnsureRemote() (DaemonAction, error) {
	st := InspectRemote()
	action := DecideDaemon(st.Running, st.Version, st.Installed)
	debug.Log("voice", "remote daemon: %s (running %q, installed %q, busy %v)", action, st.Version, st.Installed, st.Busy)
	switch action {
	case DaemonKeep:
		return action, nil
	case DaemonRestart:
		StopRemote()
	}
	if err := os.MkdirAll(RemoteDir(), 0o700); err != nil {
		return action, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		debug.Log("voice", "no home dir: %v", err)
	}
	crewBin, err := crewExec.CrewBinary()
	if err != nil {
		crewBin = "crew"
	}
	// What a daemon that died left behind would read as this one already listening.
	os.Remove(RemoteSocket())
	os.Remove(daemonFile())
	cmd := RemoteCommand(RemoteSpec{Binary: Binary(), CrewBin: crewBin, Home: home, ClaudeBin: ClaudeBin()})
	debug.Log("voice", "remote start → %s", cmd)
	if err := crewExec.TmuxRunInSession(RemoteSessionName, "voiceos", home, cmd); err != nil {
		return action, fmt.Errorf("failed to start the remote session: %w", err)
	}
	deadline := time.Now().Add(socketWait)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(RemoteSocket()); err == nil && readDaemon().PID > 0 {
			return action, nil
		}
		if !RemoteRunning() {
			return action, fmt.Errorf("the remote daemon exited during start — see %s", RemoteLogFile())
		}
		time.Sleep(100 * time.Millisecond)
	}
	return action, fmt.Errorf("the remote daemon did not listen within %s — see %s", socketWait, RemoteLogFile())
}

// StopRemote ends the daemon and every Claude session it runs.
func StopRemote() {
	debug.Log("voice", "remote stop")
	crewExec.KillTmuxSession(RemoteSessionName)
}
