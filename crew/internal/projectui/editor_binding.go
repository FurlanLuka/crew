package projectui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// bindingPreviewMsg carries the draft's preview against every worktree.
type bindingPreviewMsg struct {
	key      dev.BindingKey
	previews []workspace.BindingPreview
}

type editField int

const (
	fieldVar editField = iota
	fieldServer
	fieldValue
)

// bindingEditor is one binding being typed, in place: var, scope (when the
// project has servers to choose between), value, and the live preview
// against every worktree the project is in. A plain sub-model fed at open
// time; the save comes back to the host as savedMsg.
type bindingEditor struct {
	proj       string
	varInput   textinput.Model
	valueInput textinput.Model
	focus      editField
	// servers are the project's own: the scope field shows only when there
	// are two or more to choose from.
	servers []project.DevServer
	// envKeys complete a var name from the env files; declared is every
	// var already bound, whatever its scope, which completion skips.
	envKeys  []string
	declared map[string]bool
	// targets are the projects a token can point at, for the legend.
	targets []project.Project
	// orig is the binding's key when the editor opened on one; nil when
	// adding. An edit that changes var or scope is a new identity, and the
	// old one goes so both do not survive.
	orig *dev.BindingKey

	draft        project.Binding
	draftPreview []workspace.BindingPreview
	showLegend   bool
	err          error
}

// editorFacts is what the host hands the editor at open time.
type editorFacts struct {
	proj     string
	servers  []project.DevServer
	envKeys  []string
	declared map[string]bool
	targets  []project.Project
}

// editorFactsFor is the editor's facts off a project as loaded: its
// servers for the scope, what is bound (completion skips it), the pool's
// other projects with servers as targets. Pure.
func editorFactsFor(name string, p project.Project, envKeys []string, pool []project.Project) editorFacts {
	return editorFacts{
		proj:     name,
		servers:  p.DevServers,
		envKeys:  envKeys,
		declared: project.DeclaredVars(p.Bindings),
		targets:  targetsFor(pool, name),
	}
}

func newBindingEditor(f editorFacts, edit *project.Binding) bindingEditor {
	varInput := textinput.New()
	varInput.Placeholder = "STORE_API_URL"
	varInput.CharLimit = 64
	valueInput := textinput.New()
	valueInput.Placeholder = "{{store-api}}"
	valueInput.CharLimit = 256
	e := bindingEditor{proj: f.proj, varInput: varInput, valueInput: valueInput, servers: f.servers, envKeys: f.envKeys, declared: f.declared, targets: f.targets}
	if edit != nil {
		k := edit.Key()
		e.orig = &k
		e.draft = *edit
		e.varInput.SetValue(edit.Var)
		e.valueInput.SetValue(edit.Value)
		e.valueInput.CursorEnd()
	}
	return e
}

// open focuses the first field (the value, on an edit — the var is the one
// thing an edit rarely changes) and starts the preview.
func (e *bindingEditor) open() tea.Cmd {
	if e.orig != nil {
		return tea.Batch(e.setFocus(fieldValue), e.previewDraft())
	}
	return e.setFocus(fieldVar)
}

// Update takes every key the host forwards; esc is the host's.
func (e bindingEditor) Update(msg tea.Msg) (bindingEditor, tea.Cmd) {
	switch msg := msg.(type) {
	case bindingPreviewMsg:
		if msg.key == e.draft.Key() {
			e.draftPreview = msg.previews
		}
		return e, nil
	case tea.KeyMsg:
		return e.handleKey(msg)
	}
	return e.updateFocused(msg)
}

func (e bindingEditor) handleKey(msg tea.KeyMsg) (bindingEditor, tea.Cmd) {
	switch msg.String() {
	case "tab":
		// On the var field tab finishes the name from .env when it can; the
		// hint under the field says which it will do.
		if e.focus == fieldVar {
			if match := completeVar(e.varInput.Value(), e.envKeys, e.declared); match != "" && match != e.varInput.Value() {
				e.varInput.SetValue(match)
				e.varInput.CursorEnd()
				cmd := e.syncDraft()
				return e, cmd
			}
		}
		cmd := e.setFocus(e.nextField(e.focus, 1))
		return e, cmd
	case "down":
		cmd := e.setFocus(e.nextField(e.focus, 1))
		return e, cmd
	case "shift+tab", "up":
		cmd := e.setFocus(e.nextField(e.focus, -1))
		return e, cmd
	case "ctrl+t":
		// The legend is reference; the preview is what teaches.
		e.showLegend = !e.showLegend
		return e, nil
	case "left", "right", " ":
		if e.focus == fieldServer {
			step := 1
			if msg.String() == "left" {
				step = -1
			}
			e.cycleServer(step)
			cmd := e.syncDraft()
			return e, cmd
		}
	case "enter":
		if err := e.validateVar(); err != nil {
			e.err = err
			cmd := e.setFocus(fieldVar)
			return e, cmd
		}
		if strings.TrimSpace(e.valueInput.Value()) == "" {
			e.err = nil
			cmd := e.setFocus(fieldValue)
			return e, cmd
		}
		// What is on screen is what is saved, whatever the draft last saw.
		e.draft.Var = strings.TrimSpace(e.varInput.Value())
		e.draft.Value = strings.TrimSpace(e.valueInput.Value())
		return e, e.saveDraft()
	}
	return e.updateFocused(msg)
}

// updateFocused forwards a message to whichever field has focus and keeps
// the draft, and its preview, in step with what is on screen.
func (e bindingEditor) updateFocused(msg tea.Msg) (bindingEditor, tea.Cmd) {
	var cmd tea.Cmd
	switch e.focus {
	case fieldVar:
		e.varInput, cmd = e.varInput.Update(msg)
	case fieldValue:
		e.valueInput, cmd = e.valueInput.Update(msg)
	}
	sync := e.syncDraft()
	return e, tea.Batch(cmd, sync)
}

// hasScopeField: the scope is worth a field only when there is a choice.
func (e bindingEditor) hasScopeField() bool { return len(e.servers) >= 2 }

// nextField steps through var → server → value, skipping the scope field
// when the project has nothing to choose between.
func (e bindingEditor) nextField(f editField, step int) editField {
	fields := []editField{fieldVar, fieldValue}
	if e.hasScopeField() {
		fields = []editField{fieldVar, fieldServer, fieldValue}
	}
	for i, x := range fields {
		if x == f {
			return fields[(i+step+len(fields))%len(fields)]
		}
	}
	return fieldVar
}

// cycleServer moves the draft's scope through all / each server.
func (e *bindingEditor) cycleServer(step int) {
	options := []string{""}
	for _, ds := range e.servers {
		options = append(options, ds.Name)
	}
	i := 0
	for j, o := range options {
		if o == e.draft.Server {
			i = j
		}
	}
	e.draft.Server = options[(i+step+len(options))%len(options)]
}

func scopeLabel(server string) string {
	if server == "" {
		return "all servers"
	}
	return server
}

func (e *bindingEditor) syncDraft() tea.Cmd {
	e.draft.Var = strings.TrimSpace(e.varInput.Value())
	e.draft.Value = strings.TrimSpace(e.valueInput.Value())
	previewable, err := draftState(e.draft)
	e.err = err
	if !previewable {
		e.draftPreview = nil
		return nil
	}
	return e.previewDraft()
}

// draftState decides what the editor shows for a half-typed binding. A
// malformed token is one fact about the value, not one per worktree, so it
// is the error and there is no preview; an unfinished var name or empty
// value is not an error at all, just nothing to preview yet.
func draftState(d project.Binding) (previewable bool, err error) {
	if _, err := dev.ParseTokens(d.Value); err != nil {
		return false, err
	}
	return project.ValidVarName(d.Var) && d.Value != "", nil
}

func (e *bindingEditor) setFocus(f editField) tea.Cmd {
	e.focus = f
	e.varInput.Blur()
	e.valueInput.Blur()
	switch f {
	case fieldVar:
		e.varInput.Focus()
		return e.varInput.Cursor.BlinkCmd()
	case fieldValue:
		e.valueInput.Focus()
		return e.valueInput.Cursor.BlinkCmd()
	}
	return nil
}

func (e bindingEditor) validateVar() error {
	name := strings.TrimSpace(e.varInput.Value())
	if !project.ValidVarName(name) {
		return fmt.Errorf("'%s' is not a valid environment variable name", name)
	}
	return nil
}

// completeVar finishes a var name from the env files' keys, skipping the
// ones already bound. Pure.
func completeVar(prefix string, envKeys []string, declared map[string]bool) string {
	if prefix == "" {
		return ""
	}
	for _, k := range envKeys {
		if strings.HasPrefix(k, strings.ToUpper(prefix)) && !declared[k] {
			return k
		}
	}
	return ""
}

func (e bindingEditor) previewDraft() tea.Cmd {
	if e.draft.Var == "" || e.draft.Value == "" {
		return nil
	}
	proj, draft := e.proj, e.draft
	return func() tea.Msg {
		return bindingPreviewMsg{key: draft.Key(), previews: workspace.PreviewBinding(proj, draft)}
	}
}

func (e bindingEditor) saveDraft() tea.Cmd {
	proj, draft, orig := e.proj, e.draft, e.orig
	return func() tea.Msg {
		if orig != nil && *orig != draft.Key() {
			project.RemoveBinding(proj, *orig)
		}
		if err := project.AddBinding(proj, draft); err != nil {
			return errMsg{err}
		}
		return savedMsg{sectionBindings, draft.Label()}
	}
}
