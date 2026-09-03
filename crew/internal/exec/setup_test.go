package exec

import (
	"os"
	"path/filepath"
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

	got := names(SetupSteps(dir, "make sync"))
	if len(got) != 2 || got[0] != "mise install" || got[1] != "make sync" {
		t.Errorf("SetupSteps = %v, want [mise install, make sync]", got)
	}
	if plain := names(SetupSteps(touch(t, t.TempDir(), "package.json"), "make setup")); len(plain) != 1 || plain[0] != "make setup" {
		t.Errorf("SetupSteps without mise = %v, want [make setup]", plain)
	}
}

func TestRunSetup_StopsAtFirstFailureAndReports(t *testing.T) {
	var seen []string
	err := RunSetup(t.TempDir(), []SetupStep{
		{Name: "ok", Command: "true"},
		{Name: "boom", Command: "echo 'no such module' >&2; exit 3"},
		{Name: "never", Command: "true"},
	}, func(r SetupResult) {
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
