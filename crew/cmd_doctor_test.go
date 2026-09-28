package main

import (
	"bufio"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/voice"
)

func useTempConfig(t *testing.T) {
	t.Helper()
	prev := config.ConfigDir
	config.ConfigDir = t.TempDir()
	t.Cleanup(func() { config.ConfigDir = prev })
}

func writeExecutable(t *testing.T, dir, name string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// fakeTools puts only the named executables on PATH, and makes claude count as
// installed or not.
func fakeTools(t *testing.T, hasClaude bool, names ...string) string {
	t.Helper()
	dir := t.TempDir()
	for _, name := range names {
		writeExecutable(t, dir, name)
	}
	t.Setenv("PATH", dir)
	if hasClaude {
		t.Setenv("VOICEOS_CLAUDE_BIN", writeExecutable(t, t.TempDir(), "claude"))
	} else {
		t.Setenv("VOICEOS_CLAUDE_BIN", filepath.Join(dir, "no-claude"))
	}
	return dir
}

func answers(text string) *bufio.Reader { return bufio.NewReader(strings.NewReader(text)) }

func TestNeedsTools(t *testing.T) {
	cases := []struct {
		args []string
		want bool
	}{
		{nil, true},
		{[]string{"store-front/main"}, true},
		{[]string{"stroe-front"}, false}, // a typo is "unknown command", not an install offer
		{[]string{"show", "store-front/main"}, false},
		{[]string{"add", "workspace", "store-front"}, true},
		{[]string{"dev", "start", "store-front/main"}, true},
		{[]string{"dev"}, true},
		{[]string{"dev", "_proxy"}, false},
		{[]string{"_setup", "store-front/main", "store-api"}, false},
		{[]string{"ls", "worktrees"}, false},
		{[]string{"env", "store-front/main", "store-app"}, false},
		{[]string{"voice", "start"}, false},
		{[]string{"doctor"}, false},
		{[]string{"update"}, false},
		{[]string{"uninstall"}, false},
		{[]string{"--version"}, false},
		{[]string{"help", "dev"}, false},
	}
	for _, c := range cases {
		if got := needsTools(c.args); got != c.want {
			t.Errorf("needsTools(%q) = %v, want %v", c.args, got, c.want)
		}
	}
}

func TestDecideFirstRun(t *testing.T) {
	now := time.Date(2026, 9, 28, 9, 0, 0, 0, time.UTC)
	tmux := []string{"tmux"}
	cases := []struct {
		name        string
		missing     []string
		interactive bool
		state       requirementsState
		want        firstRunAction
	}{
		{"nothing missing", nil, true, requirementsState{}, firstRunNothing},
		{"first time at a terminal → offer", tmux, true, requirementsState{}, firstRunOffer},
		{"offered before → warn", tmux, true, requirementsState{Offered: []string{"tmux"}}, firstRunWarn},
		{"a tool missing since → offered too", []string{"tmux", "git"}, true, requirementsState{Offered: []string{"tmux"}}, firstRunOffer},
		{"no terminal → warn", tmux, false, requirementsState{}, firstRunWarn},
		{"warned within the hour → nothing", tmux, false, requirementsState{WarnedAt: now.Add(-59 * time.Minute)}, firstRunNothing},
		{"warned exactly an hour ago → warn", tmux, false, requirementsState{WarnedAt: now.Add(-time.Hour)}, firstRunWarn},
	}
	for _, c := range cases {
		if got := decideFirstRun(c.missing, c.interactive, c.state, now); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestInstallModeAndExitCode(t *testing.T) {
	if interactive, err := installMode(true, false); !interactive || err != nil {
		t.Errorf("terminal: %v %v", interactive, err)
	}
	if interactive, err := installMode(false, true); interactive || err != nil {
		t.Errorf("--yes: %v %v", interactive, err)
	}
	if _, err := installMode(false, false); err == nil || !strings.Contains(err.Error(), "--yes") {
		t.Errorf("no terminal, no --yes: %v", err)
	}
	missing := []requirement{{Name: "tmux", Required: true}, {Name: "claude"}}
	onlyClaude := []requirement{{Name: "tmux", OK: true, Required: true}, {Name: "claude"}}
	if doctorExitCode(missing) != 1 || doctorExitCode(onlyClaude) != 0 {
		t.Errorf("exit codes: %d %d", doctorExitCode(missing), doctorExitCode(onlyClaude))
	}
}

func TestInstallSteps(t *testing.T) {
	has := func(names ...string) func(string) bool {
		return func(name string) bool {
			for _, n := range names {
				if n == name {
					return true
				}
			}
			return false
		}
	}
	cases := []struct {
		name    string
		goos    string
		has     func(string) bool
		missing []string
		want    []string
		sudo    bool
	}{
		{"mac with brew", "darwin", has("brew"), []string{"tmux"}, []string{"brew install tmux"}, false},
		{"mac without brew", "darwin", has(), []string{"tmux"}, []string{"install Homebrew (https://brew.sh), then brew install tmux"}, false},
		{"mac git is the command-line tools", "darwin", has("brew"), []string{"tmux", "git"}, []string{"brew install tmux", "xcode-select --install"}, false},
		{"apt, both in one command", "linux", has("apt-get"), []string{"tmux", "git"}, []string{"sudo apt-get update -qq && sudo apt-get install -y tmux git"}, true},
		{"dnf", "linux", has("dnf"), []string{"tmux"}, []string{"sudo dnf install -y tmux"}, true},
		{"pacman", "linux", has("pacman"), []string{"git"}, []string{"sudo pacman -S --noconfirm git"}, true},
		{"no package manager", "linux", has(), []string{"tmux"}, []string{"install tmux with your package manager"}, false},
		{"nothing missing", "linux", has("apt-get"), nil, nil, false},
	}
	for _, c := range cases {
		steps := installSteps(c.goos, c.has, c.missing)
		var got []string
		sudo := false
		for _, step := range steps {
			got = append(got, step.String())
			sudo = sudo || step.Sudo
		}
		if !reflect.DeepEqual(got, c.want) || sudo != c.sudo {
			t.Errorf("%s: got %q (sudo %v), want %q (sudo %v)", c.name, got, sudo, c.want, c.sudo)
		}
	}
}

func TestReadAnswer(t *testing.T) {
	cases := []struct {
		input      string
		defaultYes bool
		want       bool
	}{
		{"\n", true, true},
		{"\n", false, false},
		{"y\n", false, true},
		{"Yes\n", false, true},
		{"n\n", true, false},
		{"no\n", true, false},
		{"", true, false}, // EOF: nobody answered
	}
	for _, c := range cases {
		if got := readAnswer(answers(c.input), c.defaultYes); got != c.want {
			t.Errorf("readAnswer(%q, default %v) = %v, want %v", c.input, c.defaultYes, got, c.want)
		}
	}
}

func TestRequirementsState(t *testing.T) {
	useTempConfig(t)

	if got := readRequirementsState(); !reflect.DeepEqual(got, requirementsState{}) {
		t.Fatalf("no file: got %+v", got)
	}
	if err := os.WriteFile(requirementsStatePath(), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := readRequirementsState(); !reflect.DeepEqual(got, requirementsState{}) {
		t.Fatalf("corrupt file: got %+v", got)
	}
	at := time.Date(2026, 9, 28, 9, 0, 0, 0, time.UTC)
	writeRequirementsState(requirementsState{Offered: []string{"tmux"}, WarnedAt: at})
	got := readRequirementsState()
	if !reflect.DeepEqual(got.Offered, []string{"tmux"}) || !got.WarnedAt.Equal(at) {
		t.Fatalf("round trip: got %+v", got)
	}
}

// swapInstall records every command it is asked to run; onRun can put a tool on PATH.
func swapInstall(t *testing.T, err error, onRun func()) *[]string {
	t.Helper()
	var ran []string
	prev := runInstall
	runInstall = func(argv []string, _ io.Writer) error {
		ran = append(ran, strings.Join(argv, " "))
		if onRun != nil {
			onRun()
		}
		return err
	}
	t.Cleanup(func() { runInstall = prev })
	return &ran
}

func onMac(input string, out io.Writer) installOptions {
	return installOptions{goos: "darwin", has: func(name string) bool { return name == "brew" }, interactive: true, in: answers(input), out: out}
}

func onApt(input string, out io.Writer) installOptions {
	return installOptions{goos: "linux", has: func(name string) bool { return name == "apt-get" }, interactive: true, in: answers(input), out: out}
}

func TestDoctorInstall_RunsTheCommandsThenRechecks(t *testing.T) {
	useTempConfig(t)
	dir := fakeTools(t, true, "git")
	ran := swapInstall(t, nil, func() { writeExecutable(t, dir, "tmux") })

	var out bytes.Buffer
	ok := runDoctorInstall(onMac("\n", &out))

	if !ok || !reflect.DeepEqual(*ran, []string{"brew install tmux"}) {
		t.Fatalf("ok %v, ran %q\n%s", ok, *ran, out.String())
	}
	if !strings.Contains(out.String(), "[Y/n]") || strings.Contains(out.String(), "Still missing") {
		t.Fatalf("no sudo asks yes by default, and tmux is there now:\n%s", out.String())
	}
}

func TestDoctorInstall_SudoDefaultsToNo(t *testing.T) {
	useTempConfig(t)
	fakeTools(t, true, "git")
	ran := swapInstall(t, nil, nil)

	var out bytes.Buffer
	if runDoctorInstall(onApt("\n", &out)) {
		t.Fatal("tmux is still missing")
	}
	if len(*ran) != 0 || !strings.Contains(out.String(), "[y/N]") ||
		!strings.Contains(out.String(), "sudo apt-get update -qq && sudo apt-get install -y tmux") {
		t.Fatalf("ran %q\n%s", *ran, out.String())
	}
}

func TestDoctorInstall_GitOnMacSaysToFinishTheDialog(t *testing.T) {
	useTempConfig(t)
	fakeTools(t, true, "tmux")
	ran := swapInstall(t, nil, nil)

	var out bytes.Buffer
	runDoctorInstall(onMac("y\n", &out))

	if !reflect.DeepEqual(*ran, []string{"xcode-select --install"}) ||
		!strings.Contains(out.String(), "Finish the Command Line Tools install in the dialog") ||
		!strings.Contains(out.String(), "Still missing: git") {
		t.Fatalf("ran %q\n%s", *ran, out.String())
	}
}

func TestDoctorInstall_NoPackageManager_SaysHowByHand(t *testing.T) {
	useTempConfig(t)
	fakeTools(t, true, "git")
	ran := swapInstall(t, nil, nil)
	opts := onMac("", nil)
	opts.has = func(string) bool { return false }
	var out bytes.Buffer
	opts.out = &out

	runDoctorInstall(opts)

	if len(*ran) != 0 || !strings.Contains(out.String(), "Install by hand: install Homebrew") ||
		strings.Contains(out.String(), "Run them now?") {
		t.Fatalf("ran %q\n%s", *ran, out.String())
	}
}

func TestDoctorInstall_DeclinedOrFailed_SaysWhatIsStillMissing(t *testing.T) {
	useTempConfig(t)
	fakeTools(t, true, "git")
	swapInstall(t, os.ErrPermission, nil)

	var declined, failed bytes.Buffer
	if runDoctorInstall(onMac("n\n", &declined)) {
		t.Fatal("declined: tmux is still missing")
	}
	yes := onMac("", &failed)
	yes.interactive = false
	if runDoctorInstall(yes) {
		t.Fatal("failed: tmux is still missing")
	}
	if !strings.Contains(declined.String(), "Still missing: tmux") {
		t.Fatalf("declined:\n%s", declined.String())
	}
	if !strings.Contains(failed.String(), "brew install tmux failed: permission denied") ||
		!strings.Contains(failed.String(), "Still missing: tmux") {
		t.Fatalf("failed:\n%s", failed.String())
	}
}

func TestDoctorInstall_ClaudeIsAskedSeparatelyAndDefaultsToNo(t *testing.T) {
	useTempConfig(t)
	fakeTools(t, false, "tmux", "git")
	ran := swapInstall(t, nil, nil)

	var out bytes.Buffer
	if !runDoctorInstall(onMac("\n", &out)) {
		t.Fatal("nothing required is missing")
	}
	if len(*ran) != 0 || !strings.Contains(out.String(), "Claude Code is optional") ||
		strings.Contains(out.String(), "Still missing") {
		t.Fatalf("ran %q\n%s", *ran, out.String())
	}

	var with bytes.Buffer
	yes := onMac("", &with)
	yes.interactive, yes.withClaude = false, true
	runDoctorInstall(yes)
	if !reflect.DeepEqual(*ran, []string{"sh -c curl -fsSL https://claude.ai/install.sh | bash"}) ||
		!strings.Contains(with.String(), "Still missing: claude") {
		t.Fatalf("--with-claude: ran %q\n%s", *ran, with.String())
	}
}

func TestFirstRunCheck(t *testing.T) {
	useTempConfig(t)
	dir := fakeTools(t, true, "git")
	now := time.Date(2026, 9, 28, 9, 0, 0, 0, time.UTC)
	check := func(args []string, interactive bool, input string, at time.Time) string {
		var out bytes.Buffer
		firstRunCheck(firstRunParams{
			args: args, interactive: interactive, in: answers(input), out: &out, now: at,
			install: onMac("", nil),
		})
		return out.String()
	}
	ran := swapInstall(t, nil, func() { writeExecutable(t, dir, "tmux") })

	if got := check([]string{"ls", "worktrees"}, true, "", now); got != "" {
		t.Fatalf("a data command says nothing: %q", got)
	}
	offer := check(nil, true, "n\n", now)
	if !strings.Contains(offer, "tmux — dev servers") || !strings.Contains(offer, "Later: crew doctor --install") {
		t.Fatalf("first run offers:\n%s", offer)
	}
	warn := check([]string{"dev", "start", "store-front/main"}, true, "", now)
	if !strings.Contains(warn, "crew needs tmux") || strings.Contains(warn, "[Y/n]") {
		t.Fatalf("offered once, then a warning:\n%s", warn)
	}
	if got := check([]string{"dev", "status"}, false, "", now.Add(10*time.Minute)); got != "" {
		t.Fatalf("warned at most hourly: %q", got)
	}
	if len(*ran) != 0 {
		t.Fatalf("nothing installed without a yes: %q", *ran)
	}
}

func TestFirstRunCheck_YesInstallsWithTheSameAnswers(t *testing.T) {
	useTempConfig(t)
	dir := fakeTools(t, true, "git")
	ran := swapInstall(t, nil, func() { writeExecutable(t, dir, "tmux") })
	var out bytes.Buffer

	// One reader: the offer's yes, then the install's own question.
	firstRunCheck(firstRunParams{
		interactive: true, in: answers("y\ny\n"), out: &out,
		now: time.Now(), install: onMac("", nil),
	})

	if !reflect.DeepEqual(*ran, []string{"brew install tmux"}) || strings.Contains(out.String(), "Still missing") {
		t.Fatalf("ran %q\n%s", *ran, out.String())
	}
}

func TestRenderRequirements(t *testing.T) {
	rows := []requirement{
		{Name: "tmux", OK: false, Required: true, Why: "why tmux", Install: "brew install tmux"},
		{Name: "claude", OK: true, Required: false, Why: "why claude", Install: "curl"},
	}
	want := "tmux\tmissing\trequired\twhy tmux\tbrew install tmux\nclaude\tok\toptional\twhy claude\tcurl\n"
	if got := renderRequirements(rows); got != want {
		t.Fatalf("got %q", got)
	}
}

func TestRequirements_VoiceAndDoctorSayTheSame(t *testing.T) {
	fakeTools(t, false)
	unmet := voice.UnmetRequirements()
	if len(unmet) != 2 || unmet[0].Install != exec.TmuxInstallHint() ||
		!strings.HasPrefix(unmet[1].Install, exec.ClaudeInstallHint()) {
		t.Fatalf("voice: %+v", unmet)
	}
	rows := listRequirements()
	if findRequirement(rows, "tmux").Install != exec.TmuxInstallHint() {
		t.Fatalf("doctor: %+v", rows)
	}
}
