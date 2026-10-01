package voice

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

// A dev push: one build of crew and Voice OS from a checkout, put on every
// machine and restarted together. Any machine can be the source; the runner
// always runs on the main, detached, so a restart cannot end it.

// MainID names the main in a push's machine list: the reserved MainMachine id.
const MainID = MainMachine

// DevPushSession is the runner's tmux session on the main — outside crew-dev-*, which a bare
// crew dev stop or crew kill ends wholesale (a var: tests use their own).
var DevPushSession = "crew-voice-push"

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

// DevVersion is what every machine of a push reports: the commit, and for a
// tree with changes not committed a hash of those changes — two different dirty
// trees are two versions, so a second push still restarts every daemon. Pure.
func DevVersion(sha, dirtyHash string) string {
	v := "dev-" + strings.TrimSpace(sha)
	if dirtyHash != "" {
		v += "-dirty-" + dirtyHash
	}
	return v
}

// TargetFromUname reads `uname -sm` ("Linux x86_64", "Darwin arm64") from the
// last line: a login shell may print a banner first. Pure.
func TargetFromUname(out string) (Target, error) {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	fields := strings.Fields(lines[len(lines)-1])
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
	for _, m := range machines {
		if m.ID == source && m.Skipped == "" {
			return append(order, source)
		}
	}
	return order
}

// StagedDir is where a push's files wait on a machine before they go live, by
// version — under $HOME, the same on every machine.
func StagedDir(version string) string { return ".crew/dev-push-staged/" + version }

// InstallScript puts the staged build in place and restarts Voice OS on it:
// each binary is copied beside its live one, signed on macOS, then renamed
// over it — never a moment with no crew, never a half-copied one across
// filesystems. crew where `command -v crew` finds it (else ~/.local/bin/crew),
// Voice OS at ~/.crew/bin/voiceos with its version stamp, unless the caller
// knows the paths (the main's own). Then the main restarts its cockpit, a
// remote its daemon. Pure.
func InstallScript(version string, isMain bool, crewPath, voicePath string) string {
	q := crewExec.ShellQuote
	restart := `"$C" voice remote`
	if isMain {
		restart = `"$C" voice _restart`
	}
	findCrew := `C=$(command -v crew 2>/dev/null || echo "$HOME/.local/bin/crew")`
	if crewPath != "" {
		findCrew = "C=" + q(crewPath)
	}
	findVoice := `V="$HOME/.crew/bin/voiceos"`
	if voicePath != "" {
		findVoice = "V=" + q(voicePath)
	}
	return strings.Join([]string{
		"set -e",
		"D=\"$HOME\"/" + q(StagedDir(version)),
		findCrew,
		findVoice,
		// Nothing staged here means nothing to install: the live crew is never touched for it.
		`[ -f "$D/crew" ] && [ -f "$D/voiceos" ] || { echo "nothing staged in $D"; exit 1; }`,
		`mkdir -p "$(dirname "$C")" "$(dirname "$V")"`,
		`cp "$D/crew" "$C.new" && cp "$D/voiceos" "$V.new"`,
		`if [ "$(uname)" = Darwin ]; then codesign --sign - -f "$C.new" "$V.new" >/dev/null 2>&1 || { rm -f "$C.new" "$V.new"; echo "codesign failed"; exit 1; }; fi`,
		`mv -f "$C.new" "$C" && mv -f "$V.new" "$V"`,
		"printf '%s\\n' " + q(version) + ` > "$V.version"`,
		`rm -rf "$D"`,
		restart,
	}, "\n")
}

// CleanStagedScript removes a push's staged files on a machine (a push that
// stopped before installing). Pure.
func CleanStagedScript(version string) string {
	return `rm -rf "$HOME"/` + crewExec.ShellQuote(StagedDir(version))
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
	return filepath.Join(config.ConfigDir, "dev-push", version)
}

// remoteBuildDir is the same dir on a remote, from its home: a remote keeps
// crew's default config dir.
func remoteBuildDir(version string) string { return ".crew/dev-push/" + version }

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

// devPushRefusal: a push whose runner still runs refuses a second; a finished
// one, or one whose runner died, does not. Pure.
func devPushRefusal(st DevPushStatus, ok, sessionAlive bool) error {
	if ok && !st.IsFinished() && sessionAlive {
		return ErrDevPushRunning
	}
	return nil
}
