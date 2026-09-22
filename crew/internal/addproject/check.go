package addproject

import (
	"fmt"
	osexec "os/exec"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// The check step runs crew check project in place. The card polls the
// runner the way the import wizard's workspace card does rather than
// embedding the worktree page, whose pass path quits the whole TUI.
// SetupStatus is what applies the verdict on a check ref — a clean one
// removes the target — so the card keeps the last Status it read and
// never resolves the ref after a pass.

// checkStartedMsg: the runner is spawned; smoke says which check it is.
type checkStartedMsg struct{ smoke bool }

// checkPollMsg is the runner's table, looked at again every pollEvery
// while it is alive.
type checkPollMsg struct{ status workspace.Status }

// fixReadyMsg carries the Claude command f built; Update execs it.
type fixReadyMsg struct{ cmd *osexec.Cmd }

type checkState struct {
	phase  checkPhase
	smoke  bool
	status *workspace.Status
	// health is what the failed run recorded, off the last Status.
	health *workspace.Health
	now    time.Time
}

func (w Wizard) handleCheckKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch w.check.phase {
	case checkRunning:
		switch msg.String() {
		case "esc":
			return w.stop()
		case "l":
			return w, w.openLogs()
		}
		return w, nil
	case checkConfirm:
		// A destructive yes is spelled out; only n or esc walk it back.
		switch msg.String() {
		case "y", "Y":
			w.check.phase = checkFailed
			return w.startCheck(w.check.smoke)
		case "n", "N", "esc":
			w.check.phase = checkFailed
		}
		return w, nil
	case checkFailed:
		switch msg.String() {
		case "esc", "n":
			w.verdict = verdictFailed
			if msg.String() == "esc" {
				return w.stop()
			}
			w.step = stepFinish
			return w, nil
		case "t":
			return w.reopen(stepInstall, fieldSetup)
		case "s":
			return w.reopen(stepServers, fieldPort)
		case "c":
			if w.unmergedFix() > 0 {
				w.check.phase = checkConfirm
				return w, nil
			}
			return w.startCheck(w.check.smoke)
		case "l":
			return w, w.openLogs()
		case "f":
			if !w.currentFacts().canFix {
				return w, nil
			}
			name := w.name
			return w, func() tea.Msg {
				cmd, err := buildFix(name)
				if err != nil {
					return errMsg{err}
				}
				return fixReadyMsg{cmd}
			}
		}
		return w, nil
	}
	switch msg.String() {
	case "esc":
		return w.stop()
	case "y":
		return w.startCheck(true)
	case "i":
		return w.startCheck(false)
	case "n":
		w.step, w.err = stepFinish, nil
		return w, nil
	}
	return w, nil
}

// reopen takes the check card's t or s to its form, which returns here.
func (w Wizard) reopen(s step, field int) (tea.Model, tea.Cmd) {
	w.fromCheck, w.err = true, nil
	w.step = s
	w.inputs[fieldSetup].SetValue(w.facts.proj.Setup)
	w.inputs[fieldSetup].CursorEnd()
	w.inputs[fieldEnvCmd].SetValue(w.facts.proj.EnvCmd)
	w.inputs[fieldEnvCmd].CursorEnd()
	cmd := w.setFocus(field)
	return w, cmd
}

// startCheck is crew check project <name>: the target made from nothing,
// one runner. The card follows it once the runner is spawned — a refused
// start (a runner already alive, a port that cannot be reserved) is an
// error on the idle card, never a run to follow.
func (w Wizard) startCheck(smoke bool) (tea.Model, tea.Cmd) {
	name := w.name
	w.err = nil
	w.applying, w.pending = true, "starting the check — a fresh checkout"
	return w, tea.Batch(w.spinner.Tick, func() tea.Msg {
		if err := workspace.StartCheck(name, workspace.CheckoutOptions{Install: true, Smoke: smoke}); err != nil {
			return errMsg{err}
		}
		return checkStartedMsg{smoke: smoke}
	})
}

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
// in a moment; done → passed goes to the finish card, failed stays here
// with the health block and the keys out of it.
func (w Wizard) applyPoll(msg checkPollMsg) (tea.Model, tea.Cmd) {
	if w.check.phase != checkRunning {
		return w, nil
	}
	st := msg.status
	w.check.status, w.check.now = &st, time.Now()
	phase, v := verdictFor(st, w.check.smoke)
	w.check.phase = phase
	switch phase {
	case checkRunning:
		return w, tea.Tick(pollEvery, func(time.Time) tea.Msg { return pollCheck(w.name)() })
	case checkPassed:
		w.verdict = v
		w.step = stepFinish
	case checkFailed:
		w.check.health = st.Health()
	}
	return w, w.reload()
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

// unmergedFix counts what f left on the scratch branch that the base does
// not have — a c would replace the checkout and throw it away. 0 when the
// checkout is gone (a checkout-stage failure leaves none).
func (w Wizard) unmergedFix() int {
	ref := workspace.CheckRef(w.name)
	dir := workspace.WorktreePath(ref, w.name)
	return exec.CommitsAhead(dir, workspace.DefaultBranch(w.facts.proj.Path), workspace.BranchName(ref, w.name))
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

func (w Wizard) openLogs() tea.Cmd {
	logs := workspace.NewSetupLogsView(workspace.CheckRef(w.name), []string{w.name})
	return func() tea.Msg { return app.PushPageMsg{Page: logs} }
}

// runningLine is the card's one line while the runner is alive.
func (w Wizard) runningLine() string {
	kind := "checking"
	if !w.check.smoke {
		kind = "checking the install of"
	}
	return fmt.Sprintf("%s %s %s — one runner, a fresh checkout", w.spinner.View(), kind, w.name)
}
