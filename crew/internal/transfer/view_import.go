package transfer

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// ── Messages ──

type projectDoneMsg struct {
	outcome outcome
	name    string
	path    string
	cloned  bool
	err     error
}

// wsStartedMsg: the workspace is created and its runners are going (or
// there was nothing to run); the card follows them until they are done.
type wsStartedMsg struct {
	name    string
	ref     workspace.Ref
	started bool
	err     error
}

// wsPollMsg is the runners' table, looked at again every couple of
// seconds while any is alive.
type wsPollMsg struct {
	name   string
	status workspace.Status
}

// wsBasesMsg: the base-branch table for the workspace card, fetched in the
// background when the card opens (and again after a pull).
type wsBasesMsg struct {
	name     string
	statuses []workspace.BaseStatus
	pulled   []error
}

// ── Outcomes ──

type outcome int

const (
	outcomePending outcome = iota
	outcomeImported
	outcomeReplaced
	outcomeKept
	outcomeSkipped
	outcomeCreated
	outcomeFailed
	outcomeNotReached
)

type projectResult struct {
	Outcome outcome
	Name    string // as imported (may differ from the bundle's)
	Path    string
	Cloned  bool
	Err     error
}

type wsResult struct {
	Outcome outcome
	Detail  string
}

// ── States ──

type importPhase int

const (
	phaseProjects importPhase = iota
	phaseWorkspaces
	phaseDone
)

type importState int

const (
	importStateCard importState = iota
	importStateEdit
	// importStatePath: the one-field form p opens — a checkout to adopt.
	importStatePath
	// importStateApplying: the decision is running (a clone takes a while).
	importStateApplying
	importStateCreating
)

const (
	fieldName = iota
	fieldPath
	fieldSetup
	fieldEnvCmd
)

// editFields is the e form: what differs between machines is the path,
// and the path is no longer the card's to edit — p adopts one, y clones.
var editFields = []int{fieldName, fieldSetup, fieldEnvCmd}

// ImportView walks the bundle one card at a time. Every y is applied when
// pressed; nothing is staged, so stopping keeps what was done.
type ImportView struct {
	file   string
	bundle Bundle
	plan   Plan

	phase importPhase
	state importState
	idx   int

	// The card in hand, with edits applied.
	current Exported
	warn    string

	inputs [4]textinput.Model
	focus  int
	// pending is the decision being applied — the spinner says what.
	pending decision

	present map[string]bool // in the pool before, or imported/replaced/kept in this walk
	results []projectResult
	wsRes   []wsResult

	spinner spinner.Model
	// setup is the running import's runner table, shown on the card.
	setup *workspace.Status
	// The workspace card's base table; nil while it loads. ctrl+p pulls.
	bases   []workspace.BaseStatus
	pulling bool
	stopped string // "project 3 of 5" when esc ended it early

	err error
}

func NewImportView(file string, b Bundle) ImportView {
	var inputs [4]textinput.Model
	for i := range inputs {
		inputs[i] = textinput.New()
		inputs[i].CharLimit = 512
	}
	plan := Inspect(b)
	v := ImportView{
		file:    file,
		bundle:  b,
		plan:    plan,
		inputs:  inputs,
		present: plan.Known,
		results: make([]projectResult, len(b.Projects)),
		wsRes:   make([]wsResult, len(b.Workspaces)),
		spinner: app.NewSpinner(),
	}
	for i := range v.results {
		v.results[i].Outcome = outcomeNotReached
		v.results[i].Name = b.Projects[i].Name
	}
	for i := range v.wsRes {
		v.wsRes[i].Outcome = outcomeNotReached
	}
	v.openCard()
	return v
}

func (v ImportView) Title() string { return "Import" }

// Init: a bundle with only workspaces opens on a workspace card.
func (v ImportView) Init() tea.Cmd { return v.loadBases() }

// openCard loads the current item into the card.
func (v *ImportView) openCard() {
	v.warn, v.err = "", nil
	switch v.phase {
	case phaseProjects:
		if v.idx >= len(v.bundle.Projects) {
			v.phase, v.idx = phaseWorkspaces, 0
			v.openCard()
			return
		}
		v.current = v.bundle.Projects[v.idx]
	case phaseWorkspaces:
		v.bases = nil
		if v.idx >= len(v.bundle.Workspaces) {
			v.phase = phaseDone
		}
	}
}

func (v ImportView) status() ProjectStatus {
	if v.idx < len(v.plan.Projects) {
		return v.plan.Projects[v.idx]
	}
	return ProjectStatus{}
}

// keys is a situation's help line, without the esc every card has. The
// status line, the key line and the handler all read classify, so a key
// the help offers is always one the handler takes.
func keysFor(sit situation) []string {
	switch sit {
	case sitHere, sitOtherRemote:
		return []string{"r replace local", "n keep local", "e edit"}
	case sitClone:
		return []string{"y clone", "p adopt a path", "e edit", "n skip"}
	default:
		return []string{"p adopt a path", "e edit", "n skip"}
	}
}

func (v ImportView) situation() situation { return classify(v.status(), v.current.Remote) }

// ── Update ──

func (v ImportView) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return v, nil

	case projectDoneMsg:
		v.state = importStateCard
		if msg.err != nil {
			v.err = msg.err
			return v, nil
		}
		v.results[v.idx] = projectResult{Outcome: msg.outcome, Name: msg.name, Path: msg.path, Cloned: msg.cloned}
		if msg.outcome == outcomeReplaced {
			// The record that matched is gone; only the name it has now is here.
			delete(v.present, v.bundle.Projects[v.idx].Name)
		}
		v.present[msg.name] = true
		return v.advance()

	case wsStartedMsg:
		if msg.err != nil {
			v.state = importStateCard
			v.wsRes[v.idx] = wsResult{Outcome: outcomeFailed, Detail: msg.err.Error()}
			return v.advance()
		}
		if !msg.started {
			v.state = importStateCard
			v.wsRes[v.idx] = wsResult{Outcome: outcomeCreated, Detail: "empty workspace"}
			return v.advance()
		}
		return v, pollSetup(msg.ref)

	case wsPollMsg:
		if v.phase != phaseWorkspaces || v.idx >= len(v.bundle.Workspaces) || v.bundle.Workspaces[v.idx].Name != msg.name {
			return v, nil
		}
		st := msg.status
		v.setup = &st
		if st.Running() {
			return v, tea.Tick(2*time.Second, func(time.Time) tea.Msg { return pollSetup(st.Ref)() })
		}
		v.state = importStateCard
		v.setup = nil
		m := v.bundle.Workspaces[v.idx]
		v.wsRes[v.idx] = wsResult{Outcome: outcomeCreated, Detail: createdDetail(m, st)}
		return v.advance()

	case wsBasesMsg:
		if v.phase != phaseWorkspaces || v.idx >= len(v.bundle.Workspaces) || v.bundle.Workspaces[v.idx].Name != msg.name {
			return v, nil
		}
		v.bases, v.pulling = msg.statuses, false
		if len(msg.pulled) > 0 {
			v.err = errors.Join(msg.pulled...)
		}
		return v, nil

	case spinner.TickMsg:
		if v.state != importStateApplying && v.state != importStateCreating && !v.basesLoading() && !v.pulling {
			return v, nil
		}
		var cmd tea.Cmd
		v.spinner, cmd = v.spinner.Update(msg)
		return v, cmd

	case tea.KeyMsg:
		switch v.state {
		case importStateEdit:
			return v.handleEditKey(msg)
		case importStatePath:
			return v.handlePathKey(msg)
		case importStateApplying, importStateCreating:
			return v, nil
		}
		switch v.phase {
		case phaseProjects:
			return v.handleProjectKey(msg)
		case phaseWorkspaces:
			return v.handleWorkspaceKey(msg)
		default:
			if key.Matches(msg, app.Keys.Back) || key.Matches(msg, app.Keys.Quit) || msg.String() == "enter" {
				return v, func() tea.Msg { return app.PopPageMsg{} }
			}
		}
	}
	if v.state == importStateEdit || v.state == importStatePath {
		var cmd tea.Cmd
		v.inputs[v.focus], cmd = v.inputs[v.focus].Update(msg)
		return v, cmd
	}
	return v, nil
}

func (v ImportView) advance() (tea.Model, tea.Cmd) {
	v.idx++
	v.openCard()
	return v, v.loadBases()
}

// loadBases fetches the workspace card's base table in the background —
// one fetch per member, in parallel, off the key loop. The card shows a
// spinner while bases is nil.
func (v ImportView) loadBases() tea.Cmd {
	if !v.wantsBases() {
		return nil
	}
	m := v.bundle.Workspaces[v.idx]
	return tea.Batch(v.spinner.Tick, func() tea.Msg { return wsBasesMsg{name: m.Name, statuses: workspace.BaseStatuses(m.Workspace())} })
}

// wantsBases: a workspace card that can be created, so its base table is
// worth fetching.
func (v ImportView) wantsBases() bool {
	return v.phase == phaseWorkspaces && v.idx < len(v.bundle.Workspaces) &&
		!v.plan.Workspaces[v.idx].Exists && len(MissingMembers(v.bundle.Workspaces[v.idx], v.present)) == 0
}

// basesLoading: the table is wanted and not here yet.
func (v ImportView) basesLoading() bool { return v.wantsBases() && v.bases == nil }

// stop ends the walk; everything not reached stays marked that way.
func (v ImportView) stop() (tea.Model, tea.Cmd) {
	switch v.phase {
	case phaseProjects:
		v.stopped = fmt.Sprintf("project %d of %d", v.idx+1, len(v.bundle.Projects))
	case phaseWorkspaces:
		v.stopped = fmt.Sprintf("workspace %d of %d", v.idx+1, len(v.bundle.Workspaces))
	}
	v.phase = phaseDone
	return v, nil
}

// ── Project card ──

func (v ImportView) handleProjectKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	st, sit := v.status(), v.situation()
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		return v.stop()
	case msg.String() == "n":
		if st.Exists {
			// Keeping the local record still counts as present for workspaces.
			v.results[v.idx] = projectResult{Outcome: outcomeKept, Name: st.Local.Name, Path: st.Local.Path}
			v.present[st.Local.Name] = true
		} else {
			v.results[v.idx] = projectResult{Outcome: outcomeSkipped, Name: v.current.Name}
		}
		return v.advance()
	case msg.String() == "y" && sit == sitClone:
		return v.apply(ProjectOptions{})
	case msg.String() == "y" && sit == sitBlocked:
		dir := project.ClonePath(v.current.Name)
		v.err = fmt.Errorf("%s exists — %s", dir, blockedWayOut(dir))
		return v, nil
	case msg.String() == "r" && (sit == sitHere || sit == sitOtherRemote):
		return v.apply(ProjectOptions{Replace: true})
	case msg.String() == "p" && !st.Exists:
		return v, v.beginPath()
	case msg.String() == "e":
		return v, v.beginEdit()
	}
	return v, nil
}

// beginEdit opens the card's own fields — name, setup, env. The path is
// not among them: it is this machine's, decided by y or p.
func (v *ImportView) beginEdit() tea.Cmd {
	v.state = importStateEdit
	v.err = nil
	v.inputs[fieldName].SetValue(v.current.Name)
	v.inputs[fieldSetup].SetValue(v.current.Setup)
	v.inputs[fieldEnvCmd].SetValue(v.current.EnvCmd)
	return v.setFocus(fieldName)
}

// beginPath opens the one field p has: a checkout on this machine to
// record as the canonical instead of cloning.
func (v *ImportView) beginPath() tea.Cmd {
	v.state = importStatePath
	v.err = nil
	v.inputs[fieldPath].SetValue("")
	return v.setFocus(fieldPath)
}

// apply runs the card's decision — the same decide and applyDecision the
// CLI runs — in one command; the card shows what is happening meanwhile.
func (v ImportView) apply(o ProjectOptions) (tea.Model, tea.Cmd) {
	st := v.status()
	p := v.current.Project
	d, err := decide(p.Name, v.current.Remote, st, o)
	if err != nil {
		v.err = err
		return v, nil
	}
	v.pending = d
	v.state = importStateApplying
	v.err = nil
	original, remote := v.bundle.Projects[v.idx].Name, v.current.Remote
	return v, tea.Batch(v.spinner.Tick, func() tea.Msg {
		res, err := applyDecision(original, p, remote, d)
		if err != nil {
			return projectDoneMsg{err: err}
		}
		outcome := outcomeImported
		if res.Replaced {
			outcome = outcomeReplaced
		}
		return projectDoneMsg{outcome: outcome, name: res.Name, path: res.Path, cloned: res.Cloned}
	})
}

func (v *ImportView) setFocus(f int) tea.Cmd {
	v.focus = f
	for i := range v.inputs {
		if i == f {
			v.inputs[i].Focus()
		} else {
			v.inputs[i].Blur()
		}
	}
	return v.inputs[f].Cursor.BlinkCmd()
}

func (v ImportView) handleEditKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		v.state = importStateCard
		return v, nil
	case "tab":
		return v, v.setFocus(nextEditField(v.focus, 1))
	case "shift+tab":
		return v, v.setFocus(nextEditField(v.focus, -1))
	case "enter":
		name := strings.TrimSpace(v.inputs[fieldName].Value())
		if err := project.ValidateName(name); err != nil {
			v.err = err
			return v, nil
		}
		original := v.bundle.Projects[v.idx].Name
		// A rename onto a name already in the pool is refused here, on the
		// form, rather than at y — the same rule applyDecision holds.
		if name != original && v.present[name] {
			v.err = fmt.Errorf("project '%s' is already in the pool — choose another name", name)
			return v, nil
		}
		v.err = nil
		if name != original && name != v.current.Name {
			if refs := ReferencedBy(v.bundle, original); len(refs) > 0 {
				v.warn = fmt.Sprintf("%s point at %s — left alone until re-bound", strings.Join(refs, ", "), original)
			}
		}
		v.current.Name = name
		v.current.Setup = strings.TrimSpace(v.inputs[fieldSetup].Value())
		v.current.EnvCmd = strings.TrimSpace(v.inputs[fieldEnvCmd].Value())
		v.state = importStateCard
		return v, nil
	}
	var cmd tea.Cmd
	v.inputs[v.focus], cmd = v.inputs[v.focus].Update(msg)
	return v, cmd
}

// nextEditField steps through the e form's fields. Pure.
func nextEditField(f, step int) int {
	for i, x := range editFields {
		if x == f {
			return editFields[(i+step+len(editFields))%len(editFields)]
		}
	}
	return editFields[0]
}

func (v ImportView) handlePathKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		v.state = importStateCard
		v.err = nil
		return v, nil
	case "enter":
		path := config.ExpandHome(strings.TrimSpace(v.inputs[fieldPath].Value()))
		if !dirExists(path) {
			v.err = fmt.Errorf("%s is not a directory here", path)
			return v, nil
		}
		return v.apply(ProjectOptions{Path: path})
	}
	var cmd tea.Cmd
	v.inputs[v.focus], cmd = v.inputs[v.focus].Update(msg)
	return v, cmd
}

// ── Workspace card ──

func (v ImportView) handleWorkspaceKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	m := v.bundle.Workspaces[v.idx]
	exists := v.plan.Workspaces[v.idx].Exists
	missing := MissingMembers(m, v.present)
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		return v.stop()
	case msg.String() == "n":
		switch {
		case exists:
			v.wsRes[v.idx] = wsResult{Outcome: outcomeKept}
		case len(missing) > 0:
			v.wsRes[v.idx] = wsResult{Outcome: outcomeSkipped, Detail: "needs " + strings.Join(missing, ", ")}
		default:
			v.wsRes[v.idx] = wsResult{Outcome: outcomeSkipped}
		}
		return v.advance()
	case msg.String() == "ctrl+p" && !exists && len(missing) == 0 && v.bases != nil && !v.pulling:
		v.pulling, v.err = true, nil
		statuses := v.bases
		return v, tea.Batch(v.spinner.Tick, func() tea.Msg {
			ws := m.Workspace()
			pulled := workspace.UpdateBases(ws, statuses)
			return wsBasesMsg{name: m.Name, statuses: workspace.BaseStatuses(ws), pulled: pulled}
		})
	case msg.String() == "y" && !exists && len(missing) == 0 && !v.pulling:
		v.state = importStateCreating
		v.err = nil
		v.setup = nil
		return v, tea.Batch(v.spinner.Tick, func() tea.Msg {
			ref, started, err := ImportWorkspace(m, workspace.CheckoutOptions{Install: true, Smoke: true})
			return wsStartedMsg{name: m.Name, ref: ref, started: started, err: err}
		})
	}
	return v, nil
}

func pollSetup(ref workspace.Ref) tea.Cmd {
	return func() tea.Msg {
		st, _ := workspace.SetupStatus(ref)
		st.Ref = ref
		return wsPollMsg{name: ref.Workspace, status: st}
	}
}

// createdDetail is the summary line for a created workspace once its
// runners are done. Pure.
func createdDetail(m Membership, st workspace.Status) string {
	ref := workspace.Ref{Workspace: m.Name, Worktree: workspace.DefaultWorktree}
	if h := st.Health(); h != nil {
		return fmt.Sprintf("%s recorded — crew fix %s --print", plural(len(h.Issues), "issue"), ref)
	}
	return fmt.Sprintf("%s under %s", plural(len(m.Projects), "checkout"), tildify(workspace.WorktreeDir(ref)))
}

// ── Render ──

func (v ImportView) View() string {
	var b strings.Builder
	switch {
	case v.phase == phaseDone:
		v.renderSummary(&b)
	case v.phase == phaseProjects && v.state == importStateEdit:
		v.renderEdit(&b)
	case v.phase == phaseProjects && v.state == importStatePath:
		v.renderPath(&b)
	case v.phase == phaseProjects:
		v.renderProjectCard(&b)
	case v.phase == phaseWorkspaces:
		v.renderWorkspaceCard(&b)
	}
	return b.String()
}

func (v ImportView) header(suffix string) string {
	base := filepath.Base(v.file)
	switch v.phase {
	case phaseProjects:
		return fmt.Sprintf("  Import %s · project %d of %d%s\n\n", base, v.idx+1, len(v.bundle.Projects), suffix)
	case phaseWorkspaces:
		return fmt.Sprintf("  Import %s · workspace %d of %d%s\n\n", base, v.idx+1, len(v.bundle.Workspaces), suffix)
	}
	return ""
}

const pathCol = 42

func (v ImportView) renderProjectCard(b *strings.Builder) {
	st := v.status()
	p := v.current
	b.WriteString(v.header(""))

	name := fmt.Sprintf("  name      %-*s", pathCol, p.Name)
	if st.Exists {
		name += " " + app.Highlight.Render("· already here")
	}
	b.WriteString(name + "\n")

	// What names the project here: its remote, and what this machine
	// would do about it.
	sit := v.situation()
	switch sit {
	case sitHere:
		b.WriteString(fmt.Sprintf("  remote    %-*s %s\n", pathCol, orNoRemote(p.Remote), app.Success.Render("✓ same repo here at "+tildify(st.Local.Path))))
	case sitOtherRemote:
		b.WriteString(fmt.Sprintf("  remote    %-*s\n", pathCol, p.Remote))
		b.WriteString(fmt.Sprintf("  local     %-*s %s\n", pathCol, app.Highlight.Render(orNoRemote(st.LocalRemote)), app.Subtle.Render("at "+tildify(st.Local.Path)+" — r clones this one instead")))
	case sitClone:
		b.WriteString(fmt.Sprintf("  remote    %-*s %s\n", pathCol, p.Remote, app.Error.Render("✗ not here")))
		b.WriteString(fmt.Sprintf("            %-*s %s\n", pathCol, app.Highlight.Render("→ "+tildify(project.ClonePath(p.Name))), app.Subtle.Render("y clones here — p adopts a checkout you have")))
	case sitBlocked:
		dir := project.ClonePath(p.Name)
		b.WriteString(fmt.Sprintf("  remote    %-*s %s\n", pathCol, p.Remote, app.Error.Render("✗ not here")))
		b.WriteString(fmt.Sprintf("            %-*s %s\n", pathCol, app.Error.Render("✗ "+tildify(dir)+" exists"), app.Subtle.Render(blockedWayOut(dir))))
	case sitNoRemote:
		b.WriteString(fmt.Sprintf("  remote    %-*s %s\n", pathCol, app.Error.Render("✗ none — cannot be cloned"), app.Subtle.Render("p adopts a checkout you have"+wasAtPhrase(p.Path))))
	}

	if len(p.DevServers) > 0 {
		b.WriteString("  servers   " + app.Subtle.Render(describeServers(p.DevServers)) + "\n")
	}
	if len(p.Bindings) > 0 {
		width := 0
		for _, bd := range p.Bindings {
			width = max(width, len(bd.Label()))
		}
		for i, bd := range p.Bindings {
			label := "            "
			if i == 0 {
				label = "  bindings  "
			}
			b.WriteString(label + app.Subtle.Render(fmt.Sprintf("%-*s  %s", width, bd.Label(), bd.Value)) + "\n")
		}
		if st.Exists && st.Local != nil && len(st.Local.Bindings) != len(p.Bindings) {
			b.WriteString("            " + app.Subtle.Render(fmt.Sprintf("local has %s: %s", plural(len(st.Local.Bindings), "binding"), bindingNames(st.Local.Bindings))) + "\n")
		}
	}
	if p.Setup != "" {
		b.WriteString("  setup     " + app.Subtle.Render(p.Setup) + "\n")
	}
	if p.EnvCmd != "" {
		b.WriteString("  env       " + app.Subtle.Render(p.EnvCmd) + "\n")
	}
	b.WriteString("\n")
	if v.warn != "" {
		b.WriteString("  " + app.Highlight.Render("! "+v.warn) + "\n\n")
	}
	if v.err != nil {
		b.WriteString("  " + app.Error.Render("! "+v.err.Error()) + "\n\n")
	}
	if v.state == importStateApplying {
		if v.pending.Action == actionClone {
			b.WriteString(fmt.Sprintf("  %s Cloning %s → %s\n", v.spinner.View(), p.Name, tildify(v.pending.Path)))
		} else {
			b.WriteString(fmt.Sprintf("  %s Recording %s\n", v.spinner.View(), p.Name))
		}
		return
	}

	keys := append(keysFor(sit), "esc stop")
	b.WriteString("  " + app.HelpStyle.Render(strings.Join(keys, "  ")) + "\n")
}

func (v ImportView) renderEdit(b *strings.Builder) {
	b.WriteString(v.header(" · editing"))
	b.WriteString("  name      " + v.inputs[fieldName].View() + "\n")
	b.WriteString("  setup     " + v.inputs[fieldSetup].View() + "\n")
	b.WriteString("  env       " + v.inputs[fieldEnvCmd].View() + "\n\n")
	b.WriteString("            " + app.Subtle.Render("servers and bindings can be changed in crew project after import") + "\n\n")
	if v.err != nil {
		b.WriteString("  " + app.Error.Render(v.err.Error()) + "\n\n")
	}
	b.WriteString("  " + app.HelpStyle.Render("tab next  enter apply  esc back") + "\n")
}

// renderPath is the p form: one field, a checkout to adopt as the
// canonical — for a repo already on this machine, or one with no remote.
func (v ImportView) renderPath(b *strings.Builder) {
	b.WriteString(v.header(" · adopt a path"))
	b.WriteString("  path      " + v.inputs[fieldPath].View())
	if path := config.ExpandHome(strings.TrimSpace(v.inputs[fieldPath].Value())); path != "" {
		if dirExists(path) {
			b.WriteString("  " + app.Success.Render("✓ exists — recorded as is, nothing cloned"))
		} else {
			b.WriteString("  " + app.Error.Render("✗ not here"))
		}
	}
	b.WriteString("\n\n")
	b.WriteString("            " + app.Subtle.Render("a checkout you already have; its own origin becomes the project's identity") + "\n\n")
	if v.err != nil {
		b.WriteString("  " + app.Error.Render(v.err.Error()) + "\n\n")
	}
	b.WriteString("  " + app.HelpStyle.Render("enter adopt  esc back") + "\n")
}

func (v ImportView) renderWorkspaceCard(b *strings.Builder) {
	m := v.bundle.Workspaces[v.idx]
	exists := v.plan.Workspaces[v.idx].Exists
	missing := MissingMembers(m, v.present)
	b.WriteString(v.header(""))

	name := fmt.Sprintf("  name      %-*s", pathCol, m.Name)
	if exists {
		name += " " + app.Highlight.Render("· already here")
	}
	b.WriteString(name + "\n")

	width, roleWidth := 0, 0
	for _, wp := range m.Projects {
		width = max(width, len(wp.Name))
		roleWidth = max(roleWidth, len(wp.Role))
	}
	for i, wp := range m.Projects {
		label := "            "
		if i == 0 {
			label = "  projects  "
		}
		mode := wp.Mode
		if mode == "" {
			mode = workspace.ModeWorktree
		}
		b.WriteString(label + fmt.Sprintf("%-*s   %-*s   %-8s   ", width, wp.Name, roleWidth, wp.Role, mode))
		b.WriteString(v.memberOutcome(wp.Name) + "\n")
	}
	b.WriteString("\n")

	switch {
	case v.state == importStateCreating:
		if v.setup == nil {
			b.WriteString(fmt.Sprintf("  %s creating %s — reserving ports, starting one runner per project…\n", v.spinner.View(), m.Name))
			return
		}
		b.WriteString(fmt.Sprintf("  %s installing %s — one runner per project\n", v.spinner.View(), m.Name))
		b.WriteString(workspace.RenderSetupTable(*v.setup, "▸", time.Now()))
		return
	case exists:
		b.WriteString("  " + app.Subtle.Render("A workspace by this name is here already; an import never replaces one.") + "\n\n")
		b.WriteString("  " + app.HelpStyle.Render("n keep local  esc stop") + "\n")
	case len(missing) > 0:
		b.WriteString("  " + app.Highlight.Render(fmt.Sprintf("! needs %s, which %s not imported — n skips this workspace", strings.Join(missing, ", "), wasWere(len(missing)))) + "\n\n")
		b.WriteString("  " + app.HelpStyle.Render("n skip  esc stop") + "\n")
	default:
		switch {
		case v.pulling:
			b.WriteString(fmt.Sprintf("  %s pulling the latest into the local bases…\n\n", v.spinner.View()))
		case v.basesLoading():
			b.WriteString(fmt.Sprintf("  %s checking the base branches against origin…\n\n", v.spinner.View()))
		default:
			b.WriteString("  " + app.Subtle.Render("Branching from") + "\n")
			b.WriteString(workspace.FormatBaseStatuses(v.bases))
			if warn := workspace.StaleWarning(v.bases); warn != "" {
				b.WriteString("\n  " + app.Highlight.Render(warn) + "\n")
				b.WriteString("  " + app.Subtle.Render("ctrl+p pulls the latest into the local bases (fast-forward only)") + "\n")
			}
			b.WriteString("\n")
		}
		b.WriteString("  " + app.Subtle.Render("y creates the main worktree the way crew add worktree does: checkouts, installs, a smoke start; what fails is recorded.") + "\n\n")
		if v.err != nil {
			b.WriteString("  " + app.Error.Render("! "+v.err.Error()) + "\n\n")
		}
		b.WriteString("  " + app.HelpStyle.Render("y create  ctrl+p pull first  n skip  esc stop") + "\n")
	}
}

// memberOutcome is what happened to a workspace member earlier in this walk,
// or that it was here before.
func (v ImportView) memberOutcome(name string) string {
	for i, r := range v.results {
		if r.Name != name && v.bundle.Projects[i].Name != name {
			continue
		}
		switch r.Outcome {
		case outcomeImported:
			return app.Success.Render("imported")
		case outcomeReplaced:
			return app.Success.Render("replaced")
		case outcomeKept:
			return app.Subtle.Render("already here")
		case outcomeSkipped:
			return app.Error.Render("skipped")
		case outcomeNotReached:
			return app.Error.Render("not reached")
		}
	}
	if v.plan.Known[name] {
		return app.Subtle.Render("already here")
	}
	return app.Error.Render("missing")
}

func (v ImportView) renderSummary(b *strings.Builder) {
	base := filepath.Base(v.file)
	if v.stopped != "" {
		fmt.Fprintf(b, "  Imported %s — stopped at %s\n\n", base, v.stopped)
	} else {
		fmt.Fprintf(b, "  Imported %s\n\n", base)
	}

	width := 0
	for _, e := range v.bundle.Projects {
		width = max(width, len(e.Name))
	}
	for _, m := range v.bundle.Workspaces {
		width = max(width, len(m.Name))
	}

	b.WriteString("  " + app.Subtle.Render("Projects") + "\n")
	for i, e := range v.bundle.Projects {
		r := v.results[i]
		line := fmt.Sprintf("    %-*s  ", width, e.Name)
		switch r.Outcome {
		case outcomeImported:
			line += app.Success.Render("imported")
			if r.Cloned {
				line += app.Subtle.Render(" (cloned)")
			}
			if r.Name != e.Name {
				line += "   " + app.Subtle.Render("→ "+r.Name+" at "+r.Path)
			} else {
				line += "   " + app.Subtle.Render("→ "+r.Path)
			}
		case outcomeReplaced:
			line += app.Success.Render("replaced")
		case outcomeKept:
			line += app.Subtle.Render("kept local")
		case outcomeSkipped:
			line += app.Subtle.Render("skipped")
		default:
			line += app.Subtle.Render("not reached")
		}
		b.WriteString(line + "\n")
	}

	if len(v.bundle.Workspaces) > 0 {
		b.WriteString("\n  " + app.Subtle.Render("Workspaces") + "\n")
		for i, m := range v.bundle.Workspaces {
			r := v.wsRes[i]
			line := fmt.Sprintf("    %-*s  ", width, m.Name)
			switch r.Outcome {
			case outcomeCreated:
				line += app.Success.Render("created") + app.Subtle.Render(" — "+r.Detail)
			case outcomeKept:
				line += app.Subtle.Render("kept local")
			case outcomeSkipped:
				line += app.Subtle.Render("skipped")
				if r.Detail != "" {
					line += app.Subtle.Render(" — " + r.Detail)
				}
			case outcomeFailed:
				line += app.Error.Render("failed") + app.Subtle.Render(" — "+r.Detail)
			default:
				line += app.Subtle.Render("not reached")
			}
			b.WriteString(line + "\n")
		}
	}

	var created []string
	for i, r := range v.wsRes {
		if r.Outcome == outcomeCreated {
			created = append(created, v.bundle.Workspaces[i].Name)
		}
	}
	for _, name := range created {
		b.WriteString("\n  crew launch " + name)
	}
	if len(created) > 0 {
		b.WriteString("\n")
	}
	b.WriteString("\n  " + app.Subtle.Render("Run crew import again to change a decision; imported items offer replace.") + "\n")
	b.WriteString("  " + app.HelpStyle.Render("esc close") + "\n")
}

// ── small renderers ──

func describeServers(servers []project.DevServer) string {
	parts := make([]string, 0, len(servers))
	for _, ds := range servers {
		s := fmt.Sprintf("%s :%d", ds.Name, ds.Port)
		if len(servers) == 1 && ds.Command != "" {
			s += "  " + ds.Command
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, "  ")
}

func bindingNames(bindings []project.Binding) string {
	names := make([]string, 0, len(bindings))
	for _, bd := range bindings {
		names = append(names, bd.Label())
	}
	return strings.Join(names, ", ")
}

// blockedWayOut is the card's half of blockedDetail: what the user can do
// about the thing sitting where the clone would land.
func blockedWayOut(dir string) string {
	if !adoptable(dir) {
		return "delete it first — it is not a directory"
	}
	return "p adopts it, or delete it first"
}

// wasAtPhrase: a v1 bundle carried the path the repo had on the other
// machine — the best hint there is.
func wasAtPhrase(path string) string {
	if path == "" {
		return ""
	}
	return " (was at " + path + ")"
}

func wasWere(n int) string {
	if n == 1 {
		return "was"
	}
	return "were"
}

func tildify(path string) string {
	if home, err := os.UserHomeDir(); err == nil && strings.HasPrefix(path, home+"/") {
		return "~" + path[len(home):]
	}
	return path
}
