package procs

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
)

// ── Messages ──

type inventoryLoadedMsg struct {
	inv     Inventory
	targets []int
}
type reclaimedMsg struct{ report Report }
type errMsg struct{ err error }

// ── Model ──

type View struct {
	inv     Inventory
	targets []int
	loading bool
	report  *Report
	spinner spinner.Model
	err     error
}

func NewView() View {
	sp := spinner.New()
	sp.Spinner = spinner.Dot
	return View{loading: true, spinner: sp}
}

func (v View) Title() string { return "Processes" }

func (v View) Init() tea.Cmd {
	return tea.Batch(v.spinner.Tick, loadInventory)
}

func loadInventory() tea.Msg {
	inv, err := Collect()
	if err != nil {
		return errMsg{err}
	}
	targets, err := Killable(inv)
	if err != nil {
		return errMsg{err}
	}
	return inventoryLoadedMsg{inv: inv, targets: targets}
}

func (v View) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return v, nil

	case inventoryLoadedMsg:
		v.inv = msg.inv
		v.targets = msg.targets
		v.loading = false
		return v, nil

	case reclaimedMsg:
		report := msg.report
		v.report = &report
		v.loading = true
		return v, tea.Batch(v.spinner.Tick, loadInventory)

	case errMsg:
		v.err = msg.err
		v.loading = false
		return v, nil

	case spinner.TickMsg:
		if v.loading {
			var cmd tea.Cmd
			v.spinner, cmd = v.spinner.Update(msg)
			return v, cmd
		}
		return v, nil

	case tea.KeyMsg:
		return v.handleKey(msg)
	}

	return v, nil
}

func (v View) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, app.Keys.Quit):
		return v, tea.Quit
	case key.Matches(msg, app.Keys.Back):
		return v, func() tea.Msg { return app.PopPageMsg{} }
	case msg.String() == "r":
		v.loading = true
		v.err = nil
		return v, tea.Batch(v.spinner.Tick, loadInventory)
	case msg.String() == "k":
		if v.loading || (len(v.inv.Sessions) == 0 && len(v.targets) == 0) {
			return v, nil
		}
		inv := v.inv
		v.loading = true
		return v, tea.Batch(v.spinner.Tick, func() tea.Msg {
			report, err := Reclaim(inv)
			if err != nil {
				return errMsg{err}
			}
			return reclaimedMsg{report: report}
		})
	}
	return v, nil
}

func (v View) View() string {
	var b strings.Builder

	if v.loading {
		b.WriteString("  ")
		b.WriteString(v.spinner.View())
		b.WriteString(" Scanning...\n")
		return b.String()
	}

	b.WriteString("  ")
	b.WriteString(app.Subtle.Render(Summary(v.inv)))
	b.WriteString("\n\n")

	if len(v.inv.Sessions) == 0 {
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render("No crew sessions running."))
		b.WriteString("\n")
	}
	for _, s := range v.inv.Sessions {
		fmt.Fprintf(&b, "  %s  %s\n", s.Name, app.Subtle.Render(fmt.Sprintf("%d processes", len(s.Procs))))
	}

	b.WriteString("\n  ")
	b.WriteString(app.Subtle.Render("Loose processes"))
	b.WriteString("\n")
	switch {
	case v.inv.ScanNote != "":
		// Never render this as zero — not looking and finding nothing are
		// different answers.
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render(v.inv.ScanNote))
		b.WriteString("\n")
	case len(v.inv.Orphans) == 0:
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render("None."))
		b.WriteString("\n")
	default:
		for _, o := range v.inv.Orphans {
			fmt.Fprintf(&b, "  %-7d %s\n", o.PID, truncate(o.Command, 60))
		}
	}

	if n := len(v.inv.Attached); n > 0 {
		b.WriteString("\n  ")
		b.WriteString(app.Subtle.Render(fmt.Sprintf(
			"%d process(es) in the workspace tree still have a live parent — left alone.", n)))
		b.WriteString("\n")
	}

	if v.report != nil {
		fmt.Fprintf(&b, "\n  Stopped %d session(s), reclaimed %d process(es).\n",
			len(v.report.Sessions), len(v.report.Killed))
		for _, cmd := range v.report.Restore {
			fmt.Fprintf(&b, "  restore: %s\n", cmd)
		}
	}

	if v.err != nil {
		b.WriteString("\n  ")
		b.WriteString(app.Error.Render(v.err.Error()))
		b.WriteString("\n")
	}

	b.WriteString("\n  ")
	b.WriteString(app.HelpStyle.Render("k reclaim  r refresh  esc back"))
	b.WriteString("\n")

	return b.String()
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}
