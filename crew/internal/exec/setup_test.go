package exec

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func touch(t *testing.T, dir string, names ...string) string {
	t.Helper()
	for _, n := range names {
		os.WriteFile(filepath.Join(dir, n), []byte("{}"), 0o644)
	}
	return dir
}

func names(steps []SetupStep) []string {
	out := make([]string, 0, len(steps))
	for _, s := range steps {
		out = append(out, s.Name)
	}
	return out
}

func TestDetectSetup(t *testing.T) {
	tests := []struct {
		name  string
		files []string
		want  []string
	}{
		{"nothing", nil, nil},
		{"mise only", []string{"mise.toml"}, []string{"mise install"}},
		{"uv", []string{"mise.toml", "pyproject.toml", "uv.lock"}, []string{"mise install", "uv sync"}},
		{"pnpm beats package.json", []string{"package.json", "pnpm-lock.yaml"}, []string{"pnpm install"}},
		{"yarn", []string{"package.json", "yarn.lock"}, []string{"yarn install"}},
		{"npm ci with lock", []string{"package.json", "package-lock.json"}, []string{"npm ci"}},
		{"npm install without lock", []string{"package.json"}, []string{"npm install"}},
		{"dot mise", []string{".mise.toml", "package.json"}, []string{"mise install", "npm install"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := touch(t, t.TempDir(), tt.files...)
			got := names(DetectSetup(dir))
			if len(got) != len(tt.want) {
				t.Fatalf("DetectSetup = %v, want %v", got, tt.want)
			}
			for i := range tt.want {
				if got[i] != tt.want[i] {
					t.Errorf("step %d = %q, want %q", i, got[i], tt.want[i])
				}
			}
		})
	}
}

// An explicit setup command replaces the lockfile's package manager but not
// mise — the toolchain still has to be there for the command to run.
func TestSetupSteps_ExplicitReplacesDetection(t *testing.T) {
	dir := touch(t, t.TempDir(), "mise.toml", "pyproject.toml", "uv.lock")

	got := names(SetupSteps(dir, "make sync", ""))
	if len(got) != 2 || got[0] != "mise install" || got[1] != "make sync" {
		t.Errorf("SetupSteps = %v, want [mise install, make sync]", got)
	}
	if plain := names(SetupSteps(touch(t, t.TempDir(), "package.json"), "make setup", "")); len(plain) != 1 || plain[0] != "make setup" {
		t.Errorf("SetupSteps without mise = %v, want [make setup]", plain)
	}
}

// The env command sits between mise and the install — after the toolchain
// it may need, before the install that needs its output — named apart from
// a setup with the same text.
func TestSetupSteps_EnvCommandBeforeInstall(t *testing.T) {
	dir := touch(t, t.TempDir(), "mise.toml", "uv.lock")
	join := func(steps []SetupStep) string { return strings.Join(names(steps), ",") }
	if got := join(SetupSteps(dir, "", "make get-env")); got != "mise install,env: make get-env,uv sync" {
		t.Errorf("detected: %s", got)
	}
	if got := join(SetupSteps(dir, "make sync", "make sync")); got != "mise install,env: make sync,make sync" {
		t.Errorf("explicit, same text: %s", got)
	}
	if got := join(SetupSteps(t.TempDir(), "", "make get-env")); got != "env: make get-env" {
		t.Errorf("env alone: %s", got)
	}
	steps := SetupSteps(dir, "", "make get-env")
	if steps[1].Command != "make get-env" {
		t.Errorf("the step runs the command itself, got %q", steps[1].Command)
	}
	if got := join(SetupSteps(dir, "", "")); got != "mise install,uv sync" {
		t.Errorf("no env command: %s", got)
	}
}

func TestRunSetup_StopsAtFirstFailureAndReports(t *testing.T) {
	var seen []string
	err := RunSetup(t.TempDir(), []SetupStep{
		{Name: "ok", Command: "true"},
		{Name: "boom", Command: "echo 'no such module' >&2; exit 3"},
		{Name: "never", Command: "true"},
	}, nil, func(r SetupResult) {
		mark := "ok"
		if r.Err != nil {
			mark = "err"
		}
		seen = append(seen, r.Step.Name+":"+mark)
	})

	if err == nil || err.Error() != "boom: no such module" {
		t.Errorf("err = %v, want the step name and its stderr", err)
	}
	if len(seen) != 2 || seen[0] != "ok:ok" || seen[1] != "boom:err" {
		t.Errorf("reported %v, want the first two only", seen)
	}
}

// A failed step keeps enough output to see why: the message is the last few
// lines, Output the tail a pydantic error's field name sits in.
func TestRunSetupStep_KeepsOutputTail(t *testing.T) {
	dir := t.TempDir()
	script := "for i in $(seq 1 40); do echo line $i; done; echo 'settings.Sentry' >&2; echo '  dsn' >&2; echo '  Field required [type=missing]' >&2; exit 2"
	err := runSetupStep(dir, SetupStep{Name: "make sync", Command: script}, false, nil)
	var se *StepError
	if !errors.As(err, &se) {
		t.Fatalf("err = %T %v, want StepError", err, err)
	}
	if got := strings.Count(se.Output, "\n") + 1; got != setupOutputTail {
		t.Errorf("Output keeps %d lines, want %d", got, setupOutputTail)
	}
	if !strings.Contains(se.Output, "settings.Sentry") || !strings.Contains(se.Output, "line 40") {
		t.Errorf("Output should hold stdout and stderr, the field name included:\n%s", se.Output)
	}
	if err.Error() != "make sync: settings.Sentry\n  dsn\n  Field required [type=missing]" {
		t.Errorf("Error() = %q", err.Error())
	}
}

// A step's output streams to the writer as it runs — a runner's log is read
// while the install is still going — and the tail is still kept for the error.
func TestRunSetup_StreamsOutput(t *testing.T) {
	var stream bytes.Buffer
	err := RunSetup(t.TempDir(), []SetupStep{
		{Name: "say", Command: "echo hello; echo oops >&2; exit 1"},
	}, &stream, nil)
	if err == nil || !strings.Contains(err.Error(), "oops") {
		t.Errorf("err = %v", err)
	}
	if got := stream.String(); !strings.Contains(got, "hello") || !strings.Contains(got, "oops") {
		t.Errorf("streamed = %q", got)
	}
}
