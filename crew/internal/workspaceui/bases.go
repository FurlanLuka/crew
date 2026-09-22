package workspaceui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// basePane is the "Branching from" table a creation shows — fetched when
// the card or form opens, pulled on ctrl+p, drawn by RenderBaseTable. The
// wizard's create card and the page's new-worktree form both hold one. A
// generation counter makes a late answer for a card that was left fall on
// the floor.

// basesMsg is the table, fetched or pulled; gen says which opening asked.
type basesMsg struct {
	gen      int
	statuses []workspace.BaseStatus
	pulled   []error
}

type basePane struct {
	statuses []workspace.BaseStatus
	phase    workspace.BasePhase
	gen      int
}

// fetch asks for the table of ws; the spinner tick rides along.
func (b *basePane) fetch(ws *workspace.Workspace, tick tea.Cmd) tea.Cmd {
	b.gen++
	b.statuses, b.phase = nil, workspace.BaseLoading
	gen := b.gen
	return tea.Batch(tick, func() tea.Msg {
		return basesMsg{gen: gen, statuses: workspace.BaseStatuses(ws)}
	})
}

// pull is ctrl+p: fast-forward the stale bases, then read the table again.
// Nothing to do unless the table is there and something is behind.
func (b *basePane) pull(ws *workspace.Workspace, tick tea.Cmd) tea.Cmd {
	if !b.stale() {
		return nil
	}
	b.gen++
	b.phase = workspace.BasePulling
	gen, statuses := b.gen, b.statuses
	return tea.Batch(tick, func() tea.Msg {
		pulled := workspace.UpdateBases(ws, statuses)
		return basesMsg{gen: gen, statuses: workspace.BaseStatuses(ws), pulled: pulled}
	})
}

// apply takes an answer: a stale generation changes nothing; otherwise
// the table is in, and what the pull could not do comes back as the error.
func (b basePane) apply(msg basesMsg) (basePane, error) {
	if msg.gen != b.gen {
		return b, nil
	}
	b.statuses, b.phase = msg.statuses, workspace.BaseReady
	return b, joinErrs(msg.pulled)
}

// drop: the card or form was left; an answer still in flight is not wanted.
func (b *basePane) drop() { b.gen++ }

// ready: the table is there to act on.
func (b basePane) ready() bool { return b.phase == workspace.BaseReady }

// stale: the table is there and a base is behind — ctrl+p has work.
func (b basePane) stale() bool { return b.ready() && workspace.Stale(b.statuses) }

// busy: a fetch or a pull is running — the spinner turns.
func (b basePane) busy() bool { return !b.ready() }

func (b basePane) render(spinner string) string {
	return workspace.RenderBaseTable(b.statuses, b.phase, spinner)
}

// joinErrs is one error line out of several pull failures, nil for none.
// Pure.
func joinErrs(errs []error) error {
	if len(errs) == 0 {
		return nil
	}
	parts := make([]string, 0, len(errs))
	for _, err := range errs {
		parts = append(parts, err.Error())
	}
	return fmt.Errorf("%s", strings.Join(parts, "; "))
}
