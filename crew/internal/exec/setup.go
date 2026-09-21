package exec

import (
	"bytes"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/debug"
)

// SetupStep is one command a fresh checkout needs before it can run.
type SetupStep struct {
	Name    string // what the progress line shows: "npm ci"
	Command string // what actually runs, through sh -c
}

// TrustMise marks a checkout's mise config trusted, when it has one. Done at
// checkout rather than install so a hook or a shell that touches the tree
// before the install does not stop at "config files are not trusted". A
// failure is logged and nothing more: the install step trusts again and
// reports.
func TrustMise(dir string) {
	if !HasMiseConfig(dir) {
		return
	}
	if _, err := exec.LookPath("mise"); err != nil {
		return
	}
	debug.Log("setup", "mise trust --quiet in %s", dir)
	cmd := exec.Command("mise", "trust", "--quiet")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		debug.Log("setup", "mise trust in %s → error: %v: %s", dir, err, strings.TrimSpace(string(out)))
	}
}

// HasMiseConfig: the checkout pins a toolchain with mise.
func HasMiseConfig(dir string) bool {
	for _, name := range []string{"mise.toml", ".mise.toml"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			return true
		}
	}
	return false
}

// DetectSetup reads a checkout and decides what installs it. Pure over the
// files present.
//
// mise comes first so every later step runs under the pinned toolchain
// rather than whatever node or python happens to be on PATH. Then one package
// manager, chosen by lockfile — the lockfile is the project's own answer to
// "which one", and guessing wrong (npm in a pnpm repo) is worse than nothing.
func DetectSetup(dir string) []SetupStep {
	has := func(name string) bool {
		_, err := os.Stat(filepath.Join(dir, name))
		return err == nil
	}

	var steps []SetupStep
	// A fresh checkout is a new path, and mise refuses config it has not been
	// told to trust there. The file is the same tracked mise.toml the
	// canonical repo already trusts, so trusting it is the right call.
	if HasMiseConfig(dir) {
		steps = append(steps, SetupStep{Name: "mise install", Command: "mise trust --quiet && mise install --quiet"})
	}

	switch {
	case has("uv.lock"):
		steps = append(steps, SetupStep{Name: "uv sync", Command: "uv sync --quiet"})
	case has("pnpm-lock.yaml"):
		steps = append(steps, SetupStep{Name: "pnpm install", Command: "pnpm install --silent"})
	case has("yarn.lock"):
		steps = append(steps, SetupStep{Name: "yarn install", Command: "yarn install --silent"})
	case has("package-lock.json"):
		steps = append(steps, SetupStep{Name: "npm ci", Command: "npm ci --silent"})
	case has("package.json"):
		steps = append(steps, SetupStep{Name: "npm install", Command: "npm install --silent"})
	}
	return steps
}

// SetupSteps decides a checkout's steps: an explicit project setup command
// replaces detection (mise still runs first when present), otherwise the
// lockfile decides.
func SetupSteps(dir, explicit string) []SetupStep {
	if explicit == "" {
		return DetectSetup(dir)
	}
	var steps []SetupStep
	for _, s := range DetectSetup(dir) {
		if s.Name == "mise install" {
			steps = append(steps, s)
		}
	}
	return append(steps, SetupStep{Name: explicit, Command: explicit})
}

// SetupResult is one step's outcome.
type SetupResult struct {
	Step     SetupStep
	Duration time.Duration
	Err      error
}

// RunSetup runs the steps in order and reports each as it finishes. A failing
// step stops the sequence — a package manager running against tools mise did
// not install is noise, not progress. Every step's output streams to out as
// it happens (nil discards it) — a setup runner's log is what someone reads
// while an install is still going.
//
// When mise is in play, each later step runs through `mise exec` so it sees
// the pinned toolchain even in a shell where mise is not activated.
func RunSetup(dir string, steps []SetupStep, out io.Writer, report func(SetupResult)) error {
	underMise := false
	for _, step := range steps {
		start := time.Now()
		err := runSetupStep(dir, step, underMise, out)
		if report != nil {
			report(SetupResult{Step: step, Duration: time.Since(start), Err: err})
		}
		if err != nil {
			return err
		}
		if step.Name == "mise install" {
			underMise = true
		}
	}
	return nil
}

// StepError is a setup step that failed, with enough of its output to see
// why: the message is the last few lines for the terminal, Output the last
// setupOutputTail lines for whoever has to fix it. A pydantic validation
// error names the field two lines above "Field required".
type StepError struct {
	Step   string
	Err    error
	Output string
}

const setupOutputTail = 30

func (e *StepError) Error() string {
	lines := strings.Split(strings.TrimSpace(e.Output), "\n")
	if len(lines) > 3 {
		lines = lines[len(lines)-3:]
	}
	msg := strings.TrimSpace(strings.Join(lines, "\n"))
	if msg == "" {
		return e.Step + ": " + e.Err.Error()
	}
	return e.Step + ": " + msg
}

func (e *StepError) Unwrap() error { return e.Err }

func runSetupStep(dir string, step SetupStep, underMise bool, stream io.Writer) error {
	shell := step.Command
	if underMise {
		shell = "mise exec -- sh -c " + ShellQuote(step.Command)
	}
	debug.Log("setup", "%s in %s: %s", step.Name, dir, shell)

	cmd := exec.Command("sh", "-c", shell)
	cmd.Dir = dir
	var out bytes.Buffer
	var w io.Writer = &out
	if stream != nil {
		w = io.MultiWriter(&out, stream)
	}
	cmd.Stdout, cmd.Stderr = w, w
	if err := cmd.Run(); err != nil {
		tail := strings.TrimSpace(out.String())
		if lines := strings.Split(tail, "\n"); len(lines) > setupOutputTail {
			tail = strings.Join(lines[len(lines)-setupOutputTail:], "\n")
		}
		debug.Log("setup", "%s failed in %s: %v —\n%s", step.Name, dir, err, tail)
		return &StepError{Step: step.Name, Err: err, Output: tail}
	}
	return nil
}
