package workspaceui

import (
	"strings"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// The new-workspace wizard: name, projects, create — three cards ending on
// the worktree page with its runners live. It runs in place inside the
// list (v.wizard != nil) rather than as a pushed page: after y it hands
// off to the worktree page, and the app stack has push and pop only — a
// pushed wizard would sit under the page it made, and esc from there
// would land on a finished card. Every card names the CLI line it stands
// for.

type wizardCard int

const (
	cardName wizardCard = iota
	cardProjects
	cardCreate
)

func (c wizardCard) label() string {
	switch c {
	case cardName:
		return "name"
	case cardProjects:
		return "projects"
	}
	return "create"
}

// wizardCreatedMsg: the workspace and its main worktree are recorded and
// the runners are going; the host pushes the page.
type wizardCreatedMsg struct{ ref workspace.Ref }

type wizard struct {
	card   wizardCard
	name   textinput.Model
	wsName string
	picker picker
	// pool is what the picker was last fed — the bindings block reads it.
	pool []project.Project

	bases basePane
	// creating: y is on its way; keys wait for it, a second y does not
	// start a second create.
	creating bool

	spinner spinner.Model
	err     error
	// closed: esc on the first card; the host drops the wizard.
	closed bool
}

func newWizard() wizard {
	ti := textinput.New()
	ti.Placeholder = "feature-auth"
	ti.CharLimit = 64
	ti.Focus()
	return wizard{name: ti, spinner: app.NewSpinner()}
}

func (w wizard) init() tea.Cmd { return w.name.Cursor.BlinkCmd() }

// reload is what the host's Init hands the wizard on a pop back — the
// picker re-reads the pool so a project added meanwhile comes back
// ticked.
func (w wizard) reload() tea.Cmd {
	if w.card != cardProjects {
		return nil
	}
	return loadPickerFacts(w.workspace(), nil)
}

// workspace is the one being made, as far as the picker and the base
// table need it: a name and no worktrees yet.
func (w wizard) workspace() *workspace.Workspace {
	return &workspace.Workspace{Name: w.wsName, Projects: w.picker.specsAsMembers()}
}

func (w wizard) Update(msg tea.Msg) (wizard, tea.Cmd) {
	switch msg := msg.(type) {
	case pickerFactsMsg:
		w.pool = msg.facts.Pool
		w.picker.reload(msg.facts)
		return w, nil
	case basesMsg:
		if w.card != cardCreate {
			return w, nil
		}
		var err error
		if w.bases, err = w.bases.apply(msg); err != nil {
			w.err = err
		}
		return w, nil
	case errMsg:
		w.creating = false
		w.err = msg.err
		return w, nil
	case spinner.TickMsg:
		if w.card == cardCreate && (w.bases.busy() || w.creating) {
			var cmd tea.Cmd
			w.spinner, cmd = w.spinner.Update(msg)
			return w, cmd
		}
		return w, nil
	case tea.KeyMsg:
		return w.handleKey(msg)
	}
	if w.card == cardName {
		var cmd tea.Cmd
		w.name, cmd = w.name.Update(msg)
		return w, cmd
	}
	return w, nil
}

func (w wizard) handleKey(msg tea.KeyMsg) (wizard, tea.Cmd) {
	if w.creating {
		return w, nil
	}
	switch w.card {
	case cardName:
		return w.handleNameKey(msg)
	case cardProjects:
		return w.handleProjectsKey(msg)
	}
	return w.handleCreateKey(msg)
}

func (w wizard) handleNameKey(msg tea.KeyMsg) (wizard, tea.Cmd) {
	switch msg.String() {
	case "esc":
		w.closed = true
		return w, nil
	case "enter":
		name := strings.TrimSpace(w.name.Value())
		if err := workspace.NameAvailable(name); err != nil {
			w.err = err
			return w, nil
		}
		w.wsName, w.err = name, nil
		w.card = cardProjects
		w.picker = newPicker(name)
		return w, loadPickerFacts(w.workspace(), nil)
	}
	var cmd tea.Cmd
	w.name, cmd = w.name.Update(msg)
	return w, cmd
}

func (w wizard) handleProjectsKey(msg tea.KeyMsg) (wizard, tea.Cmd) {
	switch msg.String() {
	case "esc":
		w.card, w.err = cardName, nil
		return w, w.name.Cursor.BlinkCmd()
	case "enter":
		if _, err := w.picker.picked(); err != nil {
			w.err = err
			return w, nil
		}
		w.err = nil
		w.card = cardCreate
		return w, w.bases.fetch(w.workspace(), w.spinner.Tick)
	}
	var cmd tea.Cmd
	var handled bool
	if w.picker, cmd, handled = w.picker.handleKey(msg); handled {
		w.err = w.picker.err
	}
	return w, cmd
}

func (w wizard) handleCreateKey(msg tea.KeyMsg) (wizard, tea.Cmd) {
	switch msg.String() {
	case "esc":
		w.card, w.err = cardProjects, nil
		w.bases.drop()
		return w, nil
	case "ctrl+p":
		if cmd := w.bases.pull(w.workspace(), w.spinner.Tick); cmd != nil {
			w.err = nil
			return w, cmd
		}
		return w, nil
	case "y", "Y":
		if !w.bases.ready() {
			return w, nil
		}
		w.creating, w.err = true, nil
		name, specs := w.wsName, w.picker.specs()
		return w, tea.Batch(w.spinner.Tick, func() tea.Msg {
			ref, _, err := workspace.CreateWith(name, specs, workspace.CheckoutOptions{Install: true, Smoke: true})
			if err != nil {
				return errMsg{err}
			}
			return wizardCreatedMsg{ref: ref}
		})
	}
	return w, nil
}

// cliLine is the crew add workspace line for what is ticked — the
// footer's pasteable command. --direct rides along only when every pick
// is direct; a mix has no one-line form, which the card copy says. Pure.
func cliLine(name string, specs []workspace.ProjectSpec) string {
	if name == "" {
		name = "<name>"
	}
	if len(specs) == 0 {
		return "crew add workspace " + name + " <project> …"
	}
	parts := []string{"crew", "add", "workspace", name}
	allDirect := true
	for _, s := range specs {
		parts = append(parts, s.Name)
		allDirect = allDirect && s.Mode == workspace.ModeDirect
	}
	if allDirect {
		parts = append(parts, "--direct")
	}
	return strings.Join(parts, " ")
}
