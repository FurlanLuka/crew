package voice

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	osexec "os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/debug"
	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

// ErrDevPushRunning: a push is under way; a second one would race it.
var ErrDevPushRunning = errors.New("a dev push is running — crew voice dev status follows it")

// The I/O a push does on other machines. Vars, so tests run a whole push
// against fakes.
var (
	// runRemote runs a shell script on a host over SSH (a login shell, for the PATH crew needs).
	runRemote = func(host, script string) (string, error) {
		args := sshArgv(host, "sh -lc "+crewExec.ShellQuote(script))
		debug.Log("voice", "dev push: ssh %s", host)
		out, err := osexec.Command("ssh", args...).CombinedOutput()
		return string(out), describeRunError(out, err)
	}
	// copyTo puts local files into a directory on a host.
	copyTo = func(host, dir string, files ...string) error {
		args := append(scpOptions(), files...)
		args = append(args, host+":"+dir+"/")
		debug.Log("voice", "dev push: scp → %s:%s", host, dir)
		out, err := osexec.Command("scp", args...).CombinedOutput()
		return describeRunError(out, err)
	}
	// copyFrom fetches a directory from a host into a local parent directory.
	copyFrom = func(host, dir, parent string) error {
		args := append(scpOptions(), "-r", host+":"+dir, parent+"/")
		debug.Log("voice", "dev push: scp ← %s:%s", host, dir)
		out, err := osexec.Command("scp", args...).CombinedOutput()
		return describeRunError(out, err)
	}
	// runLocal runs a shell script on this machine; label is what the debug log names it.
	runLocal = func(label, script string) (string, error) {
		debug.Log("voice", "dev push: %s (here)", label)
		out, err := osexec.Command("sh", "-c", script).CombinedOutput()
		return string(out), describeRunError(out, err)
	}
	// startRunner opens the runner's tmux session; one already there means a push runs.
	startRunner = func(dir, command string) error {
		debug.Log("voice", "dev push start → %s", command)
		out, err := osexec.Command("tmux", "new-session", "-d", "-s", DevPushSession, "-c", dir, command).CombinedOutput()
		return describeRunError(out, err)
	}
)

func scpOptions() []string {
	return []string{"-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"}
}

// The last line a command printed says what went wrong.
func describeRunError(out []byte, err error) error {
	if err == nil {
		return nil
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if last := strings.TrimSpace(lines[len(lines)-1]); last != "" {
		return fmt.Errorf("%s", last)
	}
	return err
}

// DevPushTargets is every machine a push reaches with its OS and CPU: this
// main, then each remote read over SSH in parallel. One out of reach is
// skipped, never waited on.
func DevPushTargets() ([]PushMachine, error) {
	machines, err := ReadMachines()
	if err != nil {
		return nil, err
	}
	out := make([]PushMachine, len(machines)+1)
	out[0] = PushMachine{
		ID:     MainID,
		Name:   "main",
		Target: Target{GOOS: runtime.GOOS, GOARCH: runtime.GOARCH},
	}
	var wg sync.WaitGroup
	for i, m := range machines {
		wg.Add(1)
		go func(i int, m Machine) {
			defer wg.Done()
			pm := PushMachine{ID: m.ID, Name: m.Name, Host: m.Host}
			uname, err := runRemote(m.Host, "uname -sm")
			if err == nil {
				pm.Target, err = TargetFromUname(uname)
			}
			if err != nil {
				pm.Skipped = err.Error()
			}
			out[i+1] = pm
		}(i, m)
	}
	wg.Wait()
	return out, nil
}

// BuildDevPush builds crew and Voice OS from a checkout for each target into
// DevPushBuildDir(version)/<goos>_<goarch>/. Build output goes to log.
func BuildDevPush(root, version string, targets []Target, log io.Writer) (string, error) {
	dir := DevPushBuildDir(version)
	for _, t := range targets {
		out := filepath.Join(dir, t.Dir())
		if err := os.MkdirAll(out, 0o755); err != nil {
			return "", err
		}
		fmt.Fprintf(log, "Building %s for %s…\n", version, t.Dir())
		goBuild := osexec.Command("go", "build", "-trimpath",
			"-ldflags", "-s -w -X main.Version="+version, "-o", filepath.Join(out, "crew"), ".")
		goBuild.Dir = filepath.Join(root, "crew")
		goBuild.Env = append(os.Environ(), "GOOS="+t.GOOS, "GOARCH="+t.GOARCH, "CGO_ENABLED=0")
		goBuild.Stdout, goBuild.Stderr = log, log
		debug.Log("voice", "dev push: go build %s (%s)", version, t.Dir())
		if err := goBuild.Run(); err != nil {
			return "", fmt.Errorf("crew did not build for %s: %w", t.Dir(), err)
		}
		bunBuild := osexec.Command("bun", "scripts/build-dev.ts", t.Bun(), version, filepath.Join(out, "voiceos"))
		bunBuild.Dir = filepath.Join(root, "voiceos")
		bunBuild.Stdout, bunBuild.Stderr = log, log
		debug.Log("voice", "dev push: bun build %s (%s)", version, t.Bun())
		if err := bunBuild.Run(); err != nil {
			return "", fmt.Errorf("Voice OS did not build for %s: %w", t.Dir(), err)
		}
	}
	return dir, nil
}

// CheckDevPush refuses while a push's runner still runs: asked before a build,
// so a second push never rebuilds what the first is copying.
func CheckDevPush() error {
	st, ok := ReadDevPush()
	return devPushRefusal(st, ok, crewExec.TmuxSessionExists(DevPushSession))
}

// ReadDevPushLive is the last push with Running read from its runner.
func ReadDevPushLive() (DevPushStatus, bool) {
	st, ok := ReadDevPush()
	st.Running = devPushRefusal(st, ok, crewExec.TmuxSessionExists(DevPushSession)) != nil
	return st, ok
}

// StartDevPush starts the runner on the main, detached in its own tmux session
// so restarting Voice OS or any Claude session never ends it. runner: a crew
// that knows _dev-push and stays put while it runs (the push's own build when
// the main is the source; the installed crew that took a remote's handoff).
// crewPath: where the main's crew is installed, read with the caller's PATH —
// the tmux server's may not find it.
func StartDevPush(version, source, runner, crewPath string) error {
	if err := CheckDevPush(); err != nil {
		return err
	}
	// Another push won the start race: its status is left as it is.
	if crewExec.TmuxSessionExists(DevPushSession) {
		return ErrDevPushRunning
	}
	home, _ := os.UserHomeDir()
	st := DevPushStatus{Version: version, Source: source, StartedAt: time.Now(), Phase: PhaseGather}
	if err := writeDevPush(st); err != nil {
		return err
	}
	q := crewExec.ShellQuote
	cmd := strings.Join([]string{"HOME=" + q(home), q(runner), "voice", "_dev-push", q(version), q(source), q(crewPath)}, " ")
	if err := startRunner(home, cmd); err != nil {
		if crewExec.TmuxSessionExists(DevPushSession) {
			return ErrDevPushRunning
		}
		st.Phase, st.Error = PhaseFailed, "the runner did not start: "+err.Error()
		writeDevPush(st)
		return fmt.Errorf("the push did not start: %w", err)
	}
	return nil
}

// MainCrewPath: where crew lives on this main — as PATH finds it (else
// ~/.local/bin/crew, as crew update). Read by the process that starts the push.
func MainCrewPath() string {
	if path, err := osexec.LookPath("crew"); err == nil {
		return path
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "bin", "crew")
}

// RunDevPush is the runner: gather the source's builds here, stage them on
// every machine, then swap and restart each, the source last.
func RunDevPush(version, source, crewPath string) error {
	st := DevPushStatus{Version: version, Source: source, StartedAt: time.Now(), Phase: PhaseGather}
	save := func() {
		if err := writeDevPush(st); err != nil {
			debug.Log("voice", "dev push status not written: %v", err)
		}
	}
	fail := func(err error) error {
		st.Phase, st.Error = PhaseFailed, err.Error()
		save()
		debug.Log("voice", "dev push failed: %v", err)
		return err
	}

	machines, err := DevPushTargets()
	if err != nil {
		return fail(err)
	}
	st.Machines = make([]MachineProgress, len(machines))
	for i, m := range machines {
		st.Machines[i] = MachineProgress{PushMachine: m}
	}
	save()

	local, err := gatherBuilds(machines, version, source)
	if err != nil {
		return fail(err)
	}
	// The builds are only needed until every machine has its copy.
	defer os.RemoveAll(local)

	// Phase 1: everything staged and checked before anything running changes.
	st.Phase = PhaseCopy
	save()
	for i := range st.Machines {
		m := &st.Machines[i]
		if m.Skipped != "" {
			continue
		}
		if err := stageOn(m.PushMachine, version, filepath.Join(local, m.Target.Dir())); err != nil {
			m.Error = err.Error()
			cleanStaged(st.Machines, version)
			save()
			return fail(fmt.Errorf("%s: %w — nothing was installed", m.Name, err))
		}
		m.Staged = true
		save()
	}

	// Phase 2: swap and restart, in order; one that fails is reported and the rest still go.
	st.Phase = PhaseRestart
	save()
	failed := 0
	for _, id := range RestartOrder(machines, source) {
		m := findProgress(st.Machines, id)
		// Only where phase 1 staged the build: anywhere else the install has nothing to put in place.
		if m == nil || !m.Staged {
			continue
		}
		var out string
		if id == MainID {
			out, err = runLocal("install and restart", InstallScript(version, true, crewPath, Binary()))
		} else {
			out, err = runRemote(m.Host, InstallScript(version, false, "", ""))
		}
		debug.Log("voice", "dev push: %s installed (%d bytes of output)", m.Name, len(out))
		if err != nil {
			m.Error = err.Error()
			failed++
		} else {
			m.Installed = true
		}
		save()
	}
	if failed > 0 {
		return fail(fmt.Errorf("%d machine(s) did not take %s", failed, version))
	}
	st.Phase = PhaseDone
	save()
	return nil
}

func findProgress(list []MachineProgress, id string) *MachineProgress {
	for i := range list {
		if list[i].ID == id {
			return &list[i]
		}
	}
	return nil
}

// gatherBuilds puts the source's builds on this main: a remote source's are
// fetched over SSH from where every push builds (the main reaches every remote;
// a remote may not reach the others, and never names the dir itself).
func gatherBuilds(machines []PushMachine, version, source string) (string, error) {
	local := DevPushBuildDir(version)
	if source == MainID {
		return local, nil
	}
	var host string
	for _, m := range machines {
		if m.ID == source {
			host = m.Host
		}
	}
	if host == "" {
		return "", fmt.Errorf("no machine %q to take the build from", source)
	}
	if err := os.MkdirAll(filepath.Dir(local), 0o755); err != nil {
		return "", err
	}
	os.RemoveAll(local)
	if err := copyFrom(host, remoteBuildDir(version), filepath.Dir(local)); err != nil {
		return "", fmt.Errorf("fetching the build from %s: %w", source, err)
	}
	// Fetched: the source's own copy is not needed again.
	runRemote(host, "rm -rf \"$HOME\"/"+crewExec.ShellQuote(remoteBuildDir(version)))
	return local, nil
}

// cleanStaged removes what a stopped push staged, wherever it got to — the
// machine whose copy failed included, its partial copy with it.
func cleanStaged(machines []MachineProgress, version string) {
	for _, m := range machines {
		if !m.Staged && m.Error == "" {
			continue
		}
		if m.ID == MainID {
			runLocal("clean staged", CleanStagedScript(version))
		} else {
			runRemote(m.Host, CleanStagedScript(version))
		}
	}
}

// stageOn copies a target's two files to the machine's staged dir and checks
// they arrived whole.
func stageOn(m PushMachine, version, from string) error {
	files := []string{filepath.Join(from, "crew"), filepath.Join(from, "voiceos")}
	want := map[string]string{}
	for _, f := range files {
		sum, err := fileSHA256(f)
		if err != nil {
			return fmt.Errorf("no %s build: %w", m.Target.Dir(), err)
		}
		want[filepath.Base(f)] = sum
	}
	staged := StagedDir(version)
	var out string
	var err error
	if m.ID == MainID {
		home, _ := os.UserHomeDir()
		dir := filepath.Join(home, staged)
		q := crewExec.ShellQuote
		_, err = runLocal("stage", "mkdir -p "+q(dir)+" && cp "+q(files[0])+" "+q(files[1])+" "+q(dir)+"/")
		if err == nil {
			out, err = runLocal("checksum", RemoteChecksumScript(version))
		}
	} else {
		if _, err = runRemote(m.Host, "mkdir -p \"$HOME\"/"+crewExec.ShellQuote(staged)); err == nil {
			if err = copyTo(m.Host, staged, files...); err == nil {
				out, err = runRemote(m.Host, RemoteChecksumScript(version))
			}
		}
	}
	if err != nil {
		return err
	}
	got := ParseChecksums(out)
	for _, name := range []string{"crew", "voiceos"} {
		if got[name] != want[name] {
			return fmt.Errorf("%s arrived damaged", name)
		}
	}
	return nil
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
