package workspaceui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/projectui"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// The page's keys. A running action takes no keys; an open form takes
// every key but esc and ctrl+c; a confirm takes y or n; the rest act on
// the row under the cursor, as pageKeys says.

func (p Page) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if msg.String() == "ctrl+c" {
		return p, tea.Quit
	}
	if p.busy != "" {
		return p, nil
	}
	if p.open != openNone {
		if msg.String() == "esc" {
			p.closeForm()
			p.err = nil
			p.bases.drop()
			return p, nil
		}
		return p.handleFormKey(msg)
	}
	if p.confirm != nil {
		return p.handleConfirmKey(msg)
	}
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return p, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		return p, func() tea.Msg { return app.PopPageMsg{} }
	case key.Matches(msg, app.Keys.Up):
		p.cursor = app.MoveCursor(p.cursor, -1, len(p.rows))
		return p, nil
	case key.Matches(msg, app.Keys.Down):
		p.cursor = app.MoveCursor(p.cursor, 1, len(p.rows))
		return p, nil
	case msg.String() == "enter":
		return p.activate()
	case msg.String() == "a":
		return p.openPicker()
	case msg.String() == "n":
		return p.openNewWorktree()
	case msg.String() == "u":
		if r := p.row(); r.Kind == rowWorktree && !p.facts.flat() {
			return p.openDuplicate(p.facts.summaries[r.Index].Ref)
		}
		return p, nil
	case msg.String() == "r":
		if r := p.row(); r.Kind == rowWorktree && !p.facts.flat() {
			return p.openRename(p.facts.summaries[r.Index].Ref)
		}
		return p, nil
	case msg.String() == "d":
		return p.remove()
	}
	return p, nil
}

func (p Page) row() pageRow {
	if p.cursor < 0 || p.cursor >= len(p.rows) {
		return pageRow{Kind: rowNewWorktree}
	}
	return p.rows[p.cursor]
}

// activate is enter: open the member's project page, the worktree's page,
// or the new-worktree form.
func (p Page) activate() (tea.Model, tea.Cmd) {
	r := p.row()
	p.err, p.status = nil, ""
	switch r.Kind {
	case rowProject:
		page := projectui.OpenPage(p.facts.members()[r.Index].Name)
		return p, func() tea.Msg { return app.PushPageMsg{Page: page} }
	case rowNoProjects:
		return p.openPicker()
	case rowWorktree:
		page := workspace.NewWorktreeView(p.facts.summaries[r.Index].Ref)
		return p, func() tea.Msg { return app.PushPageMsg{Page: page} }
	}
	return p.openNewWorktree()
}

func (p Page) openPicker() (tea.Model, tea.Cmd) {
	p.picker = newPicker(p.name)
	p.open = openPicker
	p.err, p.status = nil, ""
	return p, p.loadPicker()
}

func (p Page) openNewWorktree() (tea.Model, tea.Cmd) {
	p.open = openNewWorktree
	p.err, p.status = nil, ""
	p.input.Placeholder = fmt.Sprintf("wrk%d", len(p.facts.summaries)+1)
	p.input.SetValue("")
	p.input.Focus()
	return p, tea.Batch(p.input.Cursor.BlinkCmd(), p.bases.fetch(p.facts.ws, p.spinner.Tick))
}

func (p Page) openDuplicate(src workspace.Ref) (tea.Model, tea.Cmd) {
	p.open = openDuplicate
	p.formRef = src
	p.err, p.status = nil, ""
	p.input.Placeholder = fmt.Sprintf("wrk%d", len(p.facts.summaries)+1)
	p.input.SetValue("")
	p.input.Focus()
	return p, p.input.Cursor.BlinkCmd()
}

func (p Page) openRename(src workspace.Ref) (tea.Model, tea.Cmd) {
	p.open = openRename
	p.formRef = src
	p.err, p.status = nil, ""
	p.input.Placeholder = src.Worktree
	p.input.SetValue("")
	p.input.Focus()
	return p, p.input.Cursor.BlinkCmd()
}

// handleFormKey forwards a key to the open form; enter is the action.
func (p Page) handleFormKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch p.open {
	case openPicker:
		if msg.String() == "enter" {
			specs, err := p.picker.picked()
			if err != nil {
				p.err = err
				return p, nil
			}
			ws := p.name
			p.busy = "adding — reserving ports, starting one runner per project…"
			p.err = nil
			return p, tea.Batch(p.spinner.Tick, func() tea.Msg {
				refs, err := workspace.AddProjects(ws, specs, workspace.CheckoutOptions{Install: true, Smoke: true})
				if err != nil {
					return errMsg{err}
				}
				names := make([]string, len(specs))
				for i, s := range specs {
					names[i] = s.Name
				}
				return membersAddedMsg{names: names, refs: refs}
			})
		}
		var cmd tea.Cmd
		var handled bool
		if p.picker, cmd, handled = p.picker.handleKey(msg); handled {
			p.err = p.picker.err
		}
		return p, cmd

	case openNewWorktree:
		switch msg.String() {
		case "ctrl+p":
			if cmd := p.bases.pull(p.facts.ws, p.spinner.Tick); cmd != nil {
				p.err = nil
				return p, cmd
			}
			return p, nil
		case "enter":
			name := strings.TrimSpace(p.input.Value())
			if name == "" {
				return p, nil
			}
			ws := p.name
			p.busy = "creating worktree — reserving ports, starting the runners…"
			p.err = nil
			return p, tea.Batch(p.spinner.Tick, func() tea.Msg {
				if err := workspace.AddWorktree(ws, name, workspace.CheckoutOptions{Install: true, Smoke: true}); err != nil {
					return errMsg{err}
				}
				return worktreeAddedMsg{ref: workspace.Ref{Workspace: ws, Worktree: name}}
			})
		}

	case openRename:
		if msg.String() == "enter" {
			name := strings.TrimSpace(p.input.Value())
			if name == "" {
				return p, nil
			}
			src := p.formRef
			// A refusal leaves the form open with what was typed; busy
			// keeps a second enter from renaming what just moved.
			p.err = nil
			p.busy = fmt.Sprintf("renaming %s → %s…", src, name)
			return p, tea.Batch(p.spinner.Tick, func() tea.Msg {
				to, warnings, err := workspace.RenameWorktree(src, name)
				if err != nil {
					return errMsg{err}
				}
				return worktreeRenamedMsg{from: src, to: to, warnings: warnings}
			})
		}

	case openDuplicate:
		if msg.String() == "enter" {
			name := strings.TrimSpace(p.input.Value())
			if name == "" {
				return p, nil
			}
			src := p.formRef
			p.busy = "duplicating worktree — reserving ports, starting the runners…"
			p.err = nil
			return p, tea.Batch(p.spinner.Tick, func() tea.Msg {
				if err := workspace.DuplicateWorktree(src, name, workspace.CheckoutOptions{Install: true, Smoke: true}); err != nil {
					return errMsg{err}
				}
				return worktreeAddedMsg{ref: workspace.Ref{Workspace: src.Workspace, Worktree: name}, duplicatedFrom: src.String()}
			})
		}
	}
	var cmd tea.Cmd
	p.input, cmd = p.input.Update(msg)
	return p, cmd
}

// remove asks first, naming the row and what goes with it, and resolves
// the target now — by identity, not by an index a reload could move.
func (p Page) remove() (tea.Model, tea.Cmd) {
	r := p.row()
	p.err, p.status = nil, ""
	switch r.Kind {
	case rowProject:
		wp := p.facts.members()[r.Index]
		p.confirm = &confirmAsk{prompt: memberRemovePrompt(p.name, wp), kind: confirmProject, name: wp.Name}
	case rowWorktree:
		ref := p.facts.summaries[r.Index].Ref
		if len(p.facts.summaries) <= 1 {
			// The last worktree is the workspace: removing it removes the
			// workspace, as the CLI's rm worktree refuses to leave none.
			p.confirm = &confirmAsk{prompt: removeWorkspacePrompt(p.name, p.facts.members()), kind: confirmWorkspace, name: p.name}
			return p, nil
		}
		p.confirm = &confirmAsk{prompt: fmt.Sprintf("Remove worktree '%s'? Its checkouts will be deleted; the workspace stays. (y/n)", ref), kind: confirmWorktree, ref: ref}
	}
	return p, nil
}

func (p Page) handleConfirmKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	ask := *p.confirm
	p.confirm = nil
	if msg.String() != "y" && msg.String() != "Y" {
		return p, nil
	}
	ws := p.name
	switch ask.kind {
	case confirmProject:
		name := ask.name
		p.busy = "removing " + name + " — its checkouts go to the trash…"
		return p, tea.Batch(p.spinner.Tick, func() tea.Msg {
			if err := workspace.RemoveProject(ws, name); err != nil {
				return errMsg{err}
			}
			return memberRemovedMsg{name}
		})
	case confirmWorktree:
		ref := ask.ref
		p.busy = fmt.Sprintf("removing %s — large checkouts take a while", ref)
		return p, tea.Batch(p.spinner.Tick, func() tea.Msg {
			if err := workspace.RemoveWorktree(ref.Workspace, ref.Worktree); err != nil {
				return errMsg{err}
			}
			return worktreeRemovedMsg{ref}
		})
	}
	p.busy = fmt.Sprintf("removing workspace %s…", ws)
	return p, tea.Batch(p.spinner.Tick, removeWorkspace(ws))
}
