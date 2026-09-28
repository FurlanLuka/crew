package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	osexec "os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/charmbracelet/x/term"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/voice"
)

// requirement is one tool crew relies on, as crew doctor lists it.
type requirement struct {
	Name     string `json:"name"`
	OK       bool   `json:"ok"`
	Required bool   `json:"required"`
	Why      string `json:"why"`
	Install  string `json:"install"`
}

func listRequirements() []requirement {
	return []requirement{
		{
			Name:     "tmux",
			OK:       exec.HasTmux(),
			Required: true,
			Why:      "dev servers, setup runners and checks run in tmux",
			Install:  exec.TmuxInstallHint(),
		},
		{
			Name:     "git",
			OK:       exec.HasGit(),
			Required: true,
			Why:      "projects and worktrees are git checkouts",
			Install:  exec.GitInstallHint(),
		},
		{
			Name: "claude",
			OK:   voice.ClaudeBin() != "",
			// crew works with any agent; only Voice OS and crew claude need Claude Code.
			Required: false,
			Why:      "Voice OS and crew claude run Claude Code",
			Install:  exec.ClaudeInstallHint(),
		},
	}
}

func missingRequired(rows []requirement) []string {
	var names []string
	for _, row := range rows {
		if row.Required && !row.OK {
			names = append(names, row.Name)
		}
	}
	return names
}

func findRequirement(rows []requirement, name string) requirement {
	for _, row := range rows {
		if row.Name == name {
			return row
		}
	}
	return requirement{}
}

// installStep is one command that installs one or more missing tools.
type installStep struct {
	Argv []string
	// Sudo: it asks for the password, so the prompt defaults to no.
	Sudo bool
	// Hint replaces Argv when there is nothing crew can run (no package manager).
	Hint string
}

func (step installStep) String() string {
	if step.Hint != "" {
		return step.Hint
	}
	if len(step.Argv) == 3 && step.Argv[0] == "sh" && step.Argv[1] == "-c" {
		return step.Argv[2]
	}
	return strings.Join(step.Argv, " ")
}

// installSteps is the plan for the required tools that are missing. Pure: the
// OS and what is on PATH come in.
func installSteps(goos string, has func(string) bool, names []string) []installStep {
	if len(names) == 0 {
		return nil
	}
	if goos == "darwin" {
		var steps []installStep
		for _, name := range names {
			switch {
			case name == "git":
				steps = append(steps, installStep{Argv: []string{"xcode-select", "--install"}})
			case has("brew"):
				steps = append(steps, installStep{Argv: []string{"brew", "install", name}})
			default:
				steps = append(steps, installStep{Hint: fmt.Sprintf("install Homebrew (https://brew.sh), then brew install %s", name)})
			}
		}
		return mergeBrew(steps)
	}
	list := strings.Join(names, " ")
	switch {
	case has("apt-get"):
		return []installStep{{Argv: []string{"sh", "-c", "sudo apt-get update -qq && sudo apt-get install -y " + list}, Sudo: true}}
	case has("dnf"):
		return []installStep{{Argv: []string{"sh", "-c", "sudo dnf install -y " + list}, Sudo: true}}
	case has("pacman"):
		return []installStep{{Argv: []string{"sh", "-c", "sudo pacman -S --noconfirm " + list}, Sudo: true}}
	}
	return []installStep{{Hint: "install " + list + " with your package manager"}}
}

// mergeBrew folds several brew installs into one command.
func mergeBrew(steps []installStep) []installStep {
	var merged []installStep
	brewAt := -1
	for _, step := range steps {
		if len(step.Argv) >= 3 && step.Argv[0] == "brew" {
			if brewAt >= 0 {
				merged[brewAt].Argv = append(merged[brewAt].Argv, step.Argv[2:]...)
				continue
			}
			brewAt = len(merged)
		}
		merged = append(merged, step)
	}
	return merged
}

var claudeInstallStep = installStep{Argv: []string{"sh", "-c", "curl -fsSL https://claude.ai/install.sh | bash"}}

func hasOnPath(name string) bool {
	_, err := osexec.LookPath(name)
	return err == nil
}

// runInstall runs an install command on the terminal, its output to out (never
// stdout under --json); tests swap it.
var runInstall = func(argv []string, out io.Writer) error {
	cmd := osexec.Command(argv[0], argv[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, out, out
	return cmd.Run()
}

// readAnswer reads one yes/no line. No input at all (EOF) is no, whatever the
// default: nobody answered.
func readAnswer(in *bufio.Reader, defaultYes bool) bool {
	line, err := in.ReadString('\n')
	answer := strings.ToLower(strings.TrimSpace(line))
	if answer == "" {
		return err == nil && defaultYes
	}
	return answer == "y" || answer == "yes"
}

func askYesNo(in *bufio.Reader, out io.Writer, question string, defaultYes bool) bool {
	choice := "[y/N]"
	if defaultYes {
		choice = "[Y/n]"
	}
	fmt.Fprintf(out, "%s %s ", question, choice)
	return readAnswer(in, defaultYes)
}

type installOptions struct {
	interactive bool
	withClaude  bool
	in          *bufio.Reader
	out         io.Writer
	// The OS and what is on PATH decide the commands; tests set both.
	goos string
	has  func(string) bool
}

func defaultInstallOptions() installOptions {
	return installOptions{goos: runtime.GOOS, has: hasOnPath}
}

// runDoctorInstall installs what is missing and says what is still missing.
// Returns false when a required tool is still missing.
func runDoctorInstall(opts installOptions) bool {
	rows := listRequirements()
	steps := installSteps(opts.goos, opts.has, missingRequired(rows))
	runnable := 0
	for _, step := range steps {
		if step.Hint == "" {
			runnable++
		}
	}
	for _, step := range steps {
		if step.Hint != "" {
			fmt.Fprintf(opts.out, "Install by hand: %s\n", step.Hint)
		}
	}
	if runnable > 0 {
		fmt.Fprintln(opts.out, "Installs:")
		sudo := false
		for _, step := range steps {
			if step.Hint == "" {
				fmt.Fprintf(opts.out, "  %s\n", step)
				sudo = sudo || step.Sudo
			}
		}
		if !opts.interactive || askYesNo(opts.in, opts.out, "Run them now?", !sudo) {
			for _, step := range steps {
				if step.Hint == "" {
					runStep(step, opts.out)
				}
				// It only opens Apple's installer; the tools arrive when that dialog finishes.
				if len(step.Argv) > 0 && step.Argv[0] == "xcode-select" {
					fmt.Fprintln(opts.out, "Finish the Command Line Tools install in the dialog, then run crew doctor again.")
				}
			}
		}
	}

	claude := findRequirement(rows, "claude")
	if !claude.OK {
		want := opts.withClaude
		if opts.interactive && !want {
			fmt.Fprintf(opts.out, "Claude Code is optional: %s.\n", claude.Why)
			want = askYesNo(opts.in, opts.out, fmt.Sprintf("Install it (%s)?", claudeInstallStep), false)
		}
		if want {
			runStep(claudeInstallStep, opts.out)
		}
	}

	after := listRequirements()
	for _, row := range after {
		if !row.OK && (row.Required || opts.withClaude) {
			fmt.Fprintf(opts.out, "Still missing: %s\n", row.Name)
		}
	}
	return len(missingRequired(after)) == 0
}

func runStep(step installStep, out io.Writer) {
	debug.Log("requirements", "%s", step)
	if err := runInstall(step.Argv, out); err != nil {
		debug.Log("requirements", "failed: %v", err)
		fmt.Fprintf(out, "%s failed: %v\n", step, err)
	}
}

func isStdoutTerminal() bool { return term.IsTerminal(os.Stdout.Fd()) }

func cmdDoctor() {
	args := os.Args[2:]
	args, install := extractFlag(args, "--install")
	args, yes := extractFlag(args, "--yes")
	args, withClaude := extractFlag(args, "--with-claude")
	if len(args) > 0 {
		fmt.Fprintln(os.Stderr, "Usage: crew doctor [--install [--yes] [--with-claude]]")
		os.Exit(1)
	}

	if install {
		interactive, err := installMode(isTerminal() && isStdoutTerminal() && !jsonOutput, yes)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		opts := defaultInstallOptions()
		opts.interactive, opts.withClaude = interactive, withClaude
		opts.in, opts.out = bufio.NewReader(os.Stdin), human
		// What is still missing shows in the rows below and sets the exit code.
		runDoctorInstall(opts)
	}

	rows := listRequirements()
	if jsonOutput {
		printJSON(rows)
	} else {
		fmt.Print(renderRequirements(rows))
	}
	os.Exit(doctorExitCode(rows))
}

// installMode: asking needs a terminal; --yes installs without asking. Pure.
func installMode(isTTY, yes bool) (interactive bool, err error) {
	if yes {
		return false, nil
	}
	if !isTTY {
		return false, errors.New("crew doctor --install asks before installing: run it at a terminal, or pass --yes")
	}
	return true, nil
}

// doctorExitCode: 1 while a required tool is missing. Pure.
func doctorExitCode(rows []requirement) int {
	if len(missingRequired(rows)) > 0 {
		return 1
	}
	return 0
}

func renderRequirements(rows []requirement) string {
	var b strings.Builder
	for _, row := range rows {
		status, need := "ok", "optional"
		if !row.OK {
			status = "missing"
		}
		if row.Required {
			need = "required"
		}
		fmt.Fprintf(&b, "%s\t%s\t%s\t%s\t%s\n", row.Name, status, need, row.Why, row.Install)
	}
	return b.String()
}

// --- first run -------------------------------------------------------------

type requirementsState struct {
	// Tools the install was offered for: one that goes missing later is offered too.
	Offered  []string  `json:"offered"`
	WarnedAt time.Time `json:"warned_at"`
}

func (state requirementsState) hasOffered(names []string) bool {
	for _, name := range names {
		if !slices.Contains(state.Offered, name) {
			return false
		}
	}
	return true
}

func requirementsStatePath() string {
	return filepath.Join(config.ConfigDir, "requirements.json")
}

// A missing or unreadable file is a first run, never an error.
func readRequirementsState() requirementsState {
	var state requirementsState
	data, err := os.ReadFile(requirementsStatePath())
	if err == nil {
		_ = json.Unmarshal(data, &state)
	}
	return state
}

func writeRequirementsState(state requirementsState) {
	data, _ := json.Marshal(state)
	_ = os.WriteFile(requirementsStatePath(), data, 0o644)
}

// needsTools says whether a command runs tmux or git, so a missing one is
// worth saying before it fails; data commands, which agents call constantly,
// and crew's own internals are left alone. A word crew does not know is the
// crew <ws>/<wt> shortcut only with a slash. Pure.
func needsTools(args []string) bool {
	if len(args) == 0 {
		return true
	}
	switch args[0] {
	case "add", "rm", "setup", "verify", "check", "fix", "claude", "edit", "launch", "workspace", "project", "migrate":
		return true
	case "dev":
		return len(args) < 2 || args[1] != "_proxy"
	}
	return !strings.HasPrefix(args[0], "-") && strings.Contains(args[0], "/")
}

type firstRunAction int

const (
	firstRunNothing firstRunAction = iota
	firstRunOffer
	firstRunWarn
)

// decideFirstRun: offer the install once at a terminal; otherwise warn, at
// most hourly. Pure.
func decideFirstRun(missing []string, interactive bool, state requirementsState, now time.Time) firstRunAction {
	switch {
	case len(missing) == 0:
		return firstRunNothing
	case interactive && !state.hasOffered(missing):
		return firstRunOffer
	case now.Sub(state.WarnedAt) >= time.Hour:
		return firstRunWarn
	}
	return firstRunNothing
}

// checkRequirementsOnStart runs before every command crew dispatches.
func checkRequirementsOnStart(args []string) {
	firstRunCheck(firstRunParams{
		args:        args,
		interactive: isTerminal() && isStdoutTerminal() && !jsonOutput,
		in:          bufio.NewReader(os.Stdin),
		// Never stdout: a command's document there must stay parseable.
		out:     os.Stderr,
		now:     time.Now(),
		install: defaultInstallOptions(),
	})
}

type firstRunParams struct {
	args        []string
	interactive bool
	in          *bufio.Reader
	out         io.Writer
	now         time.Time
	install     installOptions
}

func firstRunCheck(params firstRunParams) {
	if !needsTools(params.args) {
		return
	}
	rows := listRequirements()
	missing := missingRequired(rows)
	state := readRequirementsState()

	switch decideFirstRun(missing, params.interactive, state, params.now) {
	case firstRunOffer:
		fmt.Fprintln(params.out, "crew needs a few tools it cannot find:")
		for _, name := range missing {
			row := findRequirement(rows, name)
			fmt.Fprintf(params.out, "  %s — %s\n", row.Name, row.Why)
		}
		for _, name := range missing {
			if !slices.Contains(state.Offered, name) {
				state.Offered = append(state.Offered, name)
			}
		}
		writeRequirementsState(state)
		if askYesNo(params.in, params.out, "Run crew doctor --install now?", true) {
			opts := params.install
			opts.interactive, opts.in, opts.out = true, params.in, params.out
			runDoctorInstall(opts)
		} else {
			fmt.Fprintln(params.out, "Later: crew doctor --install")
		}
	case firstRunWarn:
		for _, name := range missing {
			row := findRequirement(rows, name)
			fmt.Fprintf(params.out, "crew needs %s (%s): %s — or run crew doctor --install\n", row.Name, row.Why, row.Install)
		}
		state.WarnedAt = params.now
		writeRequirementsState(state)
	}
}
