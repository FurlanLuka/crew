package workspace

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
)

// ── Messages ──

type devServersLoadedMsg struct{ items []devItem }
type devServerSavedMsg struct{}
type devServerRemovedMsg struct{}
type devStartedMsg struct{ status string }
type devStoppedMsg struct{}

// ── States ──

type devState int

const (
	devStateList devState = iota
	devStatePickProject
	devStateForm
	devStateConfirmRemove
)

// ── Data ──

type devItem struct {
	ProjectName string
	Server      DevServer
	Running     bool
	URL         string
}

// ── Model ──

type DevView struct {
	wsName      string
	state       devState
	items       []devItem
	cursor      int
	inputs      [4]textinput.Model // name, port, command, dir
	formField   int
	formProject string
	editIdx     int // -1 for add, >= 0 for edit
	projects    []string
	projCursor  int
	loading     bool
	actionMsg   string
	spinner     spinner.Model
	statusMsg   string
	err         error
}

func NewDevView(wsName string) DevView {
	var inputs [4]textinput.Model
	placeholders := [4]string{"web", "5173", "npm run dev", "apps/web (optional)"}
	limits := [4]int{32, 6, 128, 128}
	for i := range inputs {
		inputs[i] = textinput.New()
		inputs[i].Placeholder = placeholders[i]
		inputs[i].CharLimit = limits[i]
	}

	sp := spinner.New()
	sp.Spinner = spinner.Dot

	return DevView{
		wsName:  wsName,
		state:   devStateList,
		inputs:  inputs,
		editIdx: -1,
		spinner: sp,
	}
}

func (v DevView) Title() string {
	return fmt.Sprintf("Dev Servers for \"%s\"", v.wsName)
}

func (v DevView) Init() tea.Cmd {
	return v.loadDevServers()
}

func (v DevView) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return v, nil

	case devServersLoadedMsg:
		v.items = msg.items
		if v.cursor >= len(v.items) {
			v.cursor = max(0, len(v.items)-1)
		}
		return v, nil

	case devProjectsMsg:
		v.projects = msg.names
		v.projCursor = 0
		if len(msg.names) == 1 {
			v.formProject = msg.names[0]
			v.editIdx = -1
			v.state = devStateForm
			v.inputs[0].Focus()
			return v, v.inputs[0].Cursor.BlinkCmd()
		}
		v.state = devStatePickProject
		return v, nil

	case devServerSavedMsg:
		v.state = devStateList
		v.statusMsg = "Server saved"
		v.err = nil
		v.resetForm()
		return v, v.loadDevServers()

	case devServerRemovedMsg:
		v.state = devStateList
		v.statusMsg = "Server removed"
		v.err = nil
		return v, v.loadDevServers()

	case devStartedMsg:
		v.loading = false
		v.statusMsg = msg.status
		v.err = nil
		return v, v.loadDevServers()

	case devStoppedMsg:
		v.loading = false
		v.statusMsg = "Dev servers stopped"
		v.err = nil
		return v, v.loadDevServers()

	case errMsg:
		v.err = msg.err
		v.loading = false
		v.state = devStateList
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

	if v.state == devStateForm {
		return v.updateFormInputs(msg)
	}

	return v, nil
}

func (v DevView) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch v.state {
	case devStateList:
		return v.handleListKey(msg)
	case devStatePickProject:
		return v.handlePickProjectKey(msg)
	case devStateForm:
		return v.handleFormKey(msg)
	case devStateConfirmRemove:
		return v.handleConfirmRemoveKey(msg)
	}
	return v, nil
}

func (v DevView) handleListKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if v.loading {
		return v, nil
	}

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
		if v.cursor < len(v.items)-1 {
			v.cursor++
		}
		return v, nil
	case msg.String() == "a":
		v.resetForm()
		v.statusMsg = ""
		v.err = nil
		return v, v.beginAdd()
	case msg.String() == "e":
		if len(v.items) > 0 {
			v.prefillForm(v.cursor)
			v.state = devStateForm
			v.inputs[0].Focus()
			return v, v.inputs[0].Cursor.BlinkCmd()
		}
		return v, nil
	case msg.String() == "d":
		if len(v.items) > 0 {
			v.state = devStateConfirmRemove
			v.statusMsg = ""
		}
		return v, nil
	case msg.String() == "S":
		v.loading = true
		v.actionMsg = "Starting dev servers..."
		v.statusMsg = ""
		v.err = nil
		return v, tea.Batch(v.spinner.Tick, v.startAllDevServers())
	case msg.String() == "X":
		v.loading = true
		v.actionMsg = "Stopping dev servers..."
		v.statusMsg = ""
		v.err = nil
		return v, tea.Batch(v.spinner.Tick, v.stopAllDevServers())
	}
	return v, nil
}

func (v DevView) handlePickProjectKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, app.Keys.Back):
		v.state = devStateList
		return v, nil
	case key.Matches(msg, app.Keys.Up):
		if v.projCursor > 0 {
			v.projCursor--
		}
		return v, nil
	case key.Matches(msg, app.Keys.Down):
		if v.projCursor < len(v.projects)-1 {
			v.projCursor++
		}
		return v, nil
	case msg.String() == "enter":
		if len(v.projects) > 0 {
			v.formProject = v.projects[v.projCursor]
			v.editIdx = -1
			v.state = devStateForm
			v.inputs[0].Focus()
			return v, v.inputs[0].Cursor.BlinkCmd()
		}
		return v, nil
	}
	return v, nil
}

func (v DevView) handleFormKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		v.state = devStateList
		v.resetForm()
		return v, nil
	case "tab":
		v.inputs[v.formField].Blur()
		v.formField = (v.formField + 1) % 4
		v.inputs[v.formField].Focus()
		return v, v.inputs[v.formField].Cursor.BlinkCmd()
	case "enter":
		return v, v.saveServer()
	}
	return v.updateFormInputs(msg)
}

func (v DevView) handleConfirmRemoveKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "y", "Y":
		item := v.items[v.cursor]
		v.state = devStateList
		return v, v.removeServer(item.ProjectName, item.Server.Name)
	default:
		v.state = devStateList
		return v, nil
	}
}

func (v DevView) updateFormInputs(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	v.inputs[v.formField], cmd = v.inputs[v.formField].Update(msg)
	return v, cmd
}

func (v *DevView) resetForm() {
	for i := range v.inputs {
		v.inputs[i].Reset()
		v.inputs[i].Blur()
	}
	v.formField = 0
	v.formProject = ""
	v.editIdx = -1
}

func (v *DevView) prefillForm(idx int) {
	item := v.items[idx]
	v.formProject = item.ProjectName
	v.editIdx = idx
	v.inputs[0].SetValue(item.Server.Name)
	v.inputs[1].SetValue(strconv.Itoa(item.Server.Port))
	v.inputs[2].SetValue(item.Server.Command)
	v.inputs[3].SetValue(item.Server.Dir)
	v.formField = 0
}

// ── View ──

func (v DevView) View() string {
	var b strings.Builder

	switch v.state {
	case devStateList:
		v.renderList(&b)
	case devStatePickProject:
		v.renderPickProject(&b)
	case devStateForm:
		v.renderForm(&b)
	case devStateConfirmRemove:
		v.renderConfirmRemove(&b)
	}

	return b.String()
}

func (v DevView) renderList(b *strings.Builder) {
	if len(v.items) == 0 {
		b.WriteString("  ")
		b.WriteString(app.Subtle.Render("No dev servers configured."))
		b.WriteString("\n\n")
		b.WriteString("  ")
		b.WriteString(app.HelpStyle.Render("a add  esc back"))
		b.WriteString("\n")
		return
	}

	currentProject := ""
	for i, item := range v.items {
		if item.ProjectName != currentProject {
			if currentProject != "" {
				b.WriteString("\n")
			}
			b.WriteString("  ")
			b.WriteString(app.Highlight.Render(item.ProjectName))
			b.WriteString("\n")
			currentProject = item.ProjectName
		}

		cursor := "    "
		if i == v.cursor {
			cursor = "  " + app.Selected.Render("> ")
		}

		name := item.Server.Name
		if i == v.cursor {
			name = app.Selected.Render(name)
		}

		port := fmt.Sprintf(":%d", item.Server.Port)
		status := app.Subtle.Render("stopped")
		if item.Running {
			status = app.Success.Render("running")
		}

		b.WriteString(cursor)
		b.WriteString(fmt.Sprintf("%-12s %-8s %-20s %s",
			name, port, app.Subtle.Render(item.Server.Command), status))
		if item.URL != "" {
			b.WriteString("  ")
			b.WriteString(app.Subtle.Render(item.URL))
		}
		b.WriteString("\n")
	}

	b.WriteString("\n")
	if v.loading {
		b.WriteString("  ")
		b.WriteString(v.spinner.View())
		b.WriteString(" ")
		b.WriteString(v.actionMsg)
		b.WriteString("\n\n")
	}
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
	b.WriteString(app.HelpStyle.Render("a add  e edit  d delete  S start all  X stop all  esc back"))
	b.WriteString("\n")
}

func (v DevView) renderPickProject(b *strings.Builder) {
	b.WriteString("  ")
	b.WriteString(app.Subtle.Render("Select project:"))
	b.WriteString("\n\n")

	for i, name := range v.projects {
		cursor := "  "
		if i == v.projCursor {
			cursor = app.Selected.Render("> ")
		}
		display := name
		if i == v.projCursor {
			display = app.Selected.Render(name)
		}
		b.WriteString("  ")
		b.WriteString(cursor)
		b.WriteString(display)
		b.WriteString("\n")
	}

	b.WriteString("\n  ")
	b.WriteString(app.HelpStyle.Render("enter select  esc cancel"))
	b.WriteString("\n")
}

func (v DevView) renderForm(b *strings.Builder) {
	action := "Adding server to"
	if v.editIdx >= 0 {
		action = "Editing server in"
	}
	b.WriteString(fmt.Sprintf("  %s \"%s\"\n\n", action, v.formProject))

	labels := [4]string{"Name:    ", "Port:    ", "Command: ", "Dir:     "}
	for i, label := range labels {
		b.WriteString("  ")
		b.WriteString(label)
		b.WriteString(v.inputs[i].View())
		b.WriteString("\n")
	}

	b.WriteString("\n  ")
	b.WriteString(app.HelpStyle.Render("tab next field  enter save  esc cancel"))
	b.WriteString("\n")
}

func (v DevView) renderConfirmRemove(b *strings.Builder) {
	item := v.items[v.cursor]
	b.WriteString(fmt.Sprintf("  Remove server '%s' from '%s'? (y/n)\n", item.Server.Name, item.ProjectName))
}

// ── Commands ──

func (v DevView) loadDevServers() tea.Cmd {
	wsName := v.wsName
	return func() tea.Msg {
		ws, err := Load(wsName)
		if err != nil {
			return errMsg{err}
		}

		routes, _ := dev.LoadRoutes(wsName)
		host := dev.DetectLANIP()

		// Build running route lookup: port -> Route
		runningPorts := map[int]dev.Route{}
		for _, r := range routes {
			runningPorts[r.ExternalPort] = r
		}

		var items []devItem
		for _, p := range ws.Projects {
			for _, ds := range p.DevServers {
				item := devItem{
					ProjectName: p.Name,
					Server:      ds,
				}
				if r, ok := runningPorts[ds.Port]; ok {
					item.Running = true
					item.URL = fmt.Sprintf("http://%s.%s.nip.io:%d", r.Subdomain, host, r.ExternalPort)
				}
				items = append(items, item)
			}
		}
		return devServersLoadedMsg{items}
	}
}

func (v *DevView) beginAdd() tea.Cmd {
	wsName := v.wsName
	return func() tea.Msg {
		ws, err := Load(wsName)
		if err != nil {
			return errMsg{err}
		}
		if len(ws.Projects) == 0 {
			return errMsg{fmt.Errorf("workspace has no projects")}
		}
		var names []string
		for _, p := range ws.Projects {
			names = append(names, p.Name)
		}
		return devProjectsMsg{names}
	}
}

type devProjectsMsg struct{ names []string }

func (v DevView) saveServer() tea.Cmd {
	wsName := v.wsName
	projName := v.formProject
	nameVal := strings.TrimSpace(v.inputs[0].Value())
	portStr := strings.TrimSpace(v.inputs[1].Value())
	cmdVal := strings.TrimSpace(v.inputs[2].Value())
	dirVal := strings.TrimSpace(v.inputs[3].Value())
	editIdx := v.editIdx

	return func() tea.Msg {
		if nameVal == "" || portStr == "" || cmdVal == "" {
			return errMsg{fmt.Errorf("name, port, and command are required")}
		}

		port, err := strconv.Atoi(portStr)
		if err != nil || port <= 0 {
			return errMsg{fmt.Errorf("invalid port number")}
		}

		ws, err := Load(wsName)
		if err != nil {
			return errMsg{err}
		}

		ds := DevServer{Name: nameVal, Port: port, Command: cmdVal, Dir: dirVal}

		// If editing, remove old entry first
		if editIdx >= 0 {
			count := 0
			for i, p := range ws.Projects {
				for j := range p.DevServers {
					if count == editIdx {
						ws.Projects[i].DevServers = append(ws.Projects[i].DevServers[:j], ws.Projects[i].DevServers[j+1:]...)
						goto addNew
					}
					count++
				}
			}
		}

	addNew:
		for i, p := range ws.Projects {
			if p.Name == projName {
				// Replace existing with same name, or append
				replaced := false
				for j, existing := range ws.Projects[i].DevServers {
					if existing.Name == nameVal {
						ws.Projects[i].DevServers[j] = ds
						replaced = true
						break
					}
				}
				if !replaced {
					ws.Projects[i].DevServers = append(ws.Projects[i].DevServers, ds)
				}
				break
			}
		}

		if err := Save(ws); err != nil {
			return errMsg{err}
		}
		return devServerSavedMsg{}
	}
}

func (v DevView) removeServer(projName, serverName string) tea.Cmd {
	wsName := v.wsName
	return func() tea.Msg {
		ws, err := Load(wsName)
		if err != nil {
			return errMsg{err}
		}

		for i, p := range ws.Projects {
			if p.Name != projName {
				continue
			}
			filtered := ws.Projects[i].DevServers[:0]
			for _, ds := range ws.Projects[i].DevServers {
				if ds.Name != serverName {
					filtered = append(filtered, ds)
				}
			}
			ws.Projects[i].DevServers = filtered
			break
		}

		if err := Save(ws); err != nil {
			return errMsg{err}
		}
		return devServerRemovedMsg{}
	}
}

func (v DevView) startAllDevServers() tea.Cmd {
	wsName := v.wsName
	return func() tea.Msg {
		if !exec.HasTmux() {
			return errMsg{fmt.Errorf("tmux not found — install with: brew install tmux")}
		}

		ws, err := Load(wsName)
		if err != nil {
			return errMsg{err}
		}

		host := dev.DetectLANIP()
		projects := BuildDevProjects(ws, ws.Projects)

		if len(projects) == 0 {
			return errMsg{fmt.Errorf("no dev servers configured")}
		}

		routes, err := dev.StartWorktree(wsName, projects, "", host)
		if err != nil {
			return errMsg{err}
		}

		status := fmt.Sprintf("Started %d dev servers", len(routes))
		return devStartedMsg{status}
	}
}

func (v DevView) stopAllDevServers() tea.Cmd {
	wsName := v.wsName
	return func() tea.Msg {
		dev.StopAll(wsName)
		return devStoppedMsg{}
	}
}
