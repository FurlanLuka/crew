package app

import (
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/lipgloss"
)

var (
	Title     = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("12"))
	Subtle    = lipgloss.NewStyle().Foreground(lipgloss.Color("241"))
	Success   = lipgloss.NewStyle().Foreground(lipgloss.Color("10"))
	Error     = lipgloss.NewStyle().Foreground(lipgloss.Color("9"))
	Highlight = lipgloss.NewStyle().Foreground(lipgloss.Color("14"))
	Selected  = lipgloss.NewStyle().Foreground(lipgloss.Color("12")).Bold(true)
	HelpStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("241"))
)

// MoveCursor steps a list cursor by delta, clamped to [0, n).
func MoveCursor(cur, delta, n int) int {
	next := cur + delta
	if next < 0 || n == 0 {
		return 0
	}
	if next >= n {
		return n - 1
	}
	return next
}

// RowPrefix is the two-column gutter every list row starts with.
func RowPrefix(selected bool) string {
	if selected {
		return Selected.Render("> ")
	}
	return "  "
}

// RowName renders a row's primary label, highlighted when selected.
func RowName(name string, selected bool) string {
	if selected {
		return Selected.Render(name)
	}
	return name
}

// NewSpinner is the one spinner every view shows while something runs.
func NewSpinner() spinner.Model {
	sp := spinner.New()
	sp.Spinner = spinner.Dot
	sp.Style = Highlight
	return sp
}
