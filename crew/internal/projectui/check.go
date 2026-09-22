package projectui

import (
	"fmt"
	osexec "os/exec"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// checkCard runs crew check project in place — for the wizard's last step
// and the page's Check section alike. It polls the runner the way the
// import wizard's workspace card does rather than embedding the worktree
// page, whose pass path quits the whole TUI. SetupStatus is what applies
// the verdict on a check ref — a clean one removes the target — so the
// card keeps the last Status it read and never resolves the ref after a
// pass. The host reads the phase after every Update.

// checkStartedMsg: the runner is spawned; smoke says which check it is.
type checkStartedMsg struct{ smoke bool }

// checkPollMsg is the runner's table, looked at again every pollEvery
// while it is alive.
type checkPollMsg struct{ status workspace.Status }

// fixReadyMsg carries the Claude command f built; the host execs it.
type fixReadyMsg struct{ cmd *osexec.Cmd }

// pollEvery is how often the card looks at the runner; a var so tests do
// not wait on it.
var pollEvery = 2 * time.Second

// checkPhase is where the check stands.
type checkPhase int

const (
	checkIdle checkPhase = iota
	checkRunning
	checkPassed
	checkFailed
	checkConfirm // c on a checkout with unmerged fix commits asks first
)

type checkCard struct {
	name  string
	phase checkPhase
	smoke bool
	// starting: StartCheck is on its way; the phase turns running only
	// once the runner is spawned — a refused start is an error, never a
	// run to follow.
	starting bool
	status   *workspace.Status
	// health is what the failed run recorded, off the last Status.
	health  *workspace.Health
	now     time.Time
	spinner spinner.Model
	// base is the project's clone, for the unmerged-fix guard.
	base string
	// kept: the failed check's record is on disk for f to work on.
	kept bool
}

func newCheckCard(name, base string) checkCard {
	return checkCard{name: name, base: base, spinner: app.NewSpinner()}
}

// start is crew check project <name>: the target made from nothing, one
// runner. The card follows it once the runner is spawned.
func (c checkCard) start(smoke bool) (checkCard, tea.Cmd) {
	name := c.name
	c.starting, c.smoke = true, smoke
	return c, tea.Batch(c.spinner.Tick, func() tea.Msg {
		if err := workspace.StartCheck(name, workspace.CheckoutOptions{Install: true, Smoke: smoke}); err != nil {
			return errMsg{err}
		}
		return checkStartedMsg{smoke: smoke}
	})
}

// adopt seeds the card from what the disk says, so a check this screen
// did not start is still the card's to act on: a runner alive is
// followed, a kept failure gets l, f and the unmerged-fix guard on c. A
// card mid-run keeps its own state.
func (c checkCard) adopt(info workspace.CheckInfo) (checkCard, tea.Cmd) {
	switch {
	case c.phase == checkRunning || c.starting:
		return c, pollCheck(c.name)
	case info.State == workspace.CheckRunning:
		c.phase, c.status, c.health = checkRunning, info.Status, nil
		return c, tea.Batch(c.spinner.Tick, pollCheck(c.name))
	case info.State == workspace.CheckFailed && c.phase != checkConfirm:
		// The page's c always smokes; a failure from disk reads as one.
		c.phase, c.status, c.health, c.smoke, c.kept = checkFailed, info.Status, info.Health, true, true
	case info.State != workspace.CheckFailed && c.phase == checkFailed:
		// The record went (rm worktree check/<name>): nothing left to act on.
		c.phase, c.health, c.kept = checkIdle, nil, false
	}
	return c, nil
}

// Update takes the card's own messages; keys go through handleKey.
func (c checkCard) Update(msg tea.Msg) (checkCard, tea.Cmd) {
	switch msg := msg.(type) {
	case checkStartedMsg:
		c.starting = false
		c.phase, c.smoke, c.status, c.health, c.kept = checkRunning, msg.smoke, nil, nil, false
		return c, tea.Batch(c.spinner.Tick, pollCheck(c.name))
	case checkPollMsg:
		return c.applyPoll(msg)
	case errMsg:
		c.starting = false
		if c.phase == checkRunning {
			// Nothing to follow: the start was refused, or the runner's
			// table could not be read. c is there to try again.
			c.phase = checkIdle
		}
		return c, nil
	case spinner.TickMsg:
		if !c.starting && c.phase != checkRunning {
			return c, nil
		}
		var cmd tea.Cmd
		c.spinner, cmd = c.spinner.Update(msg)
		return c, cmd
	}
	return c, nil
}

// handleKey takes the keys the card owns on a failed or running check —
// l logs, f fix, c again, the confirm's y/n — and reports whether it did.
func (c checkCard) handleKey(msg tea.KeyMsg) (checkCard, tea.Cmd, bool) {
	switch c.phase {
	case checkRunning:
		if msg.String() == "l" {
			return c, c.openLogs(), true
		}
	case checkConfirm:
		// A destructive yes is spelled out; only n or esc walk it back.
		switch msg.String() {
		case "y", "Y":
			c.phase = checkFailed
			c, cmd := c.start(c.smoke)
			return c, cmd, true
		case "n", "N", "esc":
			c.phase = checkFailed
		}
		return c, nil, true
	case checkFailed:
		switch msg.String() {
		case "c":
			if c.unmergedFix() > 0 {
				c.phase = checkConfirm
				return c, nil, true
			}
			c, cmd := c.start(c.smoke)
			return c, cmd, true
		case "l":
			return c, c.openLogs(), true
		case "f":
			if !c.canFix() {
				return c, nil, true
			}
			name := c.name
			return c, func() tea.Msg {
				cmd, err := buildFix(name)
				if err != nil {
					return errMsg{err}
				}
				return fixReadyMsg{cmd}
			}, true
		}
	}
	return c, nil, false
}

// canFix: a failed check with its record still there for Claude to work
// on. Pure: kept is read off the disk once, by adopt or by the verdict.
func (c checkCard) canFix() bool { return c.phase == checkFailed && c.kept }

func pollCheck(name string) tea.Cmd {
	return func() tea.Msg {
		st, err := workspace.SetupStatus(workspace.CheckRef(name))
		if err != nil {
			return errMsg{err}
		}
		return checkPollMsg{status: st}
	}
}

// applyPoll reads the verdict off the runner's table: alive → look again
// in a moment; done → passed or failed, the host reloads its facts.
func (c checkCard) applyPoll(msg checkPollMsg) (checkCard, tea.Cmd) {
	if c.phase != checkRunning {
		return c, nil
	}
	st := msg.status
	c.status, c.now = &st, time.Now()
	phase, _ := verdictFor(st, c.smoke)
	c.phase = phase
	switch phase {
	case checkRunning:
		name := c.name
		return c, tea.Tick(pollEvery, func(time.Time) tea.Msg { return pollCheck(name)() })
	case checkFailed:
		// A failed run keeps its record; f has something to work on.
		c.health, c.kept = st.Health(), true
	}
	return c, nil
}

// verdictFor reads a runner's table: alive, passed (which check it was
// decides the wording), or failed. Pure.
func verdictFor(st workspace.Status, smoke bool) (checkPhase, verdict) {
	switch {
	case st.Running():
		return checkRunning, verdictNone
	case st.Passed() && smoke:
		return checkPassed, verdictPassed
	case st.Passed():
		return checkPassed, verdictInstallOnly
	}
	return checkFailed, verdictFailed
}

// verdict is what a check ended with, as a card says it afterwards.
func (c checkCard) verdict() verdict {
	_, v := verdictFor(*c.status, c.smoke)
	return v
}

// done: the last run ended, one way or the other.
func (c checkCard) done() bool { return c.phase == checkPassed || c.phase == checkFailed }

// unmergedFix counts what f left on the scratch branch that the base does
// not have — a c would replace the checkout and throw it away. 0 when the
// checkout is gone (a checkout-stage failure leaves none).
func (c checkCard) unmergedFix() int {
	ref := workspace.CheckRef(c.name)
	dir := workspace.WorktreePath(ref, c.name)
	return exec.CommitsAhead(dir, workspace.DefaultBranch(c.base), workspace.BranchName(ref, c.name))
}

// buildFix is crew fix check/<name>: Claude in the check's checkout with
// the recorded failure. Kept apart from the exec so a test can look at
// the command.
func buildFix(name string) (*osexec.Cmd, error) {
	res, err := workspace.Resolve(workspace.CheckRef(name))
	if err != nil {
		return nil, err
	}
	return workspace.FixCommand(res, workspace.FixAnomalies(res))
}

func (c checkCard) openLogs() tea.Cmd {
	logs := workspace.NewSetupLogsView(workspace.CheckRef(c.name), []string{c.name})
	return func() tea.Msg { return app.PushPageMsg{Page: logs} }
}

// startingLine is the card's one line while the start is on its way.
func (c checkCard) startingLine() string {
	return c.spinner.View() + " starting the check — a fresh checkout"
}

// runningLine is the card's one line while the runner is alive and has
// not written yet.
func (c checkCard) runningLine() string {
	kind := "checking"
	if !c.smoke {
		kind = "checking the install of"
	}
	return fmt.Sprintf("%s %s %s — one runner, a fresh checkout", c.spinner.View(), kind, c.name)
}

// table is the runner's rows as last read, "" before the first poll.
func (c checkCard) table() string {
	if c.status == nil {
		return ""
	}
	return workspace.RenderSetupTable(*c.status, "▸", c.now)
}

// confirmLine is the question c asks over an unmerged fix.
func (c checkCard) confirmLine() string {
	return fmt.Sprintf("the fix on crew/check/%s/%s is not merged into the base — checking again replaces the checkout and loses it", c.name, c.name)
}
