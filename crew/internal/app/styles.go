package app

import "github.com/charmbracelet/lipgloss"

var (
	Title     = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("12"))
	Subtle    = lipgloss.NewStyle().Foreground(lipgloss.Color("241"))
	Success   = lipgloss.NewStyle().Foreground(lipgloss.Color("10"))
	Error     = lipgloss.NewStyle().Foreground(lipgloss.Color("9"))
	Highlight = lipgloss.NewStyle().Foreground(lipgloss.Color("14"))
	Selected  = lipgloss.NewStyle().Foreground(lipgloss.Color("12")).Bold(true)
	HelpStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("241"))
)
