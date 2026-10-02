package main

import (
	"encoding/json"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/voice"
)

func TestParseHandoffArgsSharedFixture(t *testing.T) {
	data, err := os.ReadFile("../voiceos/test/fixtures/shared/dev-handoff.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct{ Allowed, Refused [][]string }
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, args := range fixture.Allowed {
		h, err := parseHandoffArgs(append(args, "--source=vm1"))
		if err != nil || h.version != args[0] || h.source != "vm1" {
			t.Errorf("%v: got %+v, %v", args, h, err)
		}
	}
	for _, args := range fixture.Refused {
		if _, err := parseHandoffArgs(append(args, "--source=vm1")); err == nil {
			t.Errorf("%v: want refused", args)
		}
	}
	ok := fixture.Allowed[0]
	for _, source := range []string{"--source=main", "--source=", "--source=VM 1", "vm1"} {
		if _, err := parseHandoffArgs(append(append([]string{}, ok...), source)); err == nil {
			t.Errorf("%q: want refused", source)
		}
	}
	if _, err := parseHandoffArgs(ok); err == nil {
		t.Error("no source: want refused")
	}
}

func TestPushRunningFrom(t *testing.T) {
	cases := map[string]error{
		"null":                             nil,
		`{"phase":"copy","running":true}`:  voice.ErrDevPushRunning,
		`{"phase":"copy","running":false}`: nil,
		`{"phase":"done"}`:                 nil,
		`{"phase":"failed"}`:               nil,
		"not json from an old main":        nil,
	}
	for stdout, want := range cases {
		if got := pushRunningFrom(stdout); got != want {
			t.Errorf("%q: got %v", stdout, got)
		}
	}
}

func TestMainRefusal(t *testing.T) {
	got := mainRefusal("did not list its machines", voice.QueryReply{Error: "not allowed"}, nil)
	if !strings.Contains(got.Error(), "push once from the main first") {
		t.Errorf("got %v", got)
	}
	got = mainRefusal("did not answer", voice.QueryReply{Error: "timeout"}, nil)
	if got.Error() != "the main did not answer: timeout" {
		t.Errorf("got %v", got)
	}
}

// The dirty hash is what tells two uncommitted trees apart: the same tree, the
// same version; an edit or a new file, another.
func TestCheckoutVersion(t *testing.T) {
	root := t.TempDir()
	run := func(args ...string) {
		cmd := osexec.Command("git", append([]string{"-C", root}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s", args, out)
		}
	}
	run("init", "-q")
	os.WriteFile(filepath.Join(root, "a.txt"), []byte("one"), 0o644)
	run("add", ".")
	run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")

	clean, err := checkoutVersion(root)
	if err != nil || !devVersionPattern.MatchString(clean) || strings.Contains(clean, "dirty") {
		t.Fatalf("clean: %q %v", clean, err)
	}
	os.WriteFile(filepath.Join(root, "a.txt"), []byte("two"), 0o644)
	edited, _ := checkoutVersion(root)
	again, _ := checkoutVersion(root)
	os.WriteFile(filepath.Join(root, "new.txt"), []byte("x"), 0o644)
	withNew, _ := checkoutVersion(root)
	if !devVersionPattern.MatchString(edited) || !strings.Contains(edited, "-dirty-") || edited != again || withNew == edited {
		t.Errorf("clean %q, edited %q, again %q, with a new file %q", clean, edited, again, withNew)
	}
}
