package main

import (
	"os"
	osexec "os/exec"
	"path/filepath"
	"testing"
)

// crew server dev push installs a crew only after `crew --version` prints
// exactly "crew <version>" on stdout (voice.InstallScript): a wording change, or
// anything printed before it, would refuse every push.
func TestVersionLine(t *testing.T) {
	if testing.Short() {
		t.Skip("builds crew")
	}
	bin := filepath.Join(t.TempDir(), "crew")
	build := osexec.Command("go", "build", "-ldflags", "-X main.Version=dev-test", "-o", bin, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	cmd := osexec.Command(bin, "--version")
	cmd.Env = append(os.Environ(), "HOME="+t.TempDir())
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != "crew dev-test\n" {
		t.Errorf("crew --version printed %q, want %q", out, "crew dev-test\n")
	}
}
