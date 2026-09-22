package workspaceui

import (
	"errors"
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/projectui"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// The project picker: the pool as tick rows with a mode each, the one
// component behind the wizard's projects card and the workspace page's
// a. It is fed facts at open and on every reload, and never acts — enter
// hands the ticked specs to its host, which creates or adds.

// pickRow is one pool project as the picker shows it.
type pickRow struct {
	Name   string
	Ticked bool
	Mode   string
	// Refusal is why the row cannot go direct, "" when it can — read by
	// the host's load, never here.
	Refusal string
	// Servers is the row's servers column: "web :3000 next dev", or
	// "no servers".
	Servers string
}

// pickerFacts is what a load hands the picker: the pool, the names to
// leave out (a page's members), and each project's direct refusal.
type pickerFacts struct {
	Pool     []project.Project
	Exclude  map[string]bool
	Refusals map[string]string
}

// pickerFactsMsg carries a load's result to the host, which hands it on.
type pickerFactsMsg struct{ facts pickerFacts }

type picker struct {
	ws     string
	rows   []pickRow
	cursor int
	// allMembers: the pool is not empty, every project in it is already
	// a member — the empty list says so rather than "no projects yet".
	allMembers bool
	// known is every name the last load showed; a name not in it on a
	// reload is one the user just added through a — it comes back ticked.
	known  map[string]bool
	loaded bool
	err    error
}

func newPicker(ws string) picker { return picker{ws: ws} }

// loadPickerFacts reads the pool and the direct refusals once. ws is the
// workspace the picks would join — the wizard's has a name and nothing
// else yet.
func loadPickerFacts(ws *workspace.Workspace, exclude map[string]bool) tea.Cmd {
	return func() tea.Msg {
		pool, err := project.List()
		if err != nil {
			return errMsg{err}
		}
		return pickerFactsMsg{facts: pickerFacts{Pool: pool, Exclude: exclude, Refusals: workspace.DirectRefusals(ws, pool)}}
	}
}

// pickerRows lays the pool out as rows, the excluded names left out.
// Pure.
func pickerRows(f pickerFacts) []pickRow {
	var rows []pickRow
	for _, p := range f.Pool {
		if f.Exclude[p.Name] {
			continue
		}
		rows = append(rows, pickRow{Name: p.Name, Mode: workspace.ModeWorktree, Refusal: f.Refusals[p.Name], Servers: serversColumn(p.DevServers)})
	}
	return rows
}

func serversColumn(servers []project.DevServer) string {
	if len(servers) == 0 {
		return "no servers"
	}
	parts := make([]string, 0, len(servers))
	for _, ds := range servers {
		parts = append(parts, fmt.Sprintf("%s %s %s", ds.Name, ds.PortLabel(), ds.Command))
	}
	return strings.Join(parts, ", ")
}

// reload takes a fresh load: ticks and modes survive by name, a name the
// picker has not seen before arrives ticked — the user left to add it.
func (p *picker) reload(f pickerFacts) {
	fresh := pickerRows(f)
	prev := map[string]pickRow{}
	for _, r := range p.rows {
		prev[r.Name] = r
	}
	for i := range fresh {
		if old, ok := prev[fresh[i].Name]; ok {
			fresh[i].Ticked, fresh[i].Mode = old.Ticked, old.Mode
		} else if p.loaded && !p.known[fresh[i].Name] {
			fresh[i].Ticked = true
		}
	}
	p.known = map[string]bool{}
	for _, r := range fresh {
		p.known[r.Name] = true
	}
	p.rows = fresh
	p.allMembers = len(fresh) == 0 && len(f.Pool) > 0
	p.loaded = true
	p.cursor = min(p.cursor, max(0, len(p.rows)-1))
}

// specs is the ticked rows in pool order.
func (p picker) specs() []workspace.ProjectSpec {
	var specs []workspace.ProjectSpec
	for _, r := range p.rows {
		if r.Ticked {
			specs = append(specs, workspace.ProjectSpec{Name: r.Name, Mode: r.Mode})
		}
	}
	return specs
}

// specsAsMembers is the ticked rows as the workspace they would make.
func (p picker) specsAsMembers() []workspace.WorkspaceProject {
	var members []workspace.WorkspaceProject
	for _, s := range p.specs() {
		members = append(members, workspace.WorkspaceProject{Name: s.Name, Mode: s.Mode})
	}
	return members
}

func (p picker) ticked() map[string]bool {
	out := map[string]bool{}
	for _, r := range p.rows {
		if r.Ticked {
			out[r.Name] = true
		}
	}
	return out
}

// handleKey takes the picker's own keys — the cursor, space, m, a — and
// reports whether it did. enter is the host's: what the picks mean
// differs between them.
func (p picker) handleKey(msg tea.KeyMsg) (picker, tea.Cmd, bool) {
	switch {
	case key.Matches(msg, app.Keys.Up):
		p.cursor = app.MoveCursor(p.cursor, -1, len(p.rows))
		return p, nil, true
	case key.Matches(msg, app.Keys.Down):
		p.cursor = app.MoveCursor(p.cursor, 1, len(p.rows))
		return p, nil, true
	case msg.String() == " ":
		if len(p.rows) > 0 {
			p.rows[p.cursor].Ticked = !p.rows[p.cursor].Ticked
			p.err = nil
		}
		return p, nil, true
	case msg.String() == "m":
		if len(p.rows) == 0 {
			return p, nil, true
		}
		r := &p.rows[p.cursor]
		switch {
		case r.Mode == workspace.ModeDirect:
			r.Mode = workspace.ModeWorktree
			p.err = nil
		case r.Refusal != "":
			// The reason shows on the error line, once, when asked —
			// not on every row the user has not touched.
			p.err = errors.New(r.Refusal)
		default:
			r.Mode = workspace.ModeDirect
			p.err = nil
		}
		return p, nil, true
	case msg.String() == "a":
		ws := p.ws
		return p, func() tea.Msg { return app.PushPageMsg{Page: projectui.NewInWorkspace(ws)} }, true
	}
	return p, nil, false
}

// picked is enter: the ticked specs, or why there are none.
func (p picker) picked() ([]workspace.ProjectSpec, error) {
	specs := p.specs()
	if len(specs) == 0 {
		return nil, errors.New("nothing ticked — space ticks the row under the cursor")
	}
	return specs, nil
}

// render draws the rows; the cursor's line is returned for windowing.
func (p picker) render(b *strings.Builder) int {
	cursorLine := strings.Count(b.String(), "\n")
	if !p.loaded {
		b.WriteString("  " + app.Subtle.Render("reading the pool…") + "\n")
		return cursorLine
	}
	if len(p.rows) == 0 {
		empty := "no projects yet — a clones or adopts one"
		if p.allMembers {
			empty = "every project in the pool is here already — a adds a new one"
		}
		b.WriteString("  " + app.Subtle.Render(empty) + "\n")
		return cursorLine
	}
	width := 0
	for _, r := range p.rows {
		width = max(width, len(r.Name))
	}
	for i, r := range p.rows {
		sel := i == p.cursor
		if sel {
			cursorLine = strings.Count(b.String(), "\n")
		}
		tick := "○ "
		if r.Ticked {
			tick = app.Success.Render("✓ ")
		}
		b.WriteString("  " + app.RowPrefix(sel) + tick + app.RowName(fmt.Sprintf("%-*s", width, r.Name), sel) + "   " + renderMode(r.Mode) + "   " + app.Subtle.Render(r.Servers) + "\n")
	}
	return cursorLine
}

// renderMode is the mode column: one width, direct set off from the
// default.
func renderMode(mode string) string {
	label := fmt.Sprintf("%-8s", workspace.ModeLabel(mode))
	if mode == workspace.ModeDirect {
		return app.Highlight.Render(label)
	}
	return app.Subtle.Render(label)
}

// pickerKeys is the picker's key line, the host adding its own enter.
const pickerKeys = "space tick  m mode  a add a project"

// bindingLine is one wire between two pool projects: a binding of From
// whose template targets To. OK when To is in the workspace too — ticked
// or already a member.
type bindingLine struct {
	Var, From, To string
	OK            bool
}

// bindingLines is what the ticked projects would wire up and what they
// would miss, pure over the pool: a token that targets another pool
// project makes a line; {{worktree}}/{{workspace}}, a target outside the
// pool and a malformed template make none. One line per (var, from, to).
func bindingLines(pool []project.Project, ticked, members map[string]bool) []bindingLine {
	inPool := map[string]bool{}
	for _, p := range pool {
		inPool[p.Name] = true
	}
	var lines []bindingLine
	seen := map[bindingLine]bool{}
	for _, p := range pool {
		if !ticked[p.Name] {
			continue
		}
		for _, bd := range p.Bindings {
			tokens, err := dev.ParseTokens(bd.Value)
			if err != nil {
				continue
			}
			for _, tok := range tokens {
				to := tok.Target.Project
				if tok.Kind != dev.TokenTarget || to == p.Name || !inPool[to] {
					continue
				}
				l := bindingLine{Var: bd.Var, From: p.Name, To: to, OK: ticked[to] || members[to]}
				if !seen[l] {
					seen[l] = true
					lines = append(lines, l)
				}
			}
		}
	}
	return lines
}

// maxBindingLines is how many wires the card lists; the rest fold into
// one "+N more" line.
const maxBindingLines = 3

// renderBindingLines draws the wires block, "" when there are none.
func renderBindingLines(lines []bindingLine) string {
	if len(lines) == 0 {
		return ""
	}
	var b strings.Builder
	width, wire := 0, 0
	for _, l := range lines {
		width = max(width, len(l.Var))
		wire = max(wire, len(l.From+" → "+l.To))
	}
	for i, l := range lines {
		if i == maxBindingLines {
			b.WriteString(fmt.Sprintf("             %s\n", app.Subtle.Render(fmt.Sprintf("+%d more", len(lines)-i))))
			break
		}
		label := "             "
		if i == 0 {
			label = "  bindings   "
		}
		status := app.Success.Render("✓ in this workspace")
		if !l.OK {
			status = app.Highlight.Render("! " + l.To + " is not ticked")
		}
		b.WriteString(label + fmt.Sprintf("%-*s  %-*s    ", width, l.Var, wire, l.From+" → "+l.To) + status + "\n")
	}
	return b.String()
}
