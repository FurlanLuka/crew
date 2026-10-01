package voice

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestDevVersion(t *testing.T) {
	if got := DevVersion("abc1234\n", false); got != "dev-abc1234" {
		t.Errorf("clean: got %q", got)
	}
	if got := DevVersion("abc1234", true); got != "dev-abc1234-dirty" {
		t.Errorf("dirty: got %q", got)
	}
}

func TestTargetFromUname(t *testing.T) {
	cases := map[string]Target{
		"Linux x86_64\n": {GOOS: "linux", GOARCH: "amd64"},
		"Linux aarch64":  {GOOS: "linux", GOARCH: "arm64"},
		"Darwin arm64":   {GOOS: "darwin", GOARCH: "arm64"},
		"Darwin x86_64":  {GOOS: "darwin", GOARCH: "amd64"},
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
	remote := InstallScript("dev-abc", false, "")
	main := InstallScript("dev-abc", true, "/Users/dev/.local/bin/crew")
	for _, want := range []string{
		`C=$(command -v crew 2>/dev/null || echo "$HOME/.local/bin/crew")`,
		`rm -f "$C" && mv "$D/crew" "$C"`,
		`printf '%s\n' 'dev-abc' > "$HOME/.crew/bin/voiceos.version"`,
		"codesign --sign -",
	} {
		if !strings.Contains(remote, want) {
			t.Errorf("remote script lacks %q", want)
		}
	}
	if !strings.HasSuffix(remote, `"$C" voice remote`) || !strings.HasSuffix(main, `"$C" voice _restart`) {
		t.Error("a remote restarts its daemon, the main its cockpit, last")
	}
	if !strings.Contains(main, "C='/Users/dev/.local/bin/crew'") {
		t.Error("the main replaces the crew it runs")
	}
}

func TestParseChecksums(t *testing.T) {
	got := ParseChecksums("aa  crew\nbb *voiceos\n\n")
	if got["crew"] != "aa" || got["voiceos"] != "bb" {
		t.Errorf("got %v", got)
	}
}

// fakePush swaps the push's I/O for an in-memory one: each host's files and
// the scripts run on it.
type fakePush struct {
	files   map[string][]byte // host:path → content
	scripts []string          // "host: first line of what ran"
	down    map[string]bool
	damage  string // a host whose copy arrives damaged
}

func installFakePush(t *testing.T, f *fakePush) {
	t.Helper()
	saved := []any{runRemote, copyTo, copyFrom, runLocal}
	t.Cleanup(func() {
		runRemote = saved[0].(func(string, string) (string, error))
		copyTo = saved[1].(func(string, string, ...string) error)
		copyFrom = saved[2].(func(string, string, string) error)
		runLocal = saved[3].(func(string) (string, error))
	})
	sum := func(host string) string {
		var out strings.Builder
		for _, name := range []string{"crew", "voiceos"} {
			data := f.files[host+":"+name]
			if host == f.damage {
				data = append(data, 'x')
			}
			s, _ := sha256Of(data)
			out.WriteString(s + "  " + name + "\n")
		}
		return out.String()
	}
	runRemote = func(host, script string) (string, error) {
		if f.down[host] {
			return "", errors.New("ssh: connect to host " + host + ": Connection refused")
		}
		f.scripts = append(f.scripts, host+": "+strings.SplitN(script, "\n", 2)[0])
		switch {
		case script == "uname -sm":
			return "Linux x86_64", nil
		case strings.Contains(script, "sha256sum"):
			return sum(host), nil
		}
		return "", nil
	}
	copyTo = func(host, dir string, files ...string) error {
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
	runLocal = func(script string) (string, error) {
		f.scripts = append(f.scripts, "main: "+strings.SplitN(script, "\n", 2)[0])
		if strings.Contains(script, "sha256sum") {
			return sum("main"), nil
		}
		if strings.HasPrefix(script, "mkdir -p") {
			for _, name := range []string{"crew", "voiceos"} {
				for _, field := range strings.Fields(script) {
					if strings.HasSuffix(strings.Trim(field, "'"), "/"+name) {
						data, _ := os.ReadFile(strings.Trim(field, "'"))
						f.files["main:"+name] = data
					}
				}
			}
		}
		return "", nil
	}
}

func sha256Of(data []byte) (string, error) {
	tmp, err := os.CreateTemp("", "sum-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	tmp.Write(data)
	tmp.Close()
	return fileSHA256(tmp.Name())
}

func setupPush(t *testing.T, version string) string {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	machines, _ := json.Marshal([]Machine{{ID: "vm1", Host: "vm1", Name: "Build box"}})
	os.MkdirAll(filepath.Dir(MachinesFile()), 0o700)
	if err := os.WriteFile(MachinesFile(), machines, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Remove(MachinesFile()); os.Remove(devPushStatusFile()) })
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

func TestRunDevPushFromTheMain(t *testing.T) {
	dir := setupPush(t, "dev-abc")
	f := &fakePush{files: map[string][]byte{}}
	installFakePush(t, f)

	if err := RunDevPush("dev-abc", MainID, dir); err != nil {
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
	if string(f.files["vm1:crew"]) != "crew linux_amd64" {
		t.Errorf("vm1 got %q, want its own target's build", f.files["vm1:crew"])
	}
	// Both staged before either installs, and the main last.
	installs := []string{}
	for i, s := range f.scripts {
		if strings.HasSuffix(s, ": set -e") {
			installs = append(installs, strings.SplitN(s, ":", 2)[0])
			for _, later := range f.scripts[i:] {
				if strings.Contains(later, "sha256sum") {
					t.Errorf("a copy after an install began: %v", f.scripts)
				}
			}
		}
	}
	if !reflect.DeepEqual(installs, []string{"vm1", "main"}) {
		t.Errorf("install order %v", installs)
	}
}

func TestRunDevPushDamagedCopyInstallsNothing(t *testing.T) {
	dir := setupPush(t, "dev-abc")
	f := &fakePush{files: map[string][]byte{}, damage: "vm1"}
	installFakePush(t, f)

	if err := RunDevPush("dev-abc", MainID, dir); err == nil {
		t.Fatal("want a failure")
	}
	st, _ := ReadDevPush()
	if st.Phase != PhaseFailed || !strings.Contains(st.Error, "nothing was installed") {
		t.Errorf("status %+v", st)
	}
	for _, s := range f.scripts {
		if strings.HasSuffix(s, ": set -e") {
			t.Errorf("installed after a failed copy: %v", f.scripts)
		}
	}
}

func TestRunDevPushOutOfReachIsSkipped(t *testing.T) {
	dir := setupPush(t, "dev-abc")
	f := &fakePush{files: map[string][]byte{}, down: map[string]bool{"vm1": true}}
	installFakePush(t, f)

	if err := RunDevPush("dev-abc", MainID, dir); err != nil {
		t.Fatal(err)
	}
	st, _ := ReadDevPush()
	if st.Machines[1].Skipped == "" || !st.Machines[0].Installed {
		t.Errorf("status %+v", st.Machines)
	}
	if !strings.Contains(RenderDevPush(st), "Build box\t\tskipped: ssh: connect to host vm1: Connection refused") {
		t.Errorf("render:\n%s", RenderDevPush(st))
	}
}

func TestRunDevPushFromARemoteFetchesItsBuildAndRestartsItLast(t *testing.T) {
	version := "dev-abc"
	setupPush(t, version)
	machines, _ := json.Marshal([]Machine{{ID: "vm1", Host: "vm1", Name: "Build box"}, {ID: "personal", Host: "personal", Name: "Personal"}})
	os.WriteFile(MachinesFile(), machines, 0o600)
	f := &fakePush{files: map[string][]byte{}}
	installFakePush(t, f)
	var fetched string
	copyFrom = func(host, dir, parent string) error {
		fetched = host + ":" + dir
		writeBuilds(filepath.Join(parent, filepath.Base(dir)))
		return nil
	}

	if err := RunDevPush(version, "personal", "/home/dev/.crew/dev-push/"+version); err != nil {
		t.Fatal(err)
	}
	if fetched != "personal:/home/dev/.crew/dev-push/"+version {
		t.Errorf("fetched %q", fetched)
	}
	var installs []string
	for _, s := range f.scripts {
		if strings.HasSuffix(s, ": set -e") {
			installs = append(installs, strings.SplitN(s, ":", 2)[0])
		}
	}
	if !reflect.DeepEqual(installs, []string{"vm1", "main", "personal"}) {
		t.Errorf("install order %v", installs)
	}
}
