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
		if v.cursor > 0 {
			v.cursor--
		}
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		if v.cursor < len(v.bindings)-1 {
			v.cursor++
		}
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
		if v.scanCur > 0 {
			v.scanCur--
		}
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		if v.scanCur < len(v.proposals)-1 {
			v.scanCur++
		}
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
		// Complete to the first env key with this prefix.
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
		if v.sourceCur > 0 {
			v.sourceCur--
		}
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		if v.sourceCur < len(sourceLabels)-1 {
			v.sourceCur++
		}
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
		if v.projectCur > 0 {
			v.projectCur--
		}
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		if v.projectCur < len(candidates)-1 {
			v.projectCur++
		}
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
		if v.serverCur > 0 {
			v.serverCur--
		}
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		if v.serverCur < len(servers)-1 {
			v.serverCur++
		}
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

// ── View ──

func (v BindingsView) View() string {
	var b strings.Builder
	switch v.state {
	case bindingStateList:
		v.renderList(&b)
	case bindingStateScan:
		v.renderScan(&b)
	case bindingStateVar:
		v.renderVar(&b)
	case bindingStateSource:
		v.renderSource(&b)
	case bindingStateProject:
		v.renderProject(&b)
	case bindingStateServer:
		v.renderServer(&b)
	case bindingStateCustom:
		v.renderCustom(&b)
	case bindingStateConfirmRemove:
		b.WriteString(fmt.Sprintf("  Remove binding '%s'? (y/n)\n", v.bindings[v.cursor].Var))
	}
	return b.String()
}

func (v BindingsView) renderList(b *strings.Builder) {
	if len(v.bindings) == 0 {
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render("Nothing declared yet."))
		b.WriteString("\n\n  ")
		if len(v.proposals) > 0 {
			b.WriteString(app.HelpStyle.Render("s scan .env  a add  esc back"))
		} else {
			b.WriteString(app.HelpStyle.Render("a add  esc back"))
		}
		b.WriteString("\n")
		return
	}

	width := 0
	for _, bd := range v.bindings {
		width = max(width, len(bd.Var))
	}

	for i, bd := range v.bindings {
		cursor := "  "
		name := bd.Var
		if i == v.cursor {
			cursor = app.Selected.Render("> ")
			name = app.Selected.Render(name)
		}
		pad := strings.Repeat(" ", width-len(bd.Var))

		b.WriteString(cursor)
		b.WriteString(name + pad)
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render(fmt.Sprintf("%-36s", bd.Value)))
		b.WriteString(renderPreviewInline(v.previews[bd.Var]))
		b.WriteString("\n")
	}

	b.WriteString("\n")
	if v.statusMsg != "" {
		b.WriteString("  ")
		b.WriteString(app.Success.Render(v.statusMsg))
		b.WriteString("\n\n")
	}
	if v.err != nil {
		b.WriteString("  ")
		b.WriteString(app.Error.Render(v.err.Error()))
		b.WriteString("\n\n")
	}

	b.WriteString("  ")
	b.WriteString(app.HelpStyle.Render("a add  e edit  d delete  s scan .env  esc back"))
	b.WriteString("\n")
}

// renderPreviewInline shows the first resolved value, or the first reason it
// was left alone — enough to see at a glance, with the full picture in edit.
func renderPreviewInline(previews []BindingPreview) string {
	if len(previews) == 0 {
		return app.Subtle.Render("→ no worktree to check against")
	}
	for _, p := range previews {
		if p.Resolved {
			return "→ " + p.Value + "  " + app.Subtle.Render("in "+p.Ref)
		}
	}
	return app.Highlight.Render("→ left alone") + "  " + app.Subtle.Render(previews[0].Detail)
}

func (v BindingsView) renderScan(b *strings.Builder) {
	b.WriteString("  Scanned .env — found ")
	b.WriteString(fmt.Sprintf("%d vars pointing at ports crew allocates:\n\n", len(v.proposals)))

	declared := v.declaredVars()
	for i, p := range v.proposals {
		cursor := "  "
		if i == v.scanCur {
			cursor = app.Selected.Render("> ")
		}

		mark := "○"
		switch {
		case declared[p.Var]:
			mark = "·"
		case p.Ambiguous:
			mark = "?"
		case v.accepted[i]:
			mark = "✓"
		}

		target := p.Template
		switch {
		case declared[p.Var]:
			target = app.Subtle.Render("already bound")
		case p.Ambiguous:
			target = app.Highlight.Render(fmt.Sprintf("two projects on :%d — pick by hand", p.Port))
		}

		b.WriteString(cursor)
		b.WriteString(fmt.Sprintf("%s %-22s %-26s %s\n", mark, p.Var, app.Subtle.Render(p.Value), target))
	}

	b.WriteString("\n  ")
	b.WriteString(app.HelpStyle.Render("space toggle  a accept all  enter accept checked  n skip"))
	b.WriteString("\n")
}

func (v BindingsView) renderVar(b *strings.Builder) {
	b.WriteString("  Adding binding\n\n")
	b.WriteString("  var    ")
	b.WriteString(v.varInput.View())
	b.WriteString("\n")

	if match := v.completeVar(v.varInput.Value()); match != "" && match != v.varInput.Value() {
		b.WriteString("         ")
		b.WriteString(app.Subtle.Render("tab → " + match))
		b.WriteString("\n")
	}

	if v.err != nil {
		b.WriteString("\n  ")
		b.WriteString(app.Error.Render(v.err.Error()))
		b.WriteString("\n")
	}

	b.WriteString("\n  ")
	b.WriteString(app.HelpStyle.Render("enter next  tab complete from .env  esc cancel"))
	b.WriteString("\n")
}

func (v BindingsView) renderSource(b *strings.Builder) {
	if v.insertToken {
		b.WriteString("  Insert token\n\n")
	} else {
		b.WriteString(fmt.Sprintf("  %s\n\n", v.draft.Var))
		b.WriteString("  value  ")
	}

	for i, label := range sourceLabels {
		if i > 0 || v.insertToken {
			b.WriteString("         ")
		}
		if i == v.sourceCur {
			b.WriteString(app.Selected.Render("▸ " + label))
		} else {
			b.WriteString("  " + label)
		}
		b.WriteString("\n")
	}

	b.WriteString("\n  ")
	b.WriteString(app.HelpStyle.Render("enter pick  esc back"))
	b.WriteString("\n")
}

func (v BindingsView) renderProject(b *strings.Builder) {
	b.WriteString(fmt.Sprintf("  %s — which project?\n\n", v.draft.Var))

	candidates := v.projectsWithServers()
	if len(candidates) == 0 {
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render("No project has dev servers configured yet."))
		b.WriteString("\n")
	}
	for i, p := range candidates {
		cursor := "  "
		name := p.Name
		if i == v.projectCur {
			cursor = app.Selected.Render("> ")
			name = app.Selected.Render(name)
		}
		servers := make([]string, 0, len(p.DevServers))
		for _, ds := range p.DevServers {
			servers = append(servers, fmt.Sprintf("%s :%d", ds.Name, ds.Port))
		}
		b.WriteString(cursor)
		b.WriteString(fmt.Sprintf("%-16s %s\n", name, app.Subtle.Render(strings.Join(servers, "  "))))
	}

	b.WriteString("\n  ")
	b.WriteString(app.HelpStyle.Render("enter pick  esc back"))
	b.WriteString("\n")
}

func (v BindingsView) renderServer(b *strings.Builder) {
	b.WriteString(fmt.Sprintf("  %s — which server of %s?\n\n", v.draft.Var, v.pickedProj.Name))

	for i, ds := range v.pickedProj.DevServers {
		cursor := "  "
		name := ds.Name
		if i == v.serverCur {
			cursor = app.Selected.Render("> ")
			name = app.Selected.Render(name)
		}
		b.WriteString(cursor)
		b.WriteString(fmt.Sprintf("%-16s %s\n", name, app.Subtle.Render(fmt.Sprintf(":%d  %s", ds.Port, ds.Command))))
	}

	b.WriteString("\n  ")
	b.WriteString(app.HelpStyle.Render("enter pick  esc back"))
	b.WriteString("\n")
}

func (v BindingsView) renderCustom(b *strings.Builder) {
	action := "Adding binding"
	if v.editIdx >= 0 {
		action = "Editing binding"
	}
	b.WriteString(fmt.Sprintf("  %s\n\n", action))
	b.WriteString(fmt.Sprintf("  var    %s\n", v.draft.Var))
	b.WriteString("  value  ")
	b.WriteString(v.customInput.View())
	b.WriteString("\n")

	// Live preview against every worktree this project is in — the actual
	// value before saving, and where it will not resolve, which is normal
	// and better seen now than at start time.
	if len(v.draftPreview) > 0 {
		b.WriteString("\n")
		for _, p := range v.draftPreview {
			b.WriteString("         ")
			if p.Resolved {
				b.WriteString("→ " + p.Value)
				b.WriteString("  " + app.Subtle.Render("in "+p.Ref))
			} else {
				b.WriteString(app.Highlight.Render("→ left alone"))
				b.WriteString("  " + app.Subtle.Render("in "+p.Ref+" · "+p.Detail))
			}
			b.WriteString("\n")
		}
	} else if Previewer != nil && v.draft.Value != "" {
		b.WriteString("\n         ")
		b.WriteString(app.Subtle.Render("→ not in any worktree yet"))
		b.WriteString("\n")
	}

	if v.err != nil {
		b.WriteString("\n  ")
		b.WriteString(app.Error.Render(v.err.Error()))
		b.WriteString("\n")
	}

	b.WriteString("\n  ")
	b.WriteString(app.HelpStyle.Render("enter save  ctrl+t insert token  esc cancel"))
	b.WriteString("\n")
}

// ── Commands ──

func (v BindingsView) load() tea.Cmd {
	projName := v.projName
	return func() tea.Msg {
		p := Get(projName)
		if p == nil {
			return errMsg{fmt.Errorf("project '%s' not found", projName)}
		}

		envValues := dev.ReadEnvValues(p.Path)
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
