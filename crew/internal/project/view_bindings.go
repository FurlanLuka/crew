package project

import (
	"fmt"
	"sort"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/dev"
)

// BindingPreview is one binding resolved against one real worktree.
type BindingPreview struct {
	Ref      string
	Value    string
	Resolved bool
	// Running is false when the value came from the worktree's reserved
	// ports rather than live servers — right, but not yet true.
	Running bool
	Detail  string
}

// PreviewFunc resolves a binding against every worktree the project is in.
//
// Resolution needs the workspace package, which imports this one, so the
// editor receives the function rather than the package. main wires it.
type PreviewFunc func(projName string, b Binding) []BindingPreview

// Previewer is set by main; nil disables live preview in the editor.
var Previewer PreviewFunc

// ── Messages ──

type bindingsLoadedMsg struct {
	bindings  []Binding
	proposals []dev.Proposal
	previews  map[dev.BindingKey][]BindingPreview
	envKeys   []string
	pool      []Project
	servers   []DevServer
}
type bindingSavedMsg struct{ count int }
type bindingRemovedMsg struct{}
type bindingPreviewMsg struct{ previews []BindingPreview }

// ── States ──

type bindingState int

const (
	bindingStateList bindingState = iota
	bindingStateScan
	bindingStateEdit
	bindingStateConfirmRemove
)

type editField int

const (
	fieldVar editField = iota
	fieldServer
	fieldValue
)

// ── Model ──

type BindingsView struct {
	projName string
	state    bindingState

	bindings []Binding
	previews map[dev.BindingKey][]BindingPreview
	cursor   int

	proposals []dev.Proposal
	accepted  map[int]bool
	scanCur   int

	// The editor is one screen: both fields, the token legend and the
	// projects that can be targeted, so nothing has to be remembered from a
	// previous step. The value is typed, not picked — every scheme and path
	// is expressible and the legend is right there.
	varInput   textinput.Model
	valueInput textinput.Model
	focus      editField
	envKeys    []string
	pool       []Project
	// servers are this project's own: a binding can be scoped to one of them.
	// The scope field shows only when there are two or more to choose from.
	servers []DevServer
	editIdx int

	draft        Binding
	draftPreview []BindingPreview

	statusMsg string
	err       error
}

func NewBindingsView(projName string) BindingsView {
	varInput := textinput.New()
	varInput.Placeholder = "STORE_API_URL"
	varInput.CharLimit = 64

	valueInput := textinput.New()
	valueInput.Placeholder = "{{store-api}}"
	valueInput.CharLimit = 256

	return BindingsView{
		projName:   projName,
		state:      bindingStateList,
		varInput:   varInput,
		valueInput: valueInput,
		editIdx:    -1,
		accepted:   map[int]bool{},
	}
}

func (v BindingsView) Title() string {
	return fmt.Sprintf("Bindings for \"%s\"", v.projName)
}

func (v BindingsView) Init() tea.Cmd {
	return v.load()
}

func (v BindingsView) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return v, nil

	case bindingsLoadedMsg:
		v.bindings = msg.bindings
		v.proposals = msg.proposals
		v.previews = msg.previews
		v.envKeys = msg.envKeys
		v.pool = msg.pool
		v.servers = msg.servers
		if v.cursor >= len(v.bindings) {
			v.cursor = max(0, len(v.bindings)-1)
		}
		// A project with nothing declared opens on what crew already found —
		// the interesting work is done by the time you look.
		if len(v.bindings) == 0 && len(v.proposals) > 0 && v.state == bindingStateList {
			v.state = bindingStateScan
			v.accepted = map[int]bool{}
			for i, p := range v.proposals {
				v.accepted[i] = !p.Ambiguous
			}
		}
		return v, nil

	case bindingSavedMsg:
		v.state = bindingStateList
		v.err = nil
		if msg.count == 1 {
			v.statusMsg = "Binding saved"
		} else {
			v.statusMsg = fmt.Sprintf("%d bindings saved", msg.count)
		}
		v.resetDraft()
		return v, v.load()

	case bindingRemovedMsg:
		v.state = bindingStateList
		v.statusMsg = "Binding removed"
		v.err = nil
		return v, v.load()

	case bindingPreviewMsg:
		v.draftPreview = msg.previews
		return v, nil

	case errMsg:
		v.err = msg.err
		return v, nil

	case tea.KeyMsg:
		return v.handleKey(msg)
	}

	if v.state == bindingStateEdit {
		return v.updateFocused(msg)
	}
	return v, nil
}

func (v BindingsView) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch v.state {
	case bindingStateList:
		return v.handleListKey(msg)
	case bindingStateScan:
		return v.handleScanKey(msg)
	case bindingStateEdit:
		return v.handleEditKey(msg)
	case bindingStateConfirmRemove:
		return v.handleConfirmRemoveKey(msg)
	}
	return v, nil
}

// ── List ──

func (v BindingsView) handleListKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		return v, func() tea.Msg { return app.PopPageMsg{} }
	case key.Matches(msg, app.Keys.Up):
		v.cursor = app.MoveCursor(v.cursor, -1, len(v.bindings))
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		v.cursor = app.MoveCursor(v.cursor, 1, len(v.bindings))
		return v, nil
	case msg.String() == "a":
		v.resetDraft()
		v.statusMsg = ""
		v.err = nil
		v.state = bindingStateEdit
		return v, v.setFocus(fieldVar)
	case msg.String() == "e":
		if len(v.bindings) == 0 {
			return v, nil
		}
		b := v.bindings[v.cursor]
		v.resetDraft()
		v.statusMsg = ""
		v.err = nil
		v.editIdx = v.cursor
		v.draft = b
		v.varInput.SetValue(b.Var)
		v.valueInput.SetValue(b.Value)
		v.valueInput.CursorEnd()
		v.state = bindingStateEdit
		return v, tea.Batch(v.setFocus(fieldValue), v.previewDraft())
	case msg.String() == "d":
		if len(v.bindings) > 0 {
			v.state = bindingStateConfirmRemove
			v.statusMsg = ""
		}
		return v, nil
	case msg.String() == "s":
		if len(v.proposals) == 0 {
			v.statusMsg = "Nothing in the env files points at a port crew allocates"
			return v, nil
		}
		v.state = bindingStateScan
		v.accepted = map[int]bool{}
		declared := v.boundProjectWide()
		for i, p := range v.proposals {
			v.accepted[i] = !p.Ambiguous && !declared[p.Var]
		}
		v.scanCur = 0
		return v, nil
	}
	return v, nil
}

// declaredVars is every var with a binding, whatever its scope — what the
// var field's completion skips.
func (v BindingsView) declaredVars() map[string]bool {
	declared := make(map[string]bool, len(v.bindings))
	for _, b := range v.bindings {
		declared[b.Var] = true
	}
	return declared
}

// boundProjectWide is what the editor's scan (of the checkout root, always
// project-wide) counts as already bound.
func (v BindingsView) boundProjectWide() map[string]bool { return BoundFor(v.bindings, "") }

// ── Scan ──

func (v BindingsView) handleScanKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back), msg.String() == "n":
		v.state = bindingStateList
		return v, nil
	case key.Matches(msg, app.Keys.Up):
		v.scanCur = app.MoveCursor(v.scanCur, -1, len(v.proposals))
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		v.scanCur = app.MoveCursor(v.scanCur, 1, len(v.proposals))
		return v, nil
	case msg.String() == " ":
		if v.scanCur < len(v.proposals) && !v.proposals[v.scanCur].Ambiguous {
			v.accepted[v.scanCur] = !v.accepted[v.scanCur]
		}
		return v, nil
	case msg.String() == "a":
		for i, p := range v.proposals {
			if !p.Ambiguous {
				v.accepted[i] = true
			}
		}
		return v, v.applyProposals()
	case msg.String() == "enter":
		return v, v.applyProposals()
	}
	return v, nil
}

// ── Edit ──

func (v BindingsView) handleEditKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		v.state = bindingStateList
		v.resetDraft()
		return v, nil
	case "tab":
		// On the var field tab finishes the name from .env when it can; the
		// hint under the field says which it will do.
		if v.focus == fieldVar {
			if match := v.completeVar(v.varInput.Value()); match != "" && match != v.varInput.Value() {
				v.varInput.SetValue(match)
				v.varInput.CursorEnd()
				return v, v.syncDraft()
			}
		}
		return v, v.setFocus(v.nextField(v.focus, 1))
	case "down":
		return v, v.setFocus(v.nextField(v.focus, 1))
	case "shift+tab", "up":
		return v, v.setFocus(v.nextField(v.focus, -1))
	case "left", "right", " ":
		if v.focus == fieldServer {
			step := 1
			if msg.String() == "left" {
				step = -1
			}
			v.cycleServer(step)
			return v, v.syncDraft()
		}
	case "enter":
		if err := v.validateVar(); err != nil {
			v.err = err
			return v, v.setFocus(fieldVar)
		}
		if strings.TrimSpace(v.valueInput.Value()) == "" {
			v.err = nil
			return v, v.setFocus(fieldValue)
		}
		v.draft.Value = strings.TrimSpace(v.valueInput.Value())
		return v, v.saveDraft()
	}
	return v.updateFocused(msg)
}

// updateFocused forwards a message to whichever field has focus and keeps
// the draft, and its preview, in step with what is on screen.
func (v BindingsView) updateFocused(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	switch v.focus {
	case fieldVar:
		v.varInput, cmd = v.varInput.Update(msg)
	case fieldValue:
		v.valueInput, cmd = v.valueInput.Update(msg)
	}
	return v, tea.Batch(cmd, v.syncDraft())
}

// hasScopeField: the scope is worth a field only when there is a choice.
func (v BindingsView) hasScopeField() bool { return len(v.servers) >= 2 }

// nextField steps through var → server → value, skipping the scope field
// when the project has nothing to choose between.
func (v BindingsView) nextField(f editField, step int) editField {
	fields := []editField{fieldVar, fieldValue}
	if v.hasScopeField() {
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
func (v *BindingsView) cycleServer(step int) {
	options := []string{""}
	for _, ds := range v.servers {
		options = append(options, ds.Name)
	}
	i := 0
	for j, o := range options {
		if o == v.draft.Server {
			i = j
		}
	}
	v.draft.Server = options[(i+step+len(options))%len(options)]
}

func scopeLabel(server string) string {
	if server == "" {
		return "all servers"
	}
	return server
}

func (v *BindingsView) syncDraft() tea.Cmd {
	v.draft.Var = strings.TrimSpace(v.varInput.Value())
	v.draft.Value = strings.TrimSpace(v.valueInput.Value())
	previewable, err := draftState(v.draft)
	v.err = err
	if !previewable {
		v.draftPreview = nil
		return nil
	}
	return v.previewDraft()
}

// draftState decides what the editor shows for a half-typed binding. A
// malformed token is one fact about the value, not one per worktree, so it
// is the error and there is no preview; an unfinished var name or empty
// value is not an error at all, just nothing to preview yet.
func draftState(d Binding) (previewable bool, err error) {
	if _, err := dev.ParseTokens(d.Value); err != nil {
		return false, err
	}
	return validVarName.MatchString(d.Var) && d.Value != "", nil
}

func (v *BindingsView) setFocus(f editField) tea.Cmd {
	v.focus = f
	v.varInput.Blur()
	v.valueInput.Blur()
	switch f {
	case fieldVar:
		v.varInput.Focus()
		return v.varInput.Cursor.BlinkCmd()
	case fieldValue:
		v.valueInput.Focus()
		return v.valueInput.Cursor.BlinkCmd()
	}
	return nil
}

func (v BindingsView) validateVar() error {
	name := strings.TrimSpace(v.varInput.Value())
	if !validVarName.MatchString(name) {
		return fmt.Errorf("'%s' is not a valid environment variable name", name)
	}
	return nil
}

func (v BindingsView) completeVar(prefix string) string {
	if prefix == "" {
		return ""
	}
	declared := v.declaredVars()
	for _, k := range v.envKeys {
		if strings.HasPrefix(k, strings.ToUpper(prefix)) && !declared[k] {
			return k
		}
	}
	return ""
}

// projectsWithServers is what a {{project}} token can target.
func (v BindingsView) projectsWithServers() []Project {
	var out []Project
	for _, p := range v.pool {
		if len(p.DevServers) > 0 {
			out = append(out, p)
		}
	}
	return out
}

// ── Confirm ──

func (v BindingsView) handleConfirmRemoveKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "y", "Y":
		b := v.bindings[v.cursor]
		v.state = bindingStateList
		return v, v.removeBinding(b.Key())
	default:
		v.state = bindingStateList
		return v, nil
	}
}

func (v *BindingsView) resetDraft() {
	v.varInput.Reset()
	v.varInput.Blur()
	v.valueInput.Reset()
	v.valueInput.Blur()
	v.focus = fieldVar
	v.draft = Binding{}
	v.draftPreview = nil
	v.editIdx = -1
}

// ── Commands ──

func (v BindingsView) load() tea.Cmd {
	projName := v.projName
	return func() tea.Msg {
		p := Get(projName)
		if p == nil {
			return errMsg{fmt.Errorf("project '%s' not found", projName)}
		}

		envValues := ScanEnv(projName, "")
		envKeys := make([]string, 0, len(envValues))
		for k := range envValues {
			envKeys = append(envKeys, k)
		}
		sort.Strings(envKeys)

		previews := make(map[dev.BindingKey][]BindingPreview)
		if Previewer != nil {
			for _, b := range p.Bindings {
				previews[b.Key()] = Previewer(projName, b)
			}
		}

		pool, _ := List()

		return bindingsLoadedMsg{
			bindings:  p.Bindings,
			proposals: dev.ProposeBindings(envValues, ConfiguredPorts()),
			previews:  previews,
			envKeys:   envKeys,
			pool:      pool,
			servers:   p.DevServers,
		}
	}
}

func (v BindingsView) previewDraft() tea.Cmd {
	if Previewer == nil || v.draft.Var == "" || v.draft.Value == "" {
		return nil
	}
	projName, draft := v.projName, v.draft
	return func() tea.Msg {
		return bindingPreviewMsg{previews: Previewer(projName, draft)}
	}
}

func (v BindingsView) saveDraft() tea.Cmd {
	projName, draft := v.projName, v.draft
	var orig *dev.BindingKey
	if v.editIdx >= 0 && v.editIdx < len(v.bindings) {
		k := v.bindings[v.editIdx].Key()
		orig = &k
	}
	return func() tea.Msg {
		// An edit that changes the var or the scope is a new identity; the
		// old one goes so both do not survive.
		if orig != nil && *orig != draft.Key() {
			RemoveBinding(projName, *orig)
		}
		if err := AddBinding(projName, draft); err != nil {
			return errMsg{err}
		}
		return bindingSavedMsg{count: 1}
	}
}

func (v BindingsView) applyProposals() tea.Cmd {
	projName := v.projName
	var chosen []Binding
	for i, p := range v.proposals {
		if v.accepted[i] && !p.Ambiguous {
			chosen = append(chosen, Binding{Var: p.Var, Value: p.Template})
		}
	}
	return func() tea.Msg {
		saved := 0
		for _, b := range chosen {
			if err := AddBinding(projName, b); err != nil {
				return errMsg{fmt.Errorf("%s: %w", b.Var, err)}
			}
			saved++
		}
		return bindingSavedMsg{count: saved}
	}
}

func (v BindingsView) removeBinding(key dev.BindingKey) tea.Cmd {
	projName := v.projName
	return func() tea.Msg {
		if err := RemoveBinding(projName, key); err != nil {
			return errMsg{err}
		}
		return bindingRemovedMsg{}
	}
}
