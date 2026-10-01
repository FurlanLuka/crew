package voice

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

// A dev push: one build of crew and Voice OS from a checkout, put on every
// machine and restarted together. Any machine can be the source; the runner
// always runs on the main, detached, so a restart cannot end it.

// MainID names the main in a push's machine list ("main" is reserved as a
// machine id, so no remote can take it).
const MainID = "main"

// DevPushSession is the runner's tmux session on the main.
const DevPushSession = "crew-dev-push"

// Target is an OS and CPU a build is made for.
type Target struct {
	GOOS   string `json:"goos"`
	GOARCH string `json:"goarch"`
}

// Dir is the target's folder in a push's build dir ("linux_amd64"); empty when unknown.
func (t Target) Dir() string {
	if t.GOOS == "" {
		return ""
	}
	return t.GOOS + "_" + t.GOARCH
}

// Bun is bun's --target name for it.
func (t Target) Bun() string {
	arch := t.GOARCH
	if arch == "amd64" {
		arch = "x64"
	}
	return "bun-" + t.GOOS + "-" + arch
}

// PushMachine is one machine a push reaches: the main (Host empty) or a remote.
type PushMachine struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Host   string `json:"host,omitempty"`
	Target Target `json:"target"`
	// Why it is left out (out of reach when the targets were read); empty when it is in.
	Skipped string `json:"skipped,omitempty"`
}

// DevVersion is what every machine of a push reports: the commit, marked when
// the tree had changes not committed. Pure.
func DevVersion(sha string, dirty bool) string {
	v := "dev-" + strings.TrimSpace(sha)
	if dirty {
		v += "-dirty"
	}
	return v
}

// TargetFromUname reads `uname -sm` ("Linux x86_64", "Darwin arm64"). Pure.
func TargetFromUname(out string) (Target, error) {
	fields := strings.Fields(out)
	if len(fields) != 2 {
		return Target{}, fmt.Errorf("unexpected uname output %q", strings.TrimSpace(out))
	}
	goos := map[string]string{"Linux": "linux", "Darwin": "darwin"}[fields[0]]
	goarch := map[string]string{"x86_64": "amd64", "amd64": "amd64", "arm64": "arm64", "aarch64": "arm64"}[fields[1]]
	if goos == "" || goarch == "" {
		return Target{}, fmt.Errorf("no build for %s %s", fields[0], fields[1])
	}
	return Target{GOOS: goos, GOARCH: goarch}, nil
}

// DistinctTargets is each target once, in first-seen order: one build each. Pure.
func DistinctTargets(machines []PushMachine) []Target {
	seen := map[Target]bool{}
	var out []Target
	for _, m := range machines {
		if m.Skipped != "" || seen[m.Target] {
			continue
		}
		seen[m.Target] = true
		out = append(out, m.Target)
	}
	return out
}

// RestartOrder: the other remotes first, then the main, the source machine
// last — the one where the push was asked for, often by a Claude session that
// the restart ends. Skipped machines are left out. Pure.
func RestartOrder(machines []PushMachine, source string) []string {
	var order []string
	for _, m := range machines {
		if m.Skipped == "" && m.ID != MainID && m.ID != source {
			order = append(order, m.ID)
		}
	}
	if source != MainID {
		order = append(order, MainID)
	}
	return append(order, source)
}

// StagedDir is where a push's files wait on a machine before they go live, by
// version — under $HOME, the same on every machine.
func StagedDir(version string) string { return ".crew/dev-push-staged/" + version }

// InstallScript moves the staged build into place and restarts Voice OS on it:
// crew where `command -v crew` finds it (else ~/.local/bin/crew), Voice OS at
// ~/.crew/bin/voiceos with its version stamp; then the main restarts its
// cockpit, a remote its daemon. rm before mv: replacing a signed binary in place
// gets it killed on macOS. Pure.
// crewPath: where crew lives, when the caller knows (the main's own binary).
func InstallScript(version string, isMain bool, crewPath string) string {
	restart := `"$C" voice remote`
	if isMain {
		restart = `"$C" voice _restart`
	}
	findCrew := `C=$(command -v crew 2>/dev/null || echo "$HOME/.local/bin/crew")`
	if crewPath != "" {
		findCrew = "C=" + crewExec.ShellQuote(crewPath)
	}
	q := crewExec.ShellQuote
	return strings.Join([]string{
		"set -e",
		"D=\"$HOME\"/" + q(StagedDir(version)),
		findCrew,
		`mkdir -p "$(dirname "$C")" "$HOME/.crew/bin"`,
		`rm -f "$C" && mv "$D/crew" "$C"`,
		`rm -f "$HOME/.crew/bin/voiceos" && mv "$D/voiceos" "$HOME/.crew/bin/voiceos"`,
		"printf '%s\\n' " + q(version) + ` > "$HOME/.crew/bin/voiceos.version"`,
		`if [ "$(uname)" = Darwin ]; then codesign --sign - -f "$C" "$HOME/.crew/bin/voiceos" >/dev/null 2>&1 || true; fi`,
		`rmdir "$D" 2>/dev/null || true`,
		restart,
	}, "\n")
}

// RemoteChecksumScript prints each staged file's sha256 ("<sum>  <file>"),
// with whichever tool the machine has. Pure.
func RemoteChecksumScript(version string) string {
	dir := `"$HOME"/` + crewExec.ShellQuote(StagedDir(version))
	return "cd " + dir + " && { sha256sum crew voiceos 2>/dev/null || shasum -a 256 crew voiceos; }"
}

// ParseChecksums reads sha256sum output into file → sum. Pure.
func ParseChecksums(out string) map[string]string {
	sums := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 {
			sums[strings.TrimPrefix(fields[1], "*")] = fields[0]
		}
	}
	return sums
}

// Push phases, in order.
const (
	PhaseGather  = "gather"
	PhaseCopy    = "copy"
	PhaseRestart = "restart"
	PhaseDone    = "done"
	PhaseFailed  = "failed"
)

// MachineProgress is how far a push got on one machine.
type MachineProgress struct {
	PushMachine
	Staged    bool   `json:"staged"`
	Installed bool   `json:"installed"`
	Error     string `json:"error,omitempty"`
}

// DevPushStatus is ~/.crew/voiceos/dev-push.json on the main, written after every step.
type DevPushStatus struct {
	Version   string            `json:"version"`
	Source    string            `json:"source"`
	StartedAt time.Time         `json:"started_at"`
	Phase     string            `json:"phase"`
	Error     string            `json:"error,omitempty"`
	Machines  []MachineProgress `json:"machines"`
}

// IsFinished: done or failed, nothing more will happen. Pure.
func (s DevPushStatus) IsFinished() bool { return s.Phase == PhaseDone || s.Phase == PhaseFailed }

func devPushStatusFile() string { return filepath.Join(Dir(), "dev-push.json") }

// DevPushBuildDir is where a push's builds are kept on a machine, by version.
func DevPushBuildDir(version string) string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".crew", "dev-push", version)
}

// ReadDevPush is the last push's status; ok false when there was none.
func ReadDevPush() (DevPushStatus, bool) {
	data, err := os.ReadFile(devPushStatusFile())
	if err != nil {
		return DevPushStatus{}, false
	}
	var st DevPushStatus
	if err := json.Unmarshal(data, &st); err != nil {
		return DevPushStatus{}, false
	}
	return st, true
}

func writeDevPush(st DevPushStatus) error {
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(Dir(), 0o700); err != nil {
		return err
	}
	tmp := devPushStatusFile() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, devPushStatusFile())
}

// RenderDevPush is crew voice dev status for a human. Pure.
func RenderDevPush(st DevPushStatus) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s from %s: %s", st.Version, st.Source, st.Phase)
	if st.Error != "" {
		fmt.Fprintf(&b, " — %s", st.Error)
	}
	b.WriteString("\n")
	for _, m := range st.Machines {
		state := "waiting"
		switch {
		case m.Skipped != "":
			state = "skipped: " + m.Skipped
		case m.Error != "":
			state = "failed: " + m.Error
		case m.Installed:
			state = "restarted on " + st.Version
		case m.Staged:
			state = "copied"
		}
		fmt.Fprintf(&b, "%s\t%s\t%s\n", m.Name, m.Target.Dir(), state)
	}
	return b.String()
}
