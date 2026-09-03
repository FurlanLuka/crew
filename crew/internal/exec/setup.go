package exec

import (
	"bytes"
	"fmt"
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
	if has("mise.toml") || has(".mise.toml") {
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
// not install is noise, not progress.
//
// When mise is in play, each later step runs through `mise exec` so it sees
// the pinned toolchain even in a shell where mise is not activated.
func RunSetup(dir string, steps []SetupStep, report func(SetupResult)) error {
	underMise := false
	for _, step := range steps {
		start := time.Now()
		err := runSetupStep(dir, step, underMise)
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

func runSetupStep(dir string, step SetupStep, underMise bool) error {
	shell := step.Command
	if underMise {
		shell = "mise exec -- sh -c " + ShellQuote(step.Command)
	}
	debug.Log("setup", "%s in %s: %s", step.Name, dir, shell)

	cmd := exec.Command("sh", "-c", shell)
	cmd.Dir = dir
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if lines := strings.Split(msg, "\n"); len(lines) > 3 {
			msg = strings.Join(lines[len(lines)-3:], "\n")
		}
		debug.Log("setup", "%s failed in %s: %v — %s", step.Name, dir, err, msg)
		if msg == "" {
			return fmt.Errorf("%s: %w", step.Name, err)
		}
		return fmt.Errorf("%s: %s", step.Name, msg)
	}
	return nil
}
