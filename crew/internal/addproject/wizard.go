// Package addproject is the TUI's add-project walk: source, install,
// servers, bindings, check — one card per step, each an existing command
// applied when its key is pressed, each explaining the concept it asks
// about. It sits above project and workspace the way transfer does; only
// main imports it, and main wires it into the project list as
// project.AddWizard.
package addproject

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// ── Messages ──

// addedMsg: the clone landed (or the path was adopted) and the project is
// in the pool — the walk has a name from here on.
type addedMsg struct{ name string }

// factsMsg is the project as it stands, re-read after every step and every
// pop: the cards render facts, never what they think they recorded.
type factsMsg struct {
	proj     project.Project
	pool     []project.Project
	remote   string
	detected []exec.SetupStep // what the clone's files ask for, before any command
	devCmd   string
	hasEnv   bool
	// checkKept: a check record is on disk — a failed one f can work on.
	checkKept bool
}

// savedMsg: a step's command landed; re-read the facts.
type savedMsg struct{}

type errMsg struct{ err error }

// ── Fields ──

const (
	fieldURL = iota
	fieldName
	fieldPath
	fieldSetup
	fieldEnvCmd
	fieldPort
)

// ── Model ──

type Wizard struct {
	step step
	// name is set once the project is in the pool; "" while on the source
	// card, so esc there has nothing to keep.
	name  string
	facts factsMsg

	inputs     [6]textinput.Model
	focus      int
	nameEdited bool // the name field was typed in; the URL stops filling it
	adopting   bool // ctrl+p: the path field replaces the URL field

	// applying: a command is running (the clone); keys wait for it.
	applying bool
	pending  string

	// fromCheck: install or servers opened from the failed check card, so
	// they return there rather than walking forward.
	fromCheck bool

	check   checkState
	verdict verdict
	// stoppedAt: the step esc ended the walk on; stepFinish when it ran out.
	stoppedAt step

	spinner spinner.Model
	err     error
}

// New is what main hands project.AddWizard.
func New() app.Page { return newWizard() }

func newWizard() Wizard {
	var inputs [6]textinput.Model
	placeholders := [6]string{"git@github.com:owner/store-api.git", "store-api", "~/code/store-api", "make sync   (empty: the lockfile decides)", "make get-env   (empty: the copied .env is all)", "3000"}
	limits := [6]int{512, 64, 512, 256, 256, 6}
	for i := range inputs {
		inputs[i] = textinput.New()
		inputs[i].Placeholder = placeholders[i]
		inputs[i].CharLimit = limits[i]
	}
	w := Wizard{inputs: inputs, spinner: app.NewSpinner(), stoppedAt: stepFinish}
	w.inputs[fieldURL].Focus()
	return w
}

func (w Wizard) Title() string { return "Add project" }

// Init runs on the first push and again on every pop back from a sub-page
// (servers, bindings, logs): re-read the facts, and re-arm the check poll
// when a runner is alive — ticks go to the top page only, so the chain
// died under the page that was pushed. Nothing here changes the step.
func (w Wizard) Init() tea.Cmd {
	if w.name == "" {
		return w.inputs[w.focus].Cursor.BlinkCmd()
	}
	return w.reload()
}

func (w Wizard) currentFacts() facts {
	return facts{
		adopting:  w.adopting,
		detected:  w.facts.devCmd != "",
		targets:   len(targetsFor(w.facts.pool, w.name)) > 0,
		phase:     w.check.phase,
		canFix:    w.check.phase == checkFailed && w.facts.checkKept,
		fromCheck: w.fromCheck,
	}
}

// ── Update ──

func (w Wizard) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return w, nil

	case addedMsg:
		w.applying, w.pending, w.err = false, "", nil
		w.name = msg.name
		w.step = stepInstall
		focus := w.setFocus(fieldSetup)
		return w, tea.Batch(w.reload(), focus)

	case factsMsg:
		w.facts = msg
		if w.check.phase == checkRunning {
			return w, pollCheck(w.name)
		}
		return w, nil

	case savedMsg:
		w.err = nil
		return w, w.reload()

	case checkStartedMsg:
		w.applying, w.pending = false, ""
		w.check = checkState{phase: checkRunning, smoke: msg.smoke}
		w.err = nil
		return w, tea.Batch(w.spinner.Tick, pollCheck(w.name))

	case checkPollMsg:
		return w.applyPoll(msg)

	case fixReadyMsg:
		return w, tea.ExecProcess(msg.cmd, func(err error) tea.Msg {
			if err != nil {
				return errMsg{err}
			}
			// Back to this card, not out of the TUI: the walk has steps
			// left, and c is the user's to press.
			return savedMsg{}
		})

	case errMsg:
		w.applying, w.pending = false, ""
		if w.check.phase == checkRunning {
			// Nothing to follow: the start was refused, or the runner's
			// table could not be read. y is there to try again.
			w.check.phase = checkIdle
		}
		w.err = msg.err
		return w, nil

	case spinner.TickMsg:
		if !w.applying && w.check.phase != checkRunning {
			return w, nil
		}
		var cmd tea.Cmd
		w.spinner, cmd = w.spinner.Update(msg)
		return w, cmd

	case tea.KeyMsg:
		// Keys wait for a running command — all but ctrl+c: raw mode means
		// no SIGINT, and a clone stuck on a credential prompt must not hold
		// the terminal.
		if w.applying && msg.String() != "ctrl+c" {
			return w, nil
		}
		return w.handleKey(msg)
	}
	if w.step == stepSource || w.step == stepInstall || w.step == stepServers {
		var cmd tea.Cmd
		w.inputs[w.focus], cmd = w.inputs[w.focus].Update(msg)
		return w, cmd
	}
	return w, nil
}

func (w Wizard) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	// q is a letter on the cards with a text field (the port field refuses
	// it, but a typo there must not end the walk); ctrl+c quits everywhere.
	if msg.String() == "ctrl+c" || (key.Matches(msg, app.Keys.Quit) && w.step >= stepBindings) {
		return w, tea.Quit
	}
	switch w.step {
	case stepSource:
		return w.handleSourceKey(msg)
	case stepInstall:
		return w.handleInstallKey(msg)
	case stepServers:
		return w.handleServersKey(msg)
	case stepBindings:
		return w.handleBindingsKey(msg)
	case stepCheck:
		return w.handleCheckKey(msg)
	}
	if key.Matches(msg, app.Keys.Back) || msg.String() == "enter" {
		return w, func() tea.Msg { return app.PopPageMsg{} }
	}
	return w, nil
}

// stop ends the walk on the card in hand; what was recorded stays.
func (w Wizard) stop() (tea.Model, tea.Cmd) {
	if w.name == "" {
		// Nothing recorded yet: nothing to say either.
		return w, func() tea.Msg { return app.PopPageMsg{} }
	}
	w.stoppedAt = w.step
	if w.check.phase == checkRunning {
		// The runner goes on; the card does not. The poll chain ends here
		// so a later verdict cannot rewrite the finish card being read.
		w.verdict = verdictRunning
		w.check.phase = checkIdle
	}
	w.step = stepFinish
	w.err = nil
	return w, nil
}

// ── Source ──

func (w Wizard) handleSourceKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		if w.adopting {
			w.adopting, w.err = false, nil
			cmd := w.setFocus(fieldURL)
			return w, cmd
		}
		return w.stop()
	case "ctrl+p":
		w.adopting, w.err = true, nil
		cmd := w.setFocus(fieldPath)
		return w, cmd
	case "tab", "shift+tab":
		if w.focus == fieldName {
			if w.adopting {
				cmd := w.setFocus(fieldPath)
				return w, cmd
			}
			cmd := w.setFocus(fieldURL)
			return w, cmd
		}
		cmd := w.setFocus(fieldName)
		return w, cmd
	case "enter":
		return w.submitSource()
	}
	var cmd tea.Cmd
	w.inputs[w.focus], cmd = w.inputs[w.focus].Update(msg)
	// The name follows the URL (or the path) until it is typed in by hand.
	switch w.focus {
	case fieldURL, fieldPath:
		if !w.nameEdited {
			// SetValue keeps the cursor where it was; typing after a tab
			// should append, not insert into the suggested name.
			w.inputs[fieldName].SetValue(nameFromURL(w.inputs[w.focus].Value()))
			w.inputs[fieldName].CursorEnd()
		}
	case fieldName:
		w.nameEdited = w.inputs[fieldName].Value() != ""
	}
	return w, cmd
}

// submitSource is crew add project's decision for the card's fields: the
// URL clones into ClonePath(name), ctrl+p's path is adopted; NewTarget
// holds the refusals both share, asked before any clone.
func (w Wizard) submitSource() (tea.Model, tea.Cmd) {
	url := strings.TrimSpace(w.inputs[fieldURL].Value())
	name := strings.TrimSpace(w.inputs[fieldName].Value())
	path := ""
	if w.adopting {
		path = config.ExpandHome(strings.TrimSpace(w.inputs[fieldPath].Value()))
		if path == "" {
			w.err = errors.New("type the path of a checkout to adopt")
			return w, nil
		}
	} else if !exec.IsGitURL(url) {
		w.err = errors.New(notURLLine)
		return w, nil
	}
	// Until the name is typed in by hand it is the source's — decided here,
	// not only as the field is typed, so a pasted value counts too.
	if !w.nameEdited {
		if w.adopting {
			name = nameFromURL(path)
		} else {
			name = nameFromURL(url)
		}
	}
	if err := validName(name); err != nil {
		w.err = err
		return w, nil
	}
	if project.Get(name) != nil {
		// The likely reason: an earlier walk stopped early. Say where it
		// picks up rather than how to remove it.
		w.err = fmt.Errorf("project '%s' is already in the pool — crew project: %s", name, resumeAll)
		return w, nil
	}
	target, clone, err := project.NewTarget(name, path)
	if err != nil {
		w.err = err
		return w, nil
	}
	w.err = nil
	w.applying = true
	if clone {
		w.pending = fmt.Sprintf("Cloning %s → %s", name, config.Tildify(target))
	} else {
		w.pending = "Recording " + name
	}
	return w, tea.Batch(w.spinner.Tick, func() tea.Msg {
		if clone {
			if err := exec.Clone(url, target); err != nil {
				return errMsg{err}
			}
		}
		if err := project.Add(project.Project{Name: name, Path: target}); err != nil {
			return errMsg{err}
		}
		return addedMsg{name}
	})
}

// ── Install ──

func (w Wizard) handleInstallKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		if w.fromCheck {
			return w.backToCheck()
		}
		return w.stop()
	case "tab", "shift+tab":
		if w.focus == fieldSetup {
			cmd := w.setFocus(fieldEnvCmd)
			return w, cmd
		}
		cmd := w.setFocus(fieldSetup)
		return w, cmd
	case "enter":
		name := w.name
		setup := strings.TrimSpace(w.inputs[fieldSetup].Value())
		envCmd := strings.TrimSpace(w.inputs[fieldEnvCmd].Value())
		w = w.leaveForm(stepServers)
		focus := w.setFocus(fieldPort)
		return w, tea.Batch(focus, func() tea.Msg {
			if err := project.SetSetup(name, setup); err != nil {
				return errMsg{err}
			}
			if err := project.SetEnvCmd(name, envCmd); err != nil {
				return errMsg{err}
			}
			return savedMsg{}
		})
	}
	var cmd tea.Cmd
	w.inputs[w.focus], cmd = w.inputs[w.focus].Update(msg)
	return w, cmd
}

// leaveForm moves on from install or servers: forward in the walk, or
// back to the check card these were opened from.
func (w Wizard) leaveForm(next step) Wizard {
	w.err = nil
	if w.fromCheck {
		w.fromCheck = false
		w.step = stepCheck
		return w
	}
	w.step = next
	return w
}

func (w Wizard) backToCheck() (tea.Model, tea.Cmd) {
	w.fromCheck, w.err = false, nil
	w.step = stepCheck
	return w, nil
}

// installPreview is what a checkout would run with the fields as typed —
// composed purely over what the clone's files were read for once.
func (w Wizard) installPreview() string {
	steps := exec.ComposeSteps(w.facts.detected, strings.TrimSpace(w.inputs[fieldSetup].Value()), strings.TrimSpace(w.inputs[fieldEnvCmd].Value()))
	return exec.StepLine(steps)
}

// ── Servers ──

func (w Wizard) handleServersKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		if w.fromCheck {
			return w.backToCheck()
		}
		return w.stop()
	case "n":
		w = w.leaveForm(stepBindings)
		return w, nil
	case "a":
		page := project.NewDevServerView(w.name)
		return w, func() tea.Msg { return app.PushPageMsg{Page: page} }
	case "enter":
		if w.facts.devCmd == "" {
			return w, nil
		}
		port, err := strconv.Atoi(strings.TrimSpace(w.inputs[fieldPort].Value()))
		if err != nil || port <= 0 {
			w.err = errors.New("the port the server would listen on by hand — detection cannot know it")
			return w, nil
		}
		name, cmd := w.name, w.facts.devCmd
		w.err = nil
		return w, func() tea.Msg {
			if err := project.AddDevServer(name, project.DevServer{Name: name, Port: port, Command: cmd}); err != nil {
				return errMsg{err}
			}
			return savedMsg{}
		}
	}
	// Digits only reach the port field: a letter is a mistyped key, not a
	// port, and must neither land in the field nor end the walk.
	if msg.Type == tea.KeyRunes && strings.Trim(string(msg.Runes), "0123456789") != "" {
		return w, nil
	}
	var cmd tea.Cmd
	w.inputs[fieldPort], cmd = w.inputs[fieldPort].Update(msg)
	return w, cmd
}

// ── Bindings ──

func (w Wizard) handleBindingsKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		return w.stop()
	case "n":
		w.step, w.err = stepCheck, nil
		return w, nil
	case "b":
		if len(targetsFor(w.facts.pool, w.name)) == 0 {
			return w, nil
		}
		page := project.NewBindingsView(w.name)
		return w, func() tea.Msg { return app.PushPageMsg{Page: page} }
	}
	return w, nil
}

// ── Commands ──

func (w *Wizard) setFocus(f int) tea.Cmd {
	w.focus = f
	for i := range w.inputs {
		if i == f {
			w.inputs[i].Focus()
		} else {
			w.inputs[i].Blur()
		}
	}
	return w.inputs[f].Cursor.BlinkCmd()
}

// reload reads the project as it stands: the pool entry, the pool (for
// binding targets), the remote, and what the clone's files ask for.
func (w Wizard) reload() tea.Cmd {
	name := w.name
	return func() tea.Msg {
		p := project.Get(name)
		if p == nil {
			return errMsg{fmt.Errorf("project '%s' is gone from the pool", name)}
		}
		pool, _ := project.List()
		return factsMsg{
			proj:      *p,
			pool:      pool,
			remote:    project.RemoteOf(*p),
			detected:  exec.DetectSetup(p.Path),
			devCmd:    exec.DetectDevCommand(p.Path),
			hasEnv:    exec.HasEnvFiles(p.Path),
			checkKept: workspace.CheckExists(name),
		}
	}
}

// envMissing: the one failure the default path walks into — a URL clone
// has no .env (gitignored) and a check has no sibling worktree to copy one
// from, so with servers and no env command a server that needs one dies.
func (w Wizard) envMissing() bool {
	return len(w.facts.proj.DevServers) > 0 && !w.facts.hasEnv && w.facts.proj.EnvCmd == ""
}

// finish is the closing card's facts.
func (w Wizard) finish() finishCard {
	return finishCard{Project: w.facts.proj, Remote: w.facts.remote, Verdict: w.verdict, StoppedAt: w.stoppedAt}
}

// wsPlaceholder is the workspace the finish card's next line names.
const wsPlaceholder = "<workspace>"

func stepHeader(s step, suffix string) string {
	return fmt.Sprintf("  Add project · %d of 5 · %s%s\n\n", int(s)+1, s.label(), suffix)
}

// pollEvery is how often the check card looks at the runner.
const pollEvery = 2 * time.Second
