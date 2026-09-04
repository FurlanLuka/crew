package transfer

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// ── Messages ──

type projectDoneMsg struct {
	outcome outcome
	name    string
	path    string
	err     error
}
type clonedMsg struct {
	target string
	err    error
}
type wsProgressMsg struct {
	line string
	ch   chan string
}
type wsDoneMsg struct {
	name string
	err  error
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
	importStateCloning
	importStateCreating
)

const (
	fieldName = iota
	fieldPath
	fieldSetup
)

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
	current    Exported
	pathExists bool
	suggested  string
	warn       string

	inputs [3]textinput.Model
	focus  int
	// cloneAfterEdit: c with nowhere to put the clone asks for the path first.
	cloneAfterEdit bool

	accepted map[string]bool // present after this import: imported, replaced or kept
	anchors  []string        // paths to look beside for the next card
	results  []projectResult
	wsRes    []wsResult

	spinner  spinner.Model
	progress string
	stopped  string // "project 3 of 5" when esc ended it early

	err error
}

func NewImportView(file string, b Bundle) ImportView {
	var inputs [3]textinput.Model
	for i := range inputs {
		inputs[i] = textinput.New()
		inputs[i].CharLimit = 512
	}
	v := ImportView{
		file:     file,
		bundle:   b,
		plan:     Inspect(b),
		inputs:   inputs,
		accepted: map[string]bool{},
		results:  make([]projectResult, len(b.Projects)),
		wsRes:    make([]wsResult, len(b.Workspaces)),
		spinner:  app.NewSpinner(),
	}
	pool, _ := project.List()
	for _, p := range pool {
		v.anchors = append(v.anchors, p.Path)
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

func (v ImportView) Init() tea.Cmd { return nil }

// openCard loads the current item into the card, re-inspecting the path
// against everything accepted so far.
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
		v.refreshPath()
	case phaseWorkspaces:
		if v.idx >= len(v.bundle.Workspaces) {
			v.phase = phaseDone
		}
	}
}

func (v *ImportView) refreshPath() {
	v.pathExists = dirExists(v.current.Path)
	v.suggested = ""
	if !v.pathExists {
		v.suggested = Suggest(v.current.Path, v.anchors)
	}
}

func (v ImportView) status() ProjectStatus {
	if v.idx < len(v.plan.Projects) {
		return v.plan.Projects[v.idx]
	}
	return ProjectStatus{}
}

func (v ImportView) cloneTarget() string {
	if v.current.Remote == "" || v.pathExists {
		return ""
	}
	return CloneTarget(v.current.Path, v.anchors)
}

// canImport: y needs a path that exists, or one crew found for it.
func (v ImportView) canImport() bool { return v.pathExists || v.suggested != "" }

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
		v.results[v.idx] = projectResult{Outcome: msg.outcome, Name: msg.name, Path: msg.path, Cloned: v.results[v.idx].Cloned}
		v.accepted[msg.name] = true
		v.anchors = append(v.anchors, msg.path)
		return v.advance()

	case clonedMsg:
		v.state = importStateCard
		if msg.err != nil {
			v.err = msg.err
			return v, nil
		}
		v.current.Path = msg.target
		v.results[v.idx].Cloned = true
		v.refreshPath()
		return v, nil

	case wsProgressMsg:
		v.progress = msg.line
		return v, listenProgress(msg.ch)

	case wsDoneMsg:
		v.state = importStateCard
		v.progress = ""
		if msg.err != nil {
			v.wsRes[v.idx] = wsResult{Outcome: outcomeFailed, Detail: msg.err.Error()}
			v.err = msg.err
			return v.advance()
		}
		m := v.bundle.Workspaces[v.idx]
		ref := workspace.Ref{Workspace: m.Name, Worktree: workspace.DefaultWorktree}
		v.wsRes[v.idx] = wsResult{Outcome: outcomeCreated,
			Detail: fmt.Sprintf("%s under %s", plural(len(m.Projects), "checkout"), tildify(workspace.WorktreeDir(ref)))}
		return v.advance()

	case spinner.TickMsg:
		if v.state != importStateCloning && v.state != importStateCreating {
			return v, nil
		}
		var cmd tea.Cmd
		v.spinner, cmd = v.spinner.Update(msg)
		return v, cmd

	case tea.KeyMsg:
		switch v.state {
		case importStateEdit:
			return v.handleEditKey(msg)
		case importStateCloning, importStateCreating:
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
	if v.state == importStateEdit {
		var cmd tea.Cmd
		v.inputs[v.focus], cmd = v.inputs[v.focus].Update(msg)
		return v, cmd
	}
	return v, nil
}

func (v ImportView) advance() (tea.Model, tea.Cmd) {
	v.idx++
	v.openCard()
	return v, nil
}

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
	st := v.status()
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		return v.stop()
	case msg.String() == "n":
		if st.Exists {
			// Keeping the local record still counts as present for workspaces.
			v.results[v.idx] = projectResult{Outcome: outcomeKept, Name: st.Local.Name, Path: st.Local.Path}
			v.accepted[st.Local.Name] = true
			v.anchors = append(v.anchors, st.Local.Path)
		} else {
			v.results[v.idx] = projectResult{Outcome: outcomeSkipped, Name: v.current.Name}
		}
		return v.advance()
	case msg.String() == "y" && !st.Exists && v.canImport():
		return v.apply(false)
	case msg.String() == "r" && st.Exists && v.canImport():
		return v.apply(true)
	case msg.String() == "c" && v.current.Remote != "" && !v.pathExists && v.cloneTarget() == "":
		// Nothing to anchor a target on yet: ask for the path, then clone there.
		v.state = importStateEdit
		v.cloneAfterEdit = true
		v.inputs[fieldName].SetValue(v.current.Name)
		v.inputs[fieldPath].SetValue(v.current.Path)
		v.inputs[fieldSetup].SetValue(v.current.Setup)
		return v, v.setFocus(fieldPath)
	case msg.String() == "c" && v.cloneTarget() != "":
		v.state = importStateCloning
		v.err = nil
		remote, target := v.current.Remote, v.cloneTarget()
		return v, tea.Batch(v.spinner.Tick, func() tea.Msg {
			return clonedMsg{target: target, err: Clone(remote, target)}
		})
	case msg.String() == "e":
		v.state = importStateEdit
		v.err = nil
		path := v.current.Path
		if !v.pathExists {
			if v.suggested != "" {
				path = v.suggested
			} else if t := v.cloneTarget(); t != "" {
				path = t
			}
		}
		v.inputs[fieldName].SetValue(v.current.Name)
		v.inputs[fieldPath].SetValue(path)
		v.inputs[fieldSetup].SetValue(v.current.Setup)
		return v, v.setFocus(fieldPath)
	}
	return v, nil
}

func (v ImportView) apply(replace bool) (tea.Model, tea.Cmd) {
	p := v.current.Project
	if !v.pathExists {
		p.Path = v.suggested
	}
	original := v.bundle.Projects[v.idx].Name
	outcome := outcomeImported
	if replace {
		outcome = outcomeReplaced
	}
	return v, func() tea.Msg {
		if err := ImportProject(original, p, replace); err != nil {
			return projectDoneMsg{err: err}
		}
		return projectDoneMsg{outcome: outcome, name: p.Name, path: p.Path}
	}
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
		v.cloneAfterEdit = false
		return v, nil
	case "tab":
		return v, v.setFocus((v.focus + 1) % len(v.inputs))
	case "shift+tab":
		return v, v.setFocus((v.focus + len(v.inputs) - 1) % len(v.inputs))
	case "enter":
		name := strings.TrimSpace(v.inputs[fieldName].Value())
		if err := project.ValidateName(name); err != nil {
			v.err = err
			return v, nil
		}
		v.err = nil
		original := v.bundle.Projects[v.idx].Name
		if name != original && name != v.current.Name {
			if refs := ReferencedBy(v.bundle, original); len(refs) > 0 {
				v.warn = fmt.Sprintf("%s point at %s — left alone until re-bound", strings.Join(refs, ", "), original)
			}
		}
		v.current.Name = name
		v.current.Path = expandHome(strings.TrimSpace(v.inputs[fieldPath].Value()))
		v.current.Setup = strings.TrimSpace(v.inputs[fieldSetup].Value())
		v.refreshPath()
		v.state = importStateCard
		if v.cloneAfterEdit {
			v.cloneAfterEdit = false
			if !v.pathExists {
				v.state = importStateCloning
				remote, target := v.current.Remote, v.current.Path
				return v, tea.Batch(v.spinner.Tick, func() tea.Msg {
					return clonedMsg{target: target, err: Clone(remote, target)}
				})
			}
		}
		return v, nil
	}
	var cmd tea.Cmd
	v.inputs[v.focus], cmd = v.inputs[v.focus].Update(msg)
	return v, cmd
}

// ── Workspace card ──

func (v ImportView) handleWorkspaceKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	m := v.bundle.Workspaces[v.idx]
	exists := v.plan.Workspaces[v.idx].Exists
	missing := MissingMembers(m, v.accepted)
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
	case msg.String() == "y" && !exists && len(missing) == 0:
		v.state = importStateCreating
		v.err = nil
		ch := make(chan string, 8)
		return v, tea.Batch(v.spinner.Tick, listenProgress(ch), func() tea.Msg {
			err := ImportWorkspace(m, func(name string, i, n int) {
				ch <- fmt.Sprintf("Creating %s — checking out %s (%d of %d)", m.Name, name, i, n)
			})
			close(ch)
			return wsDoneMsg{name: m.Name, err: err}
		})
	}
	return v, nil
}

func listenProgress(ch chan string) tea.Cmd {
	return func() tea.Msg {
		line, ok := <-ch
		if !ok {
			return nil
		}
		return wsProgressMsg{line: line, ch: ch}
	}
}

// ── Render ──

func (v ImportView) View() string {
	var b strings.Builder
	switch {
	case v.phase == phaseDone:
		v.renderSummary(&b)
	case v.phase == phaseProjects && v.state == importStateEdit:
		v.renderEdit(&b)
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

	b.WriteString(fmt.Sprintf("  path      %-*s ", pathCol, p.Path))
	switch {
	case v.pathExists:
		b.WriteString(app.Success.Render("✓ exists"))
	case v.suggested != "":
		b.WriteString(app.Error.Render("✗ not here"))
		b.WriteString(fmt.Sprintf("\n            %-*s ", pathCol, app.Highlight.Render("→ "+v.suggested)))
		b.WriteString(app.Subtle.Render("found beside " + filepath.Base(besideOf(v.suggested, v.anchors)) + " — y uses this"))
	case v.cloneTarget() != "":
		b.WriteString(app.Error.Render("✗ not here"))
		b.WriteString(fmt.Sprintf("\n            %-*s ", pathCol, app.Highlight.Render("→ "+v.cloneTarget())))
		b.WriteString(app.Subtle.Render("c clones here" + besidePhrase(v.cloneTarget(), v.anchors)))
	case p.Remote != "":
		b.WriteString(app.Error.Render("✗ not here — c asks where to clone, e sets the path"))
	default:
		b.WriteString(app.Error.Render("✗ not here — e to set the path"))
	}
	b.WriteString("\n")

	if len(p.DevServers) > 0 {
		b.WriteString("  servers   " + app.Subtle.Render(describeServers(p.DevServers)) + "\n")
	}
	if len(p.Bindings) > 0 {
		width := 0
		for _, bd := range p.Bindings {
			width = max(width, len(bd.Var))
		}
		for i, bd := range p.Bindings {
			label := "            "
			if i == 0 {
				label = "  bindings  "
			}
			b.WriteString(label + app.Subtle.Render(fmt.Sprintf("%-*s  %s", width, bd.Var, bd.Value)) + "\n")
		}
		if st.Exists && st.Local != nil && len(st.Local.Bindings) != len(p.Bindings) {
			b.WriteString("            " + app.Subtle.Render(fmt.Sprintf("local has %s: %s", plural(len(st.Local.Bindings), "binding"), bindingNames(st.Local.Bindings))) + "\n")
		}
	}
	if p.Setup != "" {
		b.WriteString("  setup     " + app.Subtle.Render(p.Setup) + "\n")
	}
	if p.Remote != "" {
		b.WriteString("  remote    " + app.Subtle.Render(p.Remote) + "\n")
	}

	b.WriteString("\n")
	if v.warn != "" {
		b.WriteString("  " + app.Highlight.Render("! "+v.warn) + "\n\n")
	}
	if v.err != nil {
		b.WriteString("  " + app.Error.Render("! "+v.err.Error()) + "\n\n")
	}
	if v.state == importStateCloning {
		target := v.cloneTarget()
		if target == "" {
			target = p.Path
		}
		b.WriteString(fmt.Sprintf("  %s Cloning %s → %s\n", v.spinner.View(), p.Name, target))
		return
	}

	var keys []string
	switch {
	case st.Exists && v.canImport():
		keys = append(keys, "r replace local", "n keep local")
	case st.Exists:
		keys = append(keys, "n keep local")
	case v.pathExists:
		keys = append(keys, "y import")
	case v.suggested != "":
		keys = append(keys, "y import with suggested path")
	}
	if !v.pathExists && v.current.Remote != "" {
		keys = append(keys, "c clone")
	}
	keys = append(keys, "e edit")
	if !st.Exists {
		keys = append(keys, "n skip")
	}
	keys = append(keys, "esc stop")
	b.WriteString("  " + app.HelpStyle.Render(strings.Join(keys, "  ")) + "\n")
}

func (v ImportView) renderEdit(b *strings.Builder) {
	b.WriteString(v.header(" · editing"))
	b.WriteString("  name      " + v.inputs[fieldName].View() + "\n")
	b.WriteString("  path      " + v.inputs[fieldPath].View())
	if dirExists(expandHome(strings.TrimSpace(v.inputs[fieldPath].Value()))) {
		b.WriteString("  " + app.Success.Render("✓ exists"))
	} else {
		b.WriteString("  " + app.Error.Render("✗ not here"))
	}
	b.WriteString("\n")
	b.WriteString("  setup     " + v.inputs[fieldSetup].View() + "\n\n")
	b.WriteString("            " + app.Subtle.Render("servers and bindings can be changed in crew project after import") + "\n\n")
	if v.err != nil {
		b.WriteString("  " + app.Error.Render(v.err.Error()) + "\n\n")
	}
	b.WriteString("  " + app.HelpStyle.Render("tab next  enter apply  esc back") + "\n")
}

func (v ImportView) renderWorkspaceCard(b *strings.Builder) {
	m := v.bundle.Workspaces[v.idx]
	exists := v.plan.Workspaces[v.idx].Exists
	missing := MissingMembers(m, v.accepted)
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
		b.WriteString(fmt.Sprintf("  %s %s\n", v.spinner.View(), v.progress))
		return
	case exists:
		b.WriteString("  " + app.Subtle.Render("A workspace by this name is here already; an import never replaces one.") + "\n\n")
		b.WriteString("  " + app.HelpStyle.Render("n keep local  esc stop") + "\n")
	case len(missing) > 0:
		b.WriteString("  " + app.Highlight.Render(fmt.Sprintf("! needs %s, which %s not imported — n skips this workspace", strings.Join(missing, ", "), wasWere(len(missing)))) + "\n\n")
		b.WriteString("  " + app.HelpStyle.Render("n skip  esc stop") + "\n")
	default:
		b.WriteString("  " + app.Subtle.Render("Creates the main worktree: a checkout of each project, no installs.") + "\n\n")
		if v.err != nil {
			b.WriteString("  " + app.Error.Render("! "+v.err.Error()) + "\n\n")
		}
		b.WriteString("  " + app.HelpStyle.Render("y create  n skip  esc stop") + "\n")
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
	if project.Get(name) != nil {
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
			switch {
			case r.Name != e.Name:
				line += "   " + app.Subtle.Render("→ "+r.Name+" at "+r.Path)
			case r.Path != e.Path:
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
	if len(created) > 0 {
		b.WriteString("\n  crew launch " + created[0] + "\n")
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
		names = append(names, bd.Var)
	}
	return strings.Join(names, ", ")
}

// besideOf names the anchor a suggestion sits next to.
func besideOf(path string, anchors []string) string {
	for i := len(anchors) - 1; i >= 0; i-- {
		if filepath.Dir(anchors[i]) == filepath.Dir(path) {
			return anchors[i]
		}
	}
	return ""
}

func besidePhrase(path string, anchors []string) string {
	if a := besideOf(path, anchors); a != "" {
		return " — beside " + filepath.Base(a)
	}
	return ""
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
