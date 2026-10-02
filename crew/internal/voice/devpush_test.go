package voice

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	osexec "os/exec"

	"encoding/json"
	"errors"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestDevVersion(t *testing.T) {
	if got := DevVersion("abc1234\n", ""); got != "dev-abc1234" {
		t.Errorf("clean: got %q", got)
	}
	// Two different dirty trees are two versions: a second push still restarts every daemon.
	if got := DevVersion("abc1234", "0a1b2c3d"); got != "dev-abc1234-dirty-0a1b2c3d" {
		t.Errorf("dirty: got %q", got)
	}
}

func TestTargetFromUname(t *testing.T) {
	cases := map[string]Target{
		"Linux x86_64\n": {GOOS: "linux", GOARCH: "amd64"},
		"Welcome to the build box!\nLinux x86_64\n": {GOOS: "linux", GOARCH: "amd64"},
		"Linux aarch64": {GOOS: "linux", GOARCH: "arm64"},
		"Darwin arm64":  {GOOS: "darwin", GOARCH: "arm64"},
		"Darwin x86_64": {GOOS: "darwin", GOARCH: "amd64"},
	}
	for in, want := range cases {
		got, err := TargetFromUname(in)
		if err != nil || got != want {
			t.Errorf("%q: got %v, %v", in, got, err)
		}
	}
	for _, bad := range []string{"FreeBSD amd64", "Linux riscv64", "", "Linux"} {
		if _, err := TargetFromUname(bad); err == nil {
			t.Errorf("%q: want an error", bad)
		}
	}
	if (Target{GOOS: "linux", GOARCH: "amd64"}).Bun() != "bun-linux-x64" {
		t.Error("amd64 is bun's x64")
	}
}

var pushMachines = []PushMachine{
	{ID: MainID, Name: "main", Target: Target{"darwin", "arm64"}},
	{ID: "vm1", Name: "Build box", Host: "vm1", Target: Target{"linux", "amd64"}},
	{ID: "personal", Name: "Personal", Host: "personal", Target: Target{"linux", "amd64"}},
	{ID: "lab", Name: "Lab", Host: "lab", Skipped: "ssh: connect timed out"},
}

func TestDistinctTargets(t *testing.T) {
	want := []Target{{"darwin", "arm64"}, {"linux", "amd64"}}
	if got := DistinctTargets(pushMachines); !reflect.DeepEqual(got, want) {
		t.Errorf("got %v", got)
	}
}

func TestRestartOrder(t *testing.T) {
	if got := RestartOrder(pushMachines, MainID); !reflect.DeepEqual(got, []string{"vm1", "personal", MainID}) {
		t.Errorf("from the main: got %v", got)
	}
	if got := RestartOrder(pushMachines, "personal"); !reflect.DeepEqual(got, []string{"vm1", MainID, "personal"}) {
		t.Errorf("from a remote: got %v", got)
	}
}

func TestInstallScript(t *testing.T) {
	want := `set -e
D="$HOME"/'.crew/dev-push-staged/dev-abc'
C=$(command -v crew 2>/dev/null || echo "$HOME/.local/bin/crew")
V="$HOME/.crew/bin/voiceos"
[ -f "$D/crew" ] && [ -f "$D/voiceos" ] || { echo "nothing staged in $D"; exit 1; }
mkdir -p "$(dirname "$C")" "$(dirname "$V")"
cp "$D/crew" "$C.new" && cp "$D/voiceos" "$V.new" && chmod 755 "$C.new" "$V.new"
if [ "$(uname)" = Darwin ]; then codesign --sign - -f "$C.new" "$V.new" >/dev/null 2>&1 || { rm -f "$C.new" "$V.new"; echo "codesign failed"; exit 1; }; fi
[ "$("$C.new" --version 2>/dev/null)" = "crew "'dev-abc' ] || { rm -f "$C.new" "$V.new"; echo "the new crew does not run here"; exit 1; }
mv -f "$C.new" "$C" && mv -f "$V.new" "$V"
printf '%s\n' 'dev-abc' > "$V.version"
rm -rf "$D"
"$C" voice remote`
	if got := InstallScript("dev-abc", false, "", ""); got != want {
		t.Errorf("remote script:\n%s\nwant:\n%s", got, want)
	}
	main := InstallScript("dev-abc", true, "/Users/dev/.local/bin/crew", "/Users/dev/.crew/bin/voiceos")
	for _, line := range []string{"C='/Users/dev/.local/bin/crew'", "V='/Users/dev/.crew/bin/voiceos'"} {
		if !strings.Contains(main, line) {
			t.Errorf("the main installs where it runs them: no %s", line)
		}
	}
	if !strings.HasSuffix(main, `"$C" voice _restart`) {
		t.Error("the main restarts its cockpit last")
	}
}

func TestParseChecksums(t *testing.T) {
	got := ParseChecksums("aa  crew\nbb *voiceos\n\n")
	if got["crew"] != "aa" || got["voiceos"] != "bb" {
		t.Errorf("got %v", got)
	}
}

// fakePush swaps the push's I/O for an in-memory one: each host's files, and
// every script and copy run, in order.
type fakePush struct {
	files       map[string][]byte // host:name → content
	ran         []string          // "host: <whole script>" or "host: copy → <dir>"
	down        map[string]bool   // out of reach from the start
	damage      string            // a host whose copy arrives damaged
	failInstall string            // a host whose install fails
}

const installMarker = `mv -f "$C.new" "$C"`

// installs is the hosts an install script ran on, in order.
func (f *fakePush) installs() []string {
	var hosts []string
	for _, r := range f.ran {
		if strings.Contains(r, installMarker) {
			hosts = append(hosts, strings.SplitN(r, ":", 2)[0])
		}
	}
	return hosts
}

func (f *fakePush) scriptOn(host, contains string) string {
	for _, r := range f.ran {
		if strings.HasPrefix(r, host+": ") && strings.Contains(r, contains) {
			return r
		}
	}
	return ""
}

func installFakePush(t *testing.T, f *fakePush) {
	t.Helper()
	savedRemote, savedTo, savedFrom, savedLocal := runRemote, copyTo, copyFrom, runLocal
	t.Cleanup(func() { runRemote, copyTo, copyFrom, runLocal = savedRemote, savedTo, savedFrom, savedLocal })
	sums := func(host string) string {
		var out strings.Builder
		for _, name := range []string{"crew", "voiceos"} {
			data := f.files[host+":"+name]
			if host == f.damage {
				data = append(append([]byte{}, data...), 'x')
			}
			sum := sha256.Sum256(data)
			out.WriteString(hex.EncodeToString(sum[:]) + "  " + name + "\n")
		}
		return out.String()
	}
	run := func(host, script string) (string, error) {
		f.ran = append(f.ran, host+": "+script)
		switch {
		case strings.Contains(script, installMarker) && host == f.failInstall:
			return "", errors.New("mv: permission denied")
		case script == "uname -sm":
			return "Linux x86_64", nil
		case strings.Contains(script, "sha256sum"):
			return sums(host), nil
		}
		return "", nil
	}
	runRemote = func(host, script string) (string, error) {
		if f.down[host] {
			return "", errors.New("ssh: connect to host " + host + ": Connection refused")
		}
		return run(host, script)
	}
	copyTo = func(host, dir string, files ...string) error {
		f.ran = append(f.ran, host+": copy → "+dir)
		for _, file := range files {
			data, err := os.ReadFile(file)
			if err != nil {
				return err
			}
			f.files[host+":"+filepath.Base(file)] = data
		}
		return nil
	}
	copyFrom = func(host, dir, parent string) error {
		return errors.New("not used here")
	}
	runLocal = func(_, script string) (string, error) {
		if strings.HasPrefix(script, "mkdir -p") {
			for _, field := range strings.Fields(script) {
				path := strings.Trim(field, "'")
				if name := filepath.Base(path); name == "crew" || name == "voiceos" {
					data, _ := os.ReadFile(path)
					f.files["main:"+name] = data
				}
			}
		}
		return run("main", script)
	}
}

func setupPush(t *testing.T, version string, remotes ...Machine) string {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	savedDir := config.ConfigDir
	config.ConfigDir = t.TempDir()
	t.Cleanup(func() { config.ConfigDir = savedDir })
	if len(remotes) == 0 {
		remotes = []Machine{{ID: "vm1", Host: "vm1", Name: "Build box"}}
	}
	machines, _ := json.Marshal(remotes)
	os.MkdirAll(filepath.Dir(MachinesFile()), 0o700)
	if err := os.WriteFile(MachinesFile(), machines, 0o600); err != nil {
		t.Fatal(err)
	}
	return writeBuilds(DevPushBuildDir(version))
}

// writeBuilds lays out a push's build dir for this Mac's target and linux_amd64.
func writeBuilds(dir string) string {
	for _, target := range []string{"linux_amd64", Target{GOOS: runtime.GOOS, GOARCH: runtime.GOARCH}.Dir()} {
		os.MkdirAll(filepath.Join(dir, target), 0o755)
		os.WriteFile(filepath.Join(dir, target, "crew"), []byte("crew "+target), 0o755)
		os.WriteFile(filepath.Join(dir, target, "voiceos"), []byte("voiceos "+target), 0o755)
	}
	return dir
}

var vm1AndPersonal = []Machine{{ID: "vm1", Host: "vm1", Name: "Build box"}, {ID: "personal", Host: "personal", Name: "Personal"}}

func TestRunDevPushFromTheMain(t *testing.T) {
	setupPush(t, "dev-abc")
	f := &fakePush{files: map[string][]byte{}}
	installFakePush(t, f)

	if err := RunDevPush("dev-abc", MainID, "/usr/local/bin/crew"); err != nil {
		t.Fatal(err)
	}
	st, _ := ReadDevPush()
	if st.Phase != PhaseDone {
		t.Fatalf("phase %s: %s", st.Phase, st.Error)
	}
	for _, m := range st.Machines {
		if !m.Staged || !m.Installed {
			t.Errorf("%s: staged %v installed %v", m.Name, m.Staged, m.Installed)
		}
	}
	if string(f.files["vm1:crew"]) != "crew linux_amd64" || f.scriptOn("vm1", "copy → "+StagedDir("dev-abc")) == "" {
		t.Errorf("vm1 got %q, want its own target's build in %s", f.files["vm1:crew"], StagedDir("dev-abc"))
	}
	// Every copy and check before the first install; the main last.
	first := -1
	for i, r := range f.ran {
		if strings.Contains(r, installMarker) && first < 0 {
			first = i
		}
		if first >= 0 && (strings.Contains(r, "sha256sum") || strings.Contains(r, "copy →")) {
			t.Errorf("a copy after an install began: %v", f.ran[i])
		}
	}
	if got := f.installs(); !reflect.DeepEqual(got, []string{"vm1", "main"}) {
		t.Errorf("install order %v", got)
	}
	if !strings.Contains(f.scriptOn("main", installMarker), "C='/usr/local/bin/crew'") {
		t.Error("the main installs crew where the push found it")
	}
	if !strings.HasSuffix(f.scriptOn("vm1", installMarker), `"$C" voice remote`) ||
		!strings.HasSuffix(f.scriptOn("main", installMarker), `"$C" voice _restart`) {
		t.Error("a remote restarts its daemon, the main its cockpit")
	}
}

func TestRunDevPushDamagedCopyInstallsNothing(t *testing.T) {
	setupPush(t, "dev-abc")
	f := &fakePush{files: map[string][]byte{}, damage: "vm1"}
	installFakePush(t, f)

	if err := RunDevPush("dev-abc", MainID, "/usr/local/bin/crew"); err == nil {
		t.Fatal("want a failure")
	}
	st, _ := ReadDevPush()
	if st.Phase != PhaseFailed || !strings.HasPrefix(st.Error, "Build box: crew arrived damaged") ||
		!strings.HasSuffix(st.Error, "nothing was installed") {
		t.Errorf("status %+v", st)
	}
	main, vm1 := st.Machines[0], st.Machines[1]
	if !main.Staged || main.Installed || vm1.Staged || vm1.Error != "crew arrived damaged" {
		t.Errorf("main %+v, vm1 %+v", main, vm1)
	}
	if got := f.installs(); len(got) != 0 {
		t.Errorf("installed after a failed copy: %v", got)
	}
	// What the main had staged, and vm1's damaged copy, are removed again.
	for _, host := range []string{"main", "vm1"} {
		if f.scriptOn(host, "rm -rf \"$HOME\"/'"+StagedDir("dev-abc")+"'") == "" {
			t.Errorf("%s's staged build was left behind: %v", host, f.ran)
		}
	}
}

func TestStartDevPushRunnerThatFailsToStart(t *testing.T) {
	setupPush(t, "dev-abc")
	saved := startRunner
	t.Cleanup(func() { startRunner = saved })
	startRunner = func(dir, command string) error { return errors.New("no server running") }

	if err := StartDevPush("dev-abc", MainID, "/tmp/crew", "/usr/local/bin/crew"); err == nil {
		t.Fatal("want an error")
	}
	if st, _ := ReadDevPush(); st.Phase != PhaseFailed || st.Error != "the runner did not start: no server running" {
		t.Errorf("status %+v", st)
	}
}

func TestStartDevPushRunsTheRunnerItIsGiven(t *testing.T) {
	setupPush(t, "dev-abc")
	saved := startRunner
	t.Cleanup(func() { startRunner = saved })
	var ran string
	startRunner = func(dir, command string) error { ran = command; return nil }

	if err := StartDevPush("dev-abc", "personal", "/opt/crew", "/usr/local/bin/crew"); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(ran, "'/opt/crew' voice _dev-push 'dev-abc' 'personal' '/usr/local/bin/crew'") {
		t.Errorf("ran %q", ran)
	}
}

func TestRunDevPushOneInstallFailsTheRestFinish(t *testing.T) {
	setupPush(t, "dev-abc", vm1AndPersonal...)
	f := &fakePush{files: map[string][]byte{}, failInstall: "vm1"}
	installFakePush(t, f)

	if err := RunDevPush("dev-abc", MainID, "/usr/local/bin/crew"); err == nil {
		t.Fatal("want a failure")
	}
	st, _ := ReadDevPush()
	if st.Phase != PhaseFailed || st.Error != "1 machine(s) did not take dev-abc" {
		t.Errorf("status %+v", st)
	}
	if got := f.installs(); !reflect.DeepEqual(got, []string{"vm1", "personal", "main"}) {
		t.Errorf("install order %v", got)
	}
	byID := map[string]MachineProgress{}
	for _, m := range st.Machines {
		byID[m.ID] = m
	}
	if byID["vm1"].Error != "mv: permission denied" || !byID["personal"].Installed || !byID[MainID].Installed {
		t.Errorf("machines %+v", st.Machines)
	}
}

func TestRunDevPushOutOfReachIsSkipped(t *testing.T) {
	setupPush(t, "dev-abc")
	f := &fakePush{files: map[string][]byte{}, down: map[string]bool{"vm1": true}}
	installFakePush(t, f)

	if err := RunDevPush("dev-abc", MainID, "/usr/local/bin/crew"); err != nil {
		t.Fatal(err)
	}
	st, _ := ReadDevPush()
	if st.Machines[1].Skipped == "" || !st.Machines[0].Installed || f.scriptOn("vm1", installMarker) != "" {
		t.Errorf("status %+v, ran %v", st.Machines, f.ran)
	}
}

func TestRunDevPushFromARemoteFetchesItsBuildAndRestartsItLast(t *testing.T) {
	version := "dev-abc"
	setupPush(t, version, vm1AndPersonal...)
	f := &fakePush{files: map[string][]byte{}}
	installFakePush(t, f)
	var fetched string
	copyFrom = func(host, dir, parent string) error {
		fetched = host + ":" + dir
		writeBuilds(filepath.Join(parent, filepath.Base(dir)))
		return nil
	}

	if err := RunDevPush(version, "personal", "/usr/local/bin/crew"); err != nil {
		t.Fatal(err)
	}
	if fetched != "personal:.crew/dev-push/"+version {
		t.Errorf("fetched %q", fetched)
	}
	if f.scriptOn("personal", "rm -rf \"$HOME\"/'.crew/dev-push/"+version+"'") == "" {
		t.Errorf("the source's own build was left behind: %v", f.ran)
	}
	if got := f.installs(); !reflect.DeepEqual(got, []string{"vm1", MainID, "personal"}) {
		t.Errorf("install order %v", got)
	}
}

func TestRunDevPushASkippedSourceIsNeverInstalledOn(t *testing.T) {
	version := "dev-abc"
	setupPush(t, version, vm1AndPersonal...)
	f := &fakePush{files: map[string][]byte{}, down: map[string]bool{"personal": true}}
	installFakePush(t, f)
	copyFrom = func(host, dir, parent string) error {
		writeBuilds(filepath.Join(parent, filepath.Base(dir)))
		return nil
	}

	if err := RunDevPush(version, "personal", "/usr/local/bin/crew"); err != nil {
		t.Fatal(err)
	}
	if got := f.installs(); !reflect.DeepEqual(got, []string{"vm1", MainID}) {
		t.Errorf("install order %v", got)
	}
}

func TestRestartOrderSkippedSource(t *testing.T) {
	machines := append([]PushMachine{}, pushMachines...)
	machines[2].Skipped = "unreachable"
	if got := RestartOrder(machines, "personal"); !reflect.DeepEqual(got, []string{"vm1", MainID}) {
		t.Errorf("got %v", got)
	}
}

func TestDevPushRefusal(t *testing.T) {
	running := DevPushStatus{Phase: PhaseCopy}
	cases := []struct {
		name  string
		st    DevPushStatus
		ok    bool
		alive bool
		want  error
	}{
		{"no push yet → allowed", DevPushStatus{}, false, false, nil},
		{"running, its runner alive → refused", running, true, true, ErrDevPushRunning},
		{"running, its runner gone (crashed) → allowed", running, true, false, nil},
		{"finished, a session still there → allowed", DevPushStatus{Phase: PhaseDone}, true, true, nil},
	}
	for _, c := range cases {
		if got := devPushRefusal(c.st, c.ok, c.alive); got != c.want {
			t.Errorf("%s: got %v", c.name, got)
		}
	}
}

func TestRenderDevPush(t *testing.T) {
	st := DevPushStatus{
		Version: "dev-abc", Source: "personal", Phase: PhaseFailed, Error: "1 machine(s) did not take dev-abc",
		Machines: []MachineProgress{
			{PushMachine: PushMachine{ID: MainID, Name: "main", Target: Target{"darwin", "arm64"}}, Staged: true, Installed: true},
			{PushMachine: PushMachine{ID: "vm1", Name: "Build box", Target: Target{"linux", "amd64"}}, Staged: true, Error: "mv: permission denied"},
			{PushMachine: PushMachine{ID: "personal", Name: "Personal", Target: Target{"linux", "amd64"}}, Staged: true},
			{PushMachine: PushMachine{ID: "lab", Name: "Lab", Skipped: "unreachable"}},
			{PushMachine: PushMachine{ID: "gpu", Name: "GPU", Target: Target{"linux", "arm64"}}},
		},
	}
	want := "dev-abc from personal: failed — 1 machine(s) did not take dev-abc\n" +
		"main\tdarwin_arm64\trestarted on dev-abc\n" +
		"Build box\tlinux_amd64\tfailed: mv: permission denied\n" +
		"Personal\tlinux_amd64\tcopied\n" +
		"Lab\t\tskipped: unreachable\n" +
		"GPU\tlinux_arm64\twaiting\n"
	if got := RenderDevPush(st); got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestStartDevPushLosingTheRaceLeavesTheRunningStatus(t *testing.T) {
	if _, err := osexec.LookPath("tmux"); err != nil {
		t.Skip("no tmux")
	}
	setupPush(t, "dev-abc")
	saved := DevPushSession
	DevPushSession = fmt.Sprintf("crew-voice-push-test-%d", os.Getpid())
	t.Cleanup(func() {
		osexec.Command("tmux", "kill-session", "-t", "="+DevPushSession).Run()
		DevPushSession = saved
	})
	if out, err := osexec.Command("tmux", "new-session", "-d", "-s", DevPushSession, "sleep 30").CombinedOutput(); err != nil {
		t.Fatalf("tmux: %s", out)
	}
	// The first push's runner is up, but has not written its own status yet.
	if err := StartDevPush("dev-def", MainID, "/tmp/crew", "/usr/local/bin/crew"); err != ErrDevPushRunning {
		t.Fatalf("got %v", err)
	}
	if _, ok := ReadDevPush(); ok {
		t.Error("the losing push wrote a status over the running one")
	}
}

// The install script run for real: staged files that lost their execute bit
// still install runnable, and a crew that is not this push's never replaces
// the one that works.
func TestInstallScript_Runs(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sh")
	}
	setup := func(t *testing.T, stagedVersion string) (home, crewPath, voicePath string) {
		home = t.TempDir()
		staged := filepath.Join(home, StagedDir("dev-abc"))
		if err := os.MkdirAll(staged, 0o755); err != nil {
			t.Fatal(err)
		}
		// A crew that says its version and accepts the restart; mode 0644, as a bad copy leaves it.
		fake := "#!/bin/sh\n[ \"$1\" = --version ] && { echo 'crew " + stagedVersion + "'; exit 0; }\nexit 0\n"
		crewPath = filepath.Join(home, "bin", "crew")
		voicePath = filepath.Join(home, "bin", "voiceos")
		for _, err := range []error{
			os.WriteFile(filepath.Join(staged, "crew"), []byte(fake), 0o644),
			os.WriteFile(filepath.Join(staged, "voiceos"), []byte("#!/bin/sh\n"), 0o644),
			os.MkdirAll(filepath.Dir(crewPath), 0o755),
			os.WriteFile(crewPath, []byte("#!/bin/sh\necho old\n"), 0o755),
		} {
			if err != nil {
				t.Fatal(err)
			}
		}
		return home, crewPath, voicePath
	}
	run := func(home, crewPath, voicePath string) (string, error) {
		cmd := osexec.Command("sh", "-c", InstallScript("dev-abc", true, crewPath, voicePath))
		cmd.Env = append(os.Environ(), "HOME="+home)
		out, err := cmd.CombinedOutput()
		return string(out), err
	}

	t.Run("staged without the execute bit → installed runnable", func(t *testing.T) {
		home, crewPath, voicePath := setup(t, "dev-abc")
		if out, err := run(home, crewPath, voicePath); err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if got, _ := os.ReadFile(crewPath); !strings.Contains(string(got), "crew dev-abc") {
			t.Errorf("the staged crew was not installed: %q", got)
		}
		if got, _ := os.ReadFile(voicePath + ".version"); string(got) != "dev-abc\n" {
			t.Errorf("version stamp = %q", got)
		}
		for _, path := range []string{crewPath, voicePath} {
			info, err := os.Stat(path)
			if err != nil || info.Mode().Perm()&0o111 == 0 {
				t.Errorf("%s not executable: %v %v", path, info, err)
			}
		}
	})

	t.Run("a crew that is not this push's → refused, the working one kept", func(t *testing.T) {
		home, crewPath, voicePath := setup(t, "dev-other")
		out, err := run(home, crewPath, voicePath)
		if err == nil {
			t.Fatal("installed a crew that is not this push's")
		}
		if !strings.Contains(out, "the new crew does not run here") {
			t.Errorf("refused for another reason:\n%s", out)
		}
		for _, leftover := range []string{crewPath + ".new", voicePath + ".new"} {
			if _, err := os.Stat(leftover); err == nil {
				t.Errorf("%s left behind", leftover)
			}
		}
		got, _ := os.ReadFile(crewPath)
		if string(got) != "#!/bin/sh\necho old\n" {
			t.Errorf("the working crew was replaced: %q", got)
		}
	})
}
