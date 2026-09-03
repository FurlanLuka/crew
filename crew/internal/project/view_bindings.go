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
	Detail   string
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
	previews  map[string][]BindingPreview
	envKeys   []string
	pool      []Project
}
type bindingSavedMsg struct{ count int }
type bindingRemovedMsg struct{}
type bindingPreviewMsg struct{ previews []BindingPreview }

// ── States ──

type bindingState int

const (
	bindingStateList bindingState = iota
	bindingStateScan
	bindingStateVar
	bindingStateSource
	bindingStateProject
	bindingStateServer
	bindingStateCustom
	bindingStateConfirmRemove
)

// sourceKind is what the value picker offers. Nobody types a template.
type sourceKind int

const (
	sourceURL sourceKind = iota
	sourcePort
	sourceWorktree
	sourceWorkspace
	sourceCustom
)

var sourceLabels = []string{
	"a project's URL",
	"a project's port",
	"this worktree's name",
	"this workspace's name",
	"custom…",
}

// ── Model ──

type BindingsView struct {
	projName string
	state    bindingState

	bindings []Binding
	previews map[string][]BindingPreview
	cursor   int

	proposals []dev.Proposal
	accepted  map[int]bool
	scanCur   int

	varInput    textinput.Model
	envKeys     []string
	customInput textinput.Model
	editIdx     int

	sourceCur  int
	pool       []Project
	projectCur int
	serverCur  int
	pickedProj Project
	pickedKind sourceKind
	// insertToken is set when the picker was opened from the custom field via
	// ctrl-t, so the chosen token is inserted at the cursor instead of
	// becoming the whole value.
	insertToken bool

	draft        Binding
	draftPreview []BindingPreview

	statusMsg string
	err       error
}

func NewBindingsView(projName string) BindingsView {
	varInput := textinput.New()
	varInput.Placeholder = "SPEAK_API_URL"
	varInput.CharLimit = 64

	customInput := textinput.New()
	customInput.Placeholder = "ws://localhost:{{port:livekit}}"
	customInput.CharLimit = 256

	return BindingsView{
		projName:    projName,
		state:       bindingStateList,
		varInput:    varInput,
		customInput: customInput,
		editIdx:     -1,
		accepted:    map[int]bool{},
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

	switch v.state {
	case bindingStateVar:
		var cmd tea.Cmd
		v.varInput, cmd = v.varInput.Update(msg)
		return v, cmd
	case bindingStateCustom:
		var cmd tea.Cmd
		v.customInput, cmd = v.customInput.Update(msg)
		return v, cmd
	}
	return v, nil
}

func (v BindingsView) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch v.state {
	case bindingStateList:
		return v.handleListKey(msg)
	case bindingStateScan:
		return v.handleScanKey(msg)
	case bindingStateVar:
		return v.handleVarKey(msg)
	case bindingStateSource:
		return v.handleSourceKey(msg)
	case bindingStateProject:
		return v.handleProjectKey(msg)
	case bindingStateServer:
		return v.handleServerKey(msg)
	case bindingStateCustom:
		return v.handleCustomKey(msg)
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
		v.state = bindingStateVar
		v.varInput.Focus()
		return v, v.varInput.Cursor.BlinkCmd()
	case msg.String() == "e":
		if len(v.bindings) == 0 {
			return v, nil
		}
		b := v.bindings[v.cursor]
		v.resetDraft()
		v.editIdx = v.cursor
		v.draft = b
		v.varInput.SetValue(b.Var)
		v.customInput.SetValue(b.Value)
		v.state = bindingStateCustom
		v.customInput.Focus()
		return v, tea.Batch(v.customInput.Cursor.BlinkCmd(), v.previewDraft())
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
		declared := v.declaredVars()
		for i, p := range v.proposals {
			v.accepted[i] = !p.Ambiguous && !declared[p.Var]
		}
		v.scanCur = 0
		return v, nil
	}
	return v, nil
}

func (v BindingsView) declaredVars() map[string]bool {
	declared := make(map[string]bool, len(v.bindings))
	for _, b := range v.bindings {
		declared[b.Var] = true
	}
	return declared
}

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

// ── Var name ──

func (v BindingsView) handleVarKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		v.state = bindingStateList
		v.resetDraft()
		return v, nil
	case "tab":
		if match := v.completeVar(v.varInput.Value()); match != "" {
			v.varInput.SetValue(match)
			v.varInput.CursorEnd()
		}
		return v, nil
	case "enter":
		name := strings.TrimSpace(v.varInput.Value())
		if !validVarName.MatchString(name) {
			v.err = fmt.Errorf("'%s' is not a valid environment variable name", name)
			return v, nil
		}
		v.err = nil
		v.draft.Var = name
		v.state = bindingStateSource
		v.sourceCur = 0
		v.insertToken = false
		return v, nil
	}
	var cmd tea.Cmd
	v.varInput, cmd = v.varInput.Update(msg)
	return v, cmd
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

// ── Source picker ──

func (v BindingsView) handleSourceKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		if v.insertToken {
			v.state = bindingStateCustom
			v.customInput.Focus()
			return v, v.customInput.Cursor.BlinkCmd()
		}
		v.state = bindingStateVar
		v.varInput.Focus()
		return v, v.varInput.Cursor.BlinkCmd()
	case key.Matches(msg, app.Keys.Up):
		v.sourceCur = app.MoveCursor(v.sourceCur, -1, len(sourceLabels))
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		v.sourceCur = app.MoveCursor(v.sourceCur, 1, len(sourceLabels))
		return v, nil
	case msg.String() == "enter":
		v.pickedKind = sourceKind(v.sourceCur)
		switch v.pickedKind {
		case sourceURL, sourcePort:
			v.state = bindingStateProject
			v.projectCur = 0
			return v, nil
		case sourceWorktree:
			return v.acceptToken("{{worktree}}")
		case sourceWorkspace:
			return v.acceptToken("{{workspace}}")
		case sourceCustom:
			v.state = bindingStateCustom
			v.customInput.Focus()
			return v, v.customInput.Cursor.BlinkCmd()
		}
	}
	return v, nil
}

// ── Project / server pickers ──

func (v BindingsView) handleProjectKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	candidates := v.projectsWithServers()
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		v.state = bindingStateSource
		return v, nil
	case key.Matches(msg, app.Keys.Up):
		v.projectCur = app.MoveCursor(v.projectCur, -1, len(candidates))
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		v.projectCur = app.MoveCursor(v.projectCur, 1, len(candidates))
		return v, nil
	case msg.String() == "enter":
		if len(candidates) == 0 {
			return v, nil
		}
		v.pickedProj = candidates[v.projectCur]
		// The server step disappears when there is nothing to choose between —
		// the common case, and why the bare {{url:project}} form exists.
		if len(v.pickedProj.DevServers) == 1 {
			return v.acceptToken(v.tokenFor(v.pickedProj.Name, ""))
		}
		v.state = bindingStateServer
		v.serverCur = 0
		return v, nil
	}
	return v, nil
}

func (v BindingsView) handleServerKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	servers := v.pickedProj.DevServers
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		v.state = bindingStateProject
		return v, nil
	case key.Matches(msg, app.Keys.Up):
		v.serverCur = app.MoveCursor(v.serverCur, -1, len(servers))
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		v.serverCur = app.MoveCursor(v.serverCur, 1, len(servers))
		return v, nil
	case msg.String() == "enter":
		if len(servers) == 0 {
			return v, nil
		}
		return v.acceptToken(v.tokenFor(v.pickedProj.Name, servers[v.serverCur].Name))
	}
	return v, nil
}

func (v BindingsView) projectsWithServers() []Project {
	var out []Project
	for _, p := range v.pool {
		if len(p.DevServers) > 0 {
			out = append(out, p)
		}
	}
	return out
}

func (v BindingsView) tokenFor(projName, server string) string {
	kind := "url"
	if v.pickedKind == sourcePort {
		kind = "port"
	}
	if server == "" {
		return fmt.Sprintf("{{%s:%s}}", kind, projName)
	}
	return fmt.Sprintf("{{%s:%s/%s}}", kind, projName, server)
}

// acceptToken takes a picked token either as the whole value or, when the
// picker was opened from the custom field, inserted at its cursor.
func (v BindingsView) acceptToken(token string) (tea.Model, tea.Cmd) {
	if v.insertToken {
		v.insertToken = false
		cur := v.customInput.Value()
		pos := v.customInput.Position()
		v.customInput.SetValue(cur[:pos] + token + cur[pos:])
		v.customInput.SetCursor(pos + len(token))
		v.state = bindingStateCustom
		v.customInput.Focus()
		return v, tea.Batch(v.customInput.Cursor.BlinkCmd(), v.previewDraft())
	}

	v.draft.Value = token
	v.customInput.SetValue(token)
	v.state = bindingStateCustom
	v.customInput.Focus()
	return v, tea.Batch(v.customInput.Cursor.BlinkCmd(), v.previewDraft())
}

// ── Custom / confirm ──

func (v BindingsView) handleCustomKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		v.state = bindingStateList
		v.resetDraft()
		return v, nil
	case "ctrl+t":
		v.insertToken = true
		v.state = bindingStateSource
		v.sourceCur = 0
		return v, nil
	case "enter":
		v.draft.Value = strings.TrimSpace(v.customInput.Value())
		return v, v.saveDraft()
	}
	var cmd tea.Cmd
	v.customInput, cmd = v.customInput.Update(msg)
	v.draft.Value = v.customInput.Value()
	return v, tea.Batch(cmd, v.previewDraft())
}

func (v BindingsView) handleConfirmRemoveKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "y", "Y":
		b := v.bindings[v.cursor]
		v.state = bindingStateList
		return v, v.removeBinding(b.Var)
	default:
		v.state = bindingStateList
		return v, nil
	}
}

func (v *BindingsView) resetDraft() {
	v.varInput.Reset()
	v.varInput.Blur()
	v.customInput.Reset()
	v.customInput.Blur()
	v.draft = Binding{}
	v.draftPreview = nil
	v.editIdx = -1
	v.insertToken = false
}

// ── Commands ──

func (v BindingsView) load() tea.Cmd {
	projName := v.projName
	return func() tea.Msg {
		p := Get(projName)
		if p == nil {
			return errMsg{fmt.Errorf("project '%s' not found", projName)}
		}

		envValues := ScanEnv(projName)
		envKeys := make([]string, 0, len(envValues))
		for k := range envValues {
			envKeys = append(envKeys, k)
		}
		sort.Strings(envKeys)

		previews := make(map[string][]BindingPreview)
		if Previewer != nil {
			for _, b := range p.Bindings {
				previews[b.Var] = Previewer(projName, b)
			}
		}

		pool, _ := List()

		return bindingsLoadedMsg{
			bindings:  p.Bindings,
			proposals: dev.ProposeBindings(envValues, ConfiguredPorts()),
			previews:  previews,
			envKeys:   envKeys,
			pool:      pool,
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
	origVar := ""
	if v.editIdx >= 0 && v.editIdx < len(v.bindings) {
		origVar = v.bindings[v.editIdx].Var
	}
	return func() tea.Msg {
		if origVar != "" && origVar != draft.Var {
			RemoveBinding(projName, origVar)
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

func (v BindingsView) removeBinding(varName string) tea.Cmd {
	projName := v.projName
	return func() tea.Msg {
		if err := RemoveBinding(projName, varName); err != nil {
			return errMsg{err}
		}
		return bindingRemovedMsg{}
	}
}
