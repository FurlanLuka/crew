package projectui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// The page's keys. An open form takes every key but esc and ctrl+c; the
// check card takes the keys of a running or failed check; the rest act on
// the row under the cursor, as pageKeys says.

func (p Page) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if msg.String() == "ctrl+c" {
		return p, tea.Quit
	}
	if p.open != openNone {
		if msg.String() == "esc" {
			p.closeForm()
			p.err = nil
			return p, nil
		}
		return p.updateForm(msg)
	}
	if p.confirm != nil {
		return p.handleConfirmKey(msg)
	}
	if p.check.phase == checkConfirm || p.check.phase == checkRunning {
		if msg.String() == "esc" && p.check.phase == checkRunning {
			// The runner goes on; the page does not.
			return p, func() tea.Msg { return app.PopPageMsg{} }
		}
		c, cmd, _ := p.check.handleKey(msg)
		p.check = c
		return p, cmd
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
	case msg.String() == "t":
		p.cursor = jumpTo(p.rows, rowSetup)
		return p, nil
	case msg.String() == "e":
		p.cursor = jumpTo(p.rows, rowEnv)
		return p, nil
	case msg.String() == "s":
		p.cursor = jumpTo(p.rows, rowServer)
		return p, nil
	case msg.String() == "b":
		p.cursor = jumpTo(p.rows, rowBinding)
		return p, nil
	case msg.String() == "enter":
		return p.activate()
	case msg.String() == "a":
		return p.add()
	case msg.String() == "A":
		return p.addAllProposals()
	case msg.String() == "d":
		return p.remove()
	case msg.String() == "c", msg.String() == "l", msg.String() == "f":
		return p.checkKey(msg)
	}
	return p, nil
}

func (p Page) row() pageRow {
	if p.cursor < 0 || p.cursor >= len(p.rows) {
		return pageRow{Kind: rowCheck}
	}
	return p.rows[p.cursor]
}

// activate is enter: edit the row in place, add a proposal, run the check.
func (p Page) activate() (tea.Model, tea.Cmd) {
	r := p.row()
	p.err, p.status = nil, ""
	switch r.Kind {
	case rowSetup, rowEnv:
		field := cmdSetup
		if r.Kind == rowEnv {
			field = cmdEnvCmd
		}
		return p.openCommand(field)
	case rowServer:
		ds := p.facts.proj.DevServers[r.Index]
		return p.openServerForm(&ds)
	case rowBinding:
		bd := p.facts.proj.Bindings[r.Index]
		return p.openEditor(&bd, "")
	case rowNoServers, rowNoBindings:
		return p.add()
	case rowProposal:
		pr := p.facts.proposals[r.Index]
		if pr.Ambiguous {
			// Two projects on that port: the editor, prefilled, is the
			// only honest place to pick.
			return p.openEditor(nil, pr.Var)
		}
		name := p.name
		return p, func() tea.Msg {
			if err := project.AddBinding(name, project.Binding{Var: pr.Var, Value: pr.Template}); err != nil {
				return errMsg{err}
			}
			return savedMsg{section: sectionBindings, key: pr.Var}
		}
	}
	return p.checkKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("c")})
}

func (p Page) openCommand(field commandField) (tea.Model, tea.Cmd) {
	p.cmdField = field
	p.cmdInput.Placeholder = field.placeholder()
	p.cmdInput.SetValue(field.value(p.facts.proj))
	p.cmdInput.CursorEnd()
	p.cmdInput.Focus()
	p.open = openCommand
	return p, p.cmdInput.Cursor.BlinkCmd()
}

func (p Page) openServerForm(edit *project.DevServer) (tea.Model, tea.Cmd) {
	f := newServerForm(p.name, edit)
	cmd := f.focusField(serverName)
	p.serverForm, p.open = &f, openServer
	return p, cmd
}

// openEditor opens the binding editor on a binding, or empty; prefill is
// a var name to start from (an ambiguous proposal's).
func (p Page) openEditor(edit *project.Binding, prefill string) (tea.Model, tea.Cmd) {
	e := newBindingEditor(editorFactsFor(p.name, p.facts.proj, p.facts.envKeys, p.facts.pool), edit)
	cmd := e.open()
	if prefill != "" {
		e.varInput.SetValue(prefill)
		e.varInput.CursorEnd()
		cmd = tea.Batch(cmd, e.syncDraft())
	}
	p.editor, p.open = &e, openBinding
	return p, cmd
}

// add opens an empty form for the section under the cursor; Install and
// Check have nothing to add.
func (p Page) add() (tea.Model, tea.Cmd) {
	p.err, p.status = nil, ""
	switch p.row().section() {
	case sectionServers:
		return p.openServerForm(nil)
	case sectionBindings:
		return p.openEditor(nil, "")
	}
	return p, nil
}

// addAllProposals is crew add binding --scan --apply: every unambiguous
// proposal, in one go.
func (p Page) addAllProposals() (tea.Model, tea.Cmd) {
	var chosen []project.Binding
	for _, pr := range p.facts.proposals {
		if !pr.Ambiguous {
			chosen = append(chosen, project.Binding{Var: pr.Var, Value: pr.Template})
		}
	}
	if len(chosen) == 0 {
		return p, nil
	}
	name := p.name
	p.err = nil
	return p, func() tea.Msg {
		for _, b := range chosen {
			if err := project.AddBinding(name, b); err != nil {
				return errMsg{fmt.Errorf("%s: %w", b.Var, err)}
			}
		}
		return savedMsg{section: sectionBindings}
	}
}

// remove asks first, naming the row and what goes with it, and resolves
// the target now — by identity, not by an index a reload could move.
// Setup, env and proposals have nothing to remove.
func (p Page) remove() (tea.Model, tea.Cmd) {
	r := p.row()
	prompt := confirmPrompt(p.facts.proj, r)
	if prompt == "" {
		return p, nil
	}
	ask := confirmAsk{prompt: prompt, section: r.section()}
	switch r.Kind {
	case rowServer:
		ask.server = p.facts.proj.DevServers[r.Index].Name
	case rowBinding:
		ask.key = p.facts.proj.Bindings[r.Index].Key()
	}
	p.confirm, p.err, p.status = &ask, nil, ""
	return p, nil
}

func (p Page) handleConfirmKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	ask := *p.confirm
	p.confirm = nil
	if msg.String() != "y" && msg.String() != "Y" {
		return p, nil
	}
	name := p.name
	switch ask.section {
	case sectionServers:
		return p, func() tea.Msg {
			if _, err := project.RemoveDevServer(name, ask.server); err != nil {
				return errMsg{err}
			}
			return savedMsg{section: sectionServers}
		}
	case sectionBindings:
		return p, func() tea.Msg {
			if err := project.RemoveBinding(name, ask.key); err != nil {
				return errMsg{err}
			}
			return savedMsg{section: sectionBindings}
		}
	}
	return p, nil
}

// checkKey is c, l and f: the card's keys once it has a check to act on,
// c on nothing recorded starts one — smoke included, the full check.
func (p Page) checkKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if c, cmd, handled := p.check.handleKey(msg); handled {
		p.check, p.err, p.status = c, nil, ""
		return p, cmd
	}
	if msg.String() != "c" {
		return p, nil
	}
	p.err, p.status = nil, ""
	c, cmd := p.check.start(true)
	p.check = c
	return p, cmd
}

func (p *Page) closeForm() {
	p.open = openNone
	p.serverForm, p.editor = nil, nil
	p.cmdInput.Blur()
}

// updateForm forwards a message to the open form; the command form's
// enter saves here.
func (p Page) updateForm(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch p.open {
	case openCommand:
		if k, ok := msg.(tea.KeyMsg); ok && k.String() == "enter" {
			name, field := p.name, p.cmdField
			command := strings.TrimSpace(p.cmdInput.Value())
			return p, func() tea.Msg {
				if err := field.save(name, command); err != nil {
					return errMsg{err}
				}
				return savedMsg{section: sectionInstall}
			}
		}
		var cmd tea.Cmd
		p.cmdInput, cmd = p.cmdInput.Update(msg)
		return p, cmd
	case openServer:
		f, cmd := p.serverForm.Update(msg)
		p.serverForm = &f
		return p, cmd
	case openBinding:
		e, cmd := p.editor.Update(msg)
		p.editor = &e
		return p, cmd
	}
	return p, nil
}
