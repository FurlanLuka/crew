package app

import (
	"strings"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"
)

type MenuItem struct {
	Label       string
	Description string
	Page        func() Page
}

type Menu struct {
	items  []MenuItem
	cursor int
}

func NewMenu(items []MenuItem) Menu {
	return Menu{items: items}
}

func (m Menu) Title() string { return "crew" }

func (m Menu) Init() tea.Cmd { return nil }

func (m Menu) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch {
		case key.Matches(msg, Keys.Quit):
			return m, tea.Quit
		case key.Matches(msg, Keys.Up):
			if m.cursor > 0 {
				m.cursor--
			}
			return m, nil
		case key.Matches(msg, Keys.Down):
			if m.cursor < len(m.items)-1 {
				m.cursor++
			}
			return m, nil
		case msg.String() == "enter":
			item := m.items[m.cursor]
			page := item.Page()
			return m, func() tea.Msg { return PushPageMsg{Page: page} }
		}
	}
	return m, nil
}

func (m Menu) View() string {
	var b strings.Builder

	for i, item := range m.items {
		cursor := "  "
		if i == m.cursor {
			cursor = Selected.Render("> ")
		}

		label := item.Label
		if i == m.cursor {
			label = Selected.Render(label)
		}

		b.WriteString(cursor)
		b.WriteString(label)

		if item.Description != "" {
			b.WriteString("  ")
			b.WriteString(Subtle.Render(item.Description))
		}
		b.WriteString("\n")
	}

	b.WriteString("\n")
	b.WriteString("  ")
	b.WriteString(HelpStyle.Render("enter select  q quit"))
	b.WriteString("\n")

	return b.String()
}
