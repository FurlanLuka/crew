package registry

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/homebrew-tap/crew/internal/app"
)

// ── Messages ──

type registryLoadedMsg struct {
	agents []AgentInfo
	skills []SkillInfo
}
type installDoneMsg struct{ name string }
type removeDoneMsg struct{ name string }
type updateDoneMsg struct{ results []updateResult }
type errMsg struct{ err error }

type updateResult struct {
	name    string
	updated bool
	err     error
}

// ── Tab ──

const (
	tabAgents = iota
	tabSkills
)

// ── Model ──

type View struct {
	tab       int
	agents    []AgentInfo
	skills    []SkillInfo
	cursor    int
	loading   bool
	statusMsg string
	err       error
}

func NewView() View {
	return View{loading: true}
}

func (v View) Title() string { return "Registry" }

func (v View) Init() tea.Cmd {
	return fetchRegistry
}

func (v View) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return v, nil

	case registryLoadedMsg:
		v.agents = msg.agents
		v.skills = msg.skills
		v.loading = false
		return v, nil

	case installDoneMsg:
		v.statusMsg = fmt.Sprintf("Installed '%s'", msg.name)
		return v, fetchRegistry

	case removeDoneMsg:
		v.statusMsg = fmt.Sprintf("Removed '%s'", msg.name)
		return v, fetchRegistry

	case updateDoneMsg:
		updated := 0
		for _, r := range msg.results {
			if r.updated {
				updated++
			}
		}
		if updated == 0 {
			v.statusMsg = "Everything up to date"
		} else {
			v.statusMsg = fmt.Sprintf("Updated %d items", updated)
		}
		return v, fetchRegistry

	case errMsg:
		v.err = msg.err
		v.loading = false
		return v, nil

	case tea.KeyMsg:
		return v.handleKey(msg)
	}
	return v, nil
}

func (v View) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	items := v.currentItems()

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
		if v.cursor < len(items)-1 {
			v.cursor++
		}
		return v, nil
	case msg.String() == "tab":
		if v.tab == tabAgents {
			v.tab = tabSkills
		} else {
			v.tab = tabAgents
		}
		v.cursor = 0
		v.statusMsg = ""
		return v, nil
	case msg.String() == "i":
		if len(items) > 0 {
			item := items[v.cursor]
			if !item.installed {
				v.statusMsg = ""
				return v, v.installItem(item.name)
			}
		}
		return v, nil
	case msg.String() == "d":
		if len(items) > 0 {
			item := items[v.cursor]
			if item.installed {
				v.statusMsg = ""
				return v, v.removeItem(item.name)
			}
		}
		return v, nil
	case msg.String() == "u":
		if len(items) > 0 {
			item := items[v.cursor]
			if item.installed {
				v.statusMsg = ""
				return v, v.updateSingleItem(item.name)
			}
		}
		return v, nil
	case msg.String() == "U":
		v.statusMsg = ""
		return v, v.updateAll()
	case msg.String() == "A":
		v.statusMsg = ""
		return v, v.installAll()
	}
	return v, nil
}

type itemInfo struct {
	name        string
	description string
	installed   bool
}

func (v View) currentItems() []itemInfo {
	if v.tab == tabAgents {
		items := make([]itemInfo, len(v.agents))
		for i, a := range v.agents {
			items[i] = itemInfo{a.Name, a.Description, a.Installed}
		}
		return items
	}
	items := make([]itemInfo, len(v.skills))
	for i, s := range v.skills {
		items[i] = itemInfo{s.Name, s.Description, s.Installed}
	}
	return items
}

func (v View) View() string {
	var b strings.Builder

	// Tabs
	agentTab := "Agents"
	skillTab := "Skills"
	if v.tab == tabAgents {
		agentTab = app.Selected.Render("[Agents]")
		skillTab = app.Subtle.Render(" Skills")
	} else {
		agentTab = app.Subtle.Render(" Agents")
		skillTab = app.Selected.Render("[Skills]")
	}
	b.WriteString("  ")
	b.WriteString(agentTab)
	b.WriteString("  ")
	b.WriteString(skillTab)
	b.WriteString("\n\n")

	if v.loading {
		b.WriteString("  Loading...\n")
		return b.String()
	}

	items := v.currentItems()

	// Split into installed and available
	var installed, available []itemInfo
	for _, item := range items {
		if item.installed {
			installed = append(installed, item)
		} else {
			available = append(available, item)
		}
	}

	globalIdx := 0

	if len(installed) > 0 {
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render("Installed:"))
		b.WriteString("\n")
		for _, item := range installed {
			v.renderItem(&b, item, globalIdx)
			globalIdx++
		}
		b.WriteString("\n")
	}

	if len(available) > 0 {
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render("Available:"))
		b.WriteString("\n")
		for _, item := range available {
			v.renderItem(&b, item, globalIdx)
			globalIdx++
		}
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
	b.WriteString(app.HelpStyle.Render("tab switch  i install  A install all  d remove  u update  U update all  esc back"))
	b.WriteString("\n")

	return b.String()
}

func (v View) renderItem(b *strings.Builder, item itemInfo, idx int) {
	cursor := "  "
	if idx == v.cursor {
		cursor = app.Selected.Render("> ")
	}

	icon := "○"
	if item.installed {
		icon = app.Success.Render("✓")
	}

	name := item.name
	if idx == v.cursor {
		name = app.Selected.Render(name)
	}

	desc := ""
	if item.description != "" {
		desc = "  " + app.Subtle.Render(truncate(item.description, 40))
	}

	b.WriteString("  ")
	b.WriteString(cursor)
	b.WriteString(icon)
	b.WriteString(" ")
	b.WriteString(fmt.Sprintf("%-20s", name))
	b.WriteString(desc)
	b.WriteString("\n")
}

// ── Commands ──

func fetchRegistry() tea.Msg {
	agents, agentErr := ListAgents()
	if agentErr != nil {
		agents = InstalledAgents()
	}

	skills, skillErr := ListSkills()
	if skillErr != nil {
		skills = InstalledSkills()
	}

	return registryLoadedMsg{agents, skills}
}

func (v View) installItem(name string) tea.Cmd {
	tab := v.tab
	return func() tea.Msg {
		var err error
		if tab == tabAgents {
			err = InstallAgent(name)
		} else {
			err = InstallSkill(name)
		}
		if err != nil {
			return errMsg{err}
		}
		return installDoneMsg{name}
	}
}

func (v View) removeItem(name string) tea.Cmd {
	tab := v.tab
	return func() tea.Msg {
		var err error
		if tab == tabAgents {
			err = RemoveAgent(name)
		} else {
			err = RemoveSkill(name)
		}
		if err != nil {
			return errMsg{err}
		}
		return removeDoneMsg{name}
	}
}

func (v View) updateSingleItem(name string) tea.Cmd {
	tab := v.tab
	return func() tea.Msg {
		var updated bool
		var err error
		if tab == tabAgents {
			updated, err = UpdateAgent(name)
		} else {
			updated, err = UpdateSkill(name)
		}
		if err != nil {
			return errMsg{err}
		}
		return updateDoneMsg{[]updateResult{{name, updated, nil}}}
	}
}

func (v View) updateAll() tea.Cmd {
	return func() tea.Msg {
		var results []updateResult

		for _, a := range InstalledAgents() {
			updated, err := UpdateAgent(a.Name)
			results = append(results, updateResult{a.Name, updated, err})
		}
		for _, s := range InstalledSkills() {
			updated, err := UpdateSkill(s.Name)
			results = append(results, updateResult{s.Name, updated, err})
		}

		return updateDoneMsg{results}
	}
}

func (v View) installAll() tea.Cmd {
	return func() tea.Msg {
		agents, _ := ListAgents()
		for _, a := range agents {
			if !a.Installed {
				InstallAgent(a.Name)
			}
		}
		skills, _ := ListSkills()
		for _, s := range skills {
			if !s.Installed {
				InstallSkill(s.Name)
			}
		}
		return installDoneMsg{"all agents and skills"}
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-3] + "..."
}
