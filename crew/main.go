package main

import (
	"fmt"
	"os"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/homebrew-tap/crew/internal/app"
	"github.com/FurlanLuka/homebrew-tap/crew/internal/config"
	"github.com/FurlanLuka/homebrew-tap/crew/internal/dev"
	"github.com/FurlanLuka/homebrew-tap/crew/internal/exec"
	"github.com/FurlanLuka/homebrew-tap/crew/internal/help"
	"github.com/FurlanLuka/homebrew-tap/crew/internal/notify"
	"github.com/FurlanLuka/homebrew-tap/crew/internal/profile"
	"github.com/FurlanLuka/homebrew-tap/crew/internal/project"
	"github.com/FurlanLuka/homebrew-tap/crew/internal/registry"
	"github.com/FurlanLuka/homebrew-tap/crew/internal/workspace"
)

var Version = "dev"

func main() {
	config.Init()

	cmd := ""
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}

	switch cmd {
	case "--version", "-v":
		fmt.Println("crew " + Version)
		return

	case "kill":
		cmdKill()
		return

	case "workspace":
		runTUI(workspace.NewView())

	case "project":
		runTUI(project.NewView())

	case "registry":
		runTUI(registry.NewView())

	case "profile":
		runTUI(profile.NewView())

	case "notify":
		runTUI(notify.NewView())

	case "ls":
		cmdLs()
		return

	case "start":
		cmdStart()
		return

	case "dev":
		cmdDev()
		return

	case "happy":
		cmdHappy()
		return

	case "show":
		cmdShow()
		return

	case "help":
		help.Run(os.Args[2:])
		return

	case "":
		runTUI(mainMenu())

	default:
		// Try as workspace name shortcut (launch directly)
		if workspace.Exists(cmd) {
			runTUI(workspace.NewLaunchView(cmd))
		} else {
			fmt.Fprintf(os.Stderr, "Unknown command '%s'. Run 'crew help' for usage.\n", cmd)
			os.Exit(1)
		}
	}
}

func mainMenu() app.Menu {
	return app.NewMenu([]app.MenuItem{
		{
			Label:       "Workspace",
			Description: "Manage workspaces, worktrees, and launch",
			Page:        func() app.Page { return workspace.NewView() },
		},
		{
			Label:       "Project",
			Description: "Add/remove projects in workspaces",
			Page:        func() app.Page { return project.NewView() },
		},
		{
			Label:       "Registry",
			Description: "Install and manage agents & skills",
			Page:        func() app.Page { return registry.NewView() },
		},
		{
			Label:       "Profile",
			Description: "Manage Claude profile",
			Page:        func() app.Page { return profile.NewView() },
		},
		{
			Label:       "Notifications",
			Description: "Push notification setup",
			Page:        func() app.Page { return notify.NewView() },
		},
	})
}

func runTUI(page app.Page) {
	a := app.New(page)
	p := tea.NewProgram(a, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func cmdLs() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew ls [projects|workspaces|worktrees]\n")
		os.Exit(1)
	}

	switch os.Args[2] {
	case "projects":
		cmdLsProjects()
	case "workspaces":
		cmdLsWorkspaces()
	case "worktrees":
		cmdLsWorktrees()
	default:
		fmt.Fprintf(os.Stderr, "Unknown ls target '%s'.\nUsage: crew ls [projects|workspaces|worktrees]\n", os.Args[2])
		os.Exit(1)
	}
}

func cmdLsProjects() {
	projects, err := project.List()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	for _, p := range projects {
		fmt.Printf("%s\t%s\n", p.Name, p.Path)
	}
}

func cmdLsWorkspaces() {
	summaries, err := workspace.ListSummaries()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	for _, s := range summaries {
		fmt.Printf("%s\t%d projects\t%d worktrees\n", s.Name, s.ProjectCount, s.WorktreeCount)
	}
}

func cmdLsWorktrees() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew ls worktrees <workspace>\n")
		os.Exit(1)
	}

	wsName := os.Args[3]
	if !workspace.Exists(wsName) {
		fmt.Fprintf(os.Stderr, "Error: workspace '%s' not found\n", wsName)
		os.Exit(1)
	}

	wts, err := workspace.ListWorktrees(wsName)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	for _, name := range wts {
		fmt.Println(name)
	}
}

func cmdShow() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew show <workspace>\n")
		os.Exit(1)
	}

	wsName := os.Args[2]

	if !workspace.Exists(wsName) {
		fmt.Fprintf(os.Stderr, "Error: workspace '%s' not found\n", wsName)
		os.Exit(1)
	}

	ws, err := workspace.Load(wsName)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	for _, p := range ws.Projects {
		fmt.Printf("%s\t%s\t%s\n", p.Name, p.Path, p.Role)
	}
}

func cmdStart() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew start <workspace> [--worktree=<name>] [--from=<branch>]\n")
		os.Exit(1)
	}

	wsName := os.Args[2]
	worktreeName := ""
	fromBranch := ""

	for _, arg := range os.Args[3:] {
		switch {
		case strings.HasPrefix(arg, "--worktree="):
			worktreeName = strings.TrimPrefix(arg, "--worktree=")
		case strings.HasPrefix(arg, "--from="):
			fromBranch = strings.TrimPrefix(arg, "--from=")
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'.\nUsage: crew start <workspace> [--worktree=<name>] [--from=<branch>]\n", arg)
			os.Exit(1)
		}
	}

	if !workspace.Exists(wsName) {
		fmt.Fprintf(os.Stderr, "Error: workspace '%s' not found\n", wsName)
		os.Exit(1)
	}

	loadName := wsName
	if worktreeName != "" {
		safeName, err := workspace.CreateWorktree(wsName, worktreeName, fromBranch)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		loadName = workspace.WorktreeWorkspaceName(wsName, safeName)
	}

	ws, err := workspace.Load(loadName)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	prompt, err := workspace.GeneratePrompt(ws)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Print(prompt)
}

func cmdHappy() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew happy <workspace> [--worktree=<name>] [--from=<branch>]\n")
		os.Exit(1)
	}

	wsName := os.Args[2]
	worktreeName := ""
	fromBranch := ""

	for _, arg := range os.Args[3:] {
		switch {
		case strings.HasPrefix(arg, "--worktree="):
			worktreeName = strings.TrimPrefix(arg, "--worktree=")
		case strings.HasPrefix(arg, "--from="):
			fromBranch = strings.TrimPrefix(arg, "--from=")
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'.\nUsage: crew happy <workspace> [--worktree=<name>] [--from=<branch>]\n", arg)
			os.Exit(1)
		}
	}

	if !workspace.Exists(wsName) {
		fmt.Fprintf(os.Stderr, "Error: workspace '%s' not found\n", wsName)
		os.Exit(1)
	}

	if !exec.HasHappy() {
		fmt.Fprintf(os.Stderr, "Error: happy CLI not found — install from https://happycoder.ai\n")
		os.Exit(1)
	}

	if !exec.HasTmux() {
		fmt.Fprintf(os.Stderr, "Error: tmux not found — install with: brew install tmux\n")
		os.Exit(1)
	}

	loadName := wsName
	if worktreeName != "" {
		safeName, err := workspace.CreateWorktree(wsName, worktreeName, fromBranch)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		loadName = workspace.WorktreeWorkspaceName(wsName, safeName)
	}

	ws, err := workspace.Load(loadName)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	session := "crew-" + ws.Name

	if !exec.TmuxSessionExists(session) {
		leadPath := ws.Projects[0].Path
		if err := exec.CreateTmuxSession(session, leadPath); err != nil {
			fmt.Fprintf(os.Stderr, "Error creating tmux session: %v\n", err)
			os.Exit(1)
		}

		happyCmd := "happy"
		for _, p := range ws.Projects[1:] {
			happyCmd += fmt.Sprintf(" --add-dir %s", p.Path)
		}
		exec.TmuxSendKeys(session, happyCmd)
	}

	fmt.Printf("Started: %s\nVisible in Happy mobile app.\n", session)
}

func cmdDev() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev [setup|add|show|start|stop|restart|status]\n")
		os.Exit(1)
	}

	switch os.Args[2] {
	case "setup":
		cmdDevSetup()
	case "add":
		cmdDevAdd()
	case "show":
		cmdDevShow()
	case "start":
		cmdDevStart()
	case "stop":
		cmdDevStop()
	case "restart":
		cmdDevRestart()
	case "status":
		cmdDevStatus()
	case "_proxy":
		cmdDevProxy()
	default:
		fmt.Fprintf(os.Stderr, "Unknown dev command '%s'.\nUsage: crew dev [setup|add|show|start|stop|restart|status]\n", os.Args[2])
		os.Exit(1)
	}
}

func cmdDevSetup() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev setup <workspace>\n")
		os.Exit(1)
	}

	wsName := os.Args[3]
	ws, err := workspace.Load(wsName)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	if len(ws.Projects) == 0 {
		fmt.Fprintf(os.Stderr, "Error: workspace '%s' has no projects\n", wsName)
		os.Exit(1)
	}

	fmt.Printf("Setting up dev servers for \"%s\"\n\n", wsName)

	for i, p := range ws.Projects {
		fmt.Printf("Project: %s (%s)\n", p.Name, p.Path)

		// Auto-detect from package.json
		detected := detectDevCommand(p.Path)
		if detected != "" {
			fmt.Printf("  Detected: %s\n", detected)
		}

		var count int
		fmt.Print("  How many dev servers? ")
		fmt.Scanln(&count)

		var servers []workspace.DevServer
		for j := 0; j < count; j++ {
			fmt.Printf("\n  Server %d:\n", j+1)

			var name, cmd, dir string
			var port int

			fmt.Print("    Name: ")
			fmt.Scanln(&name)

			fmt.Print("    Port: ")
			fmt.Scanln(&port)

			defaultCmd := detected
			if defaultCmd != "" {
				fmt.Printf("    Command [%s]: ", defaultCmd)
			} else {
				fmt.Print("    Command: ")
			}
			fmt.Scanln(&cmd)
			if cmd == "" {
				cmd = defaultCmd
			}

			fmt.Print("    Directory (relative, empty for root): ")
			fmt.Scanln(&dir)

			servers = append(servers, workspace.DevServer{
				Name:    name,
				Port:    port,
				Command: cmd,
				Dir:     dir,
			})
		}

		ws.Projects[i].DevServers = servers
		fmt.Println()
	}

	if err := workspace.Save(ws); err != nil {
		fmt.Fprintf(os.Stderr, "Error saving workspace: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Saved dev server config to %s.\n", wsName)
}

func cmdDevAdd() {
	if len(os.Args) < 5 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev add <workspace> <project> --name=<n> --port=<p> --cmd=<c> [--dir=<d>]\n")
		os.Exit(1)
	}

	wsName := os.Args[3]
	projName := os.Args[4]
	var name, cmd, dir string
	var port int

	for _, arg := range os.Args[5:] {
		switch {
		case strings.HasPrefix(arg, "--name="):
			name = strings.TrimPrefix(arg, "--name=")
		case strings.HasPrefix(arg, "--port="):
			fmt.Sscanf(strings.TrimPrefix(arg, "--port="), "%d", &port)
		case strings.HasPrefix(arg, "--cmd="):
			cmd = strings.TrimPrefix(arg, "--cmd=")
		case strings.HasPrefix(arg, "--dir="):
			dir = strings.TrimPrefix(arg, "--dir=")
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
			os.Exit(1)
		}
	}

	if name == "" || port == 0 || cmd == "" {
		fmt.Fprintf(os.Stderr, "Error: --name, --port, and --cmd are required\n")
		os.Exit(1)
	}

	ws, err := workspace.Load(wsName)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	found := false
	for i, p := range ws.Projects {
		if p.Name != projName {
			continue
		}
		found = true

		ds := workspace.DevServer{Name: name, Port: port, Command: cmd, Dir: dir}

		// Replace existing or append
		replaced := false
		for j, existing := range ws.Projects[i].DevServers {
			if existing.Name == name {
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

	if !found {
		fmt.Fprintf(os.Stderr, "Error: project '%s' not found in workspace '%s'\n", projName, wsName)
		os.Exit(1)
	}

	if err := workspace.Save(ws); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Added dev server '%s' to %s/%s (port %d)\n", name, wsName, projName, port)
}

func cmdDevShow() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev show <workspace>\n")
		os.Exit(1)
	}

	wsName := os.Args[3]
	if !workspace.Exists(wsName) {
		fmt.Fprintf(os.Stderr, "Error: workspace '%s' not found\n", wsName)
		os.Exit(1)
	}

	ws, err := workspace.Load(wsName)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	for _, p := range ws.Projects {
		for _, ds := range p.DevServers {
			if ds.Dir != "" {
				fmt.Printf("%s\t%s\t%d\t%s\t%s\n", p.Name, ds.Name, ds.Port, ds.Command, ds.Dir)
			} else {
				fmt.Printf("%s\t%s\t%d\t%s\n", p.Name, ds.Name, ds.Port, ds.Command)
			}
		}
	}
}

func cmdDevStatus() {
	wsFilter := ""
	if len(os.Args) > 3 {
		wsFilter = os.Args[3]
	}

	host := dev.DetectLANIP()

	var allRoutes []dev.WsRoutes
	var err error

	if wsFilter != "" {
		routes, loadErr := dev.LoadRoutes(wsFilter)
		if loadErr != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", loadErr)
			os.Exit(1)
		}
		if len(routes) > 0 {
			allRoutes = []dev.WsRoutes{{Workspace: wsFilter, Routes: routes}}
		}
	} else {
		allRoutes, err = dev.ListAllRoutes()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
	}

	for _, wr := range allRoutes {
		for _, r := range wr.Routes {
			url := fmt.Sprintf("http://%s.%s.nip.io:%d", r.Subdomain, host, r.ExternalPort)
			fmt.Printf("%s\t%s\t%d\t%s\n", wr.Workspace, r.Subdomain, r.ExternalPort, url)
		}
	}
}

func cmdDevStart() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev start <workspace> [--worktree=<name>] [--host=<ip>]\n")
		os.Exit(1)
	}

	wsName := os.Args[3]
	worktreeName := ""
	host := ""

	for _, arg := range os.Args[4:] {
		switch {
		case strings.HasPrefix(arg, "--worktree="):
			worktreeName = strings.TrimPrefix(arg, "--worktree=")
		case strings.HasPrefix(arg, "--host="):
			host = strings.TrimPrefix(arg, "--host=")
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
			os.Exit(1)
		}
	}

	if !workspace.Exists(wsName) {
		fmt.Fprintf(os.Stderr, "Error: workspace '%s' not found\n", wsName)
		os.Exit(1)
	}

	if !exec.HasTmux() {
		fmt.Fprintf(os.Stderr, "Error: tmux not found — install with: brew install tmux\n")
		os.Exit(1)
	}

	if host == "" {
		host = dev.DetectLANIP()
	}

	// Load base workspace for dev server config
	baseWs, err := workspace.Load(wsName)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	// Resolve project paths (worktree paths if applicable)
	var srcProjects []workspace.Project
	if worktreeName != "" {
		safeName := workspace.NormalizeName(worktreeName)
		wtWsName := workspace.WorktreeWorkspaceName(wsName, safeName)
		wtWs, err := workspace.Load(wtWsName)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: worktree '%s' not found — create it first: crew start %s --worktree=%s\n", worktreeName, wsName, worktreeName)
			os.Exit(1)
		}
		srcProjects = wtWs.Projects
	} else {
		srcProjects = baseWs.Projects
	}

	// Build DevProject slice
	projects := buildDevProjects(baseWs, srcProjects)
	if len(projects) == 0 {
		fmt.Fprintf(os.Stderr, "Error: no dev_servers configured — run: crew dev setup %s\n", wsName)
		os.Exit(1)
	}

	routes, err := dev.StartWorktree(wsName, projects, worktreeName, host)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Dev servers for %s", wsName)
	if worktreeName != "" {
		fmt.Printf(" (worktree: %s)", worktreeName)
	}
	fmt.Println()
	fmt.Println()

	for _, r := range routes {
		fmt.Printf("  http://%s.%s.nip.io:%d\n", r.Subdomain, host, r.ExternalPort)
	}

	fmt.Println()
	fmt.Printf("Session: %s\n", dev.SessionName(wsName))
}

func cmdDevStop() {
	wsName := ""
	worktreeName := ""

	for _, arg := range os.Args[3:] {
		switch {
		case strings.HasPrefix(arg, "--worktree="):
			worktreeName = strings.TrimPrefix(arg, "--worktree=")
		default:
			if wsName == "" {
				wsName = arg
			} else {
				fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
				os.Exit(1)
			}
		}
	}

	if wsName == "" {
		// Kill all dev sessions
		dev.StopAll("")
		fmt.Println("Stopped all dev sessions.")
		return
	}

	if worktreeName != "" {
		if err := dev.StopWorktree(wsName, worktreeName); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Stopped dev servers for worktree '%s'\n", worktreeName)
		return
	}

	dev.StopAll(wsName)
	fmt.Printf("Stopped dev session for %s\n", wsName)
}

func cmdDevRestart() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev restart <workspace> [--worktree=<name>] [--host=<ip>]\n")
		os.Exit(1)
	}

	wsName := os.Args[3]
	worktreeName := ""
	host := ""

	for _, arg := range os.Args[4:] {
		switch {
		case strings.HasPrefix(arg, "--worktree="):
			worktreeName = strings.TrimPrefix(arg, "--worktree=")
		case strings.HasPrefix(arg, "--host="):
			host = strings.TrimPrefix(arg, "--host=")
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
			os.Exit(1)
		}
	}

	if !workspace.Exists(wsName) {
		fmt.Fprintf(os.Stderr, "Error: workspace '%s' not found\n", wsName)
		os.Exit(1)
	}

	if !exec.HasTmux() {
		fmt.Fprintf(os.Stderr, "Error: tmux not found — install with: brew install tmux\n")
		os.Exit(1)
	}

	// Stop
	subdomain := worktreeName
	if subdomain == "" {
		subdomain = "main"
	}
	dev.StopWorktree(wsName, subdomain)

	// Start
	if host == "" {
		host = dev.DetectLANIP()
	}

	baseWs, err := workspace.Load(wsName)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	var srcProjects []workspace.Project
	if worktreeName != "" {
		safeName := workspace.NormalizeName(worktreeName)
		wtWsName := workspace.WorktreeWorkspaceName(wsName, safeName)
		wtWs, err := workspace.Load(wtWsName)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: worktree '%s' not found\n", worktreeName)
			os.Exit(1)
		}
		srcProjects = wtWs.Projects
	} else {
		srcProjects = baseWs.Projects
	}

	projects := buildDevProjects(baseWs, srcProjects)
	if len(projects) == 0 {
		fmt.Fprintf(os.Stderr, "Error: no dev_servers configured — run: crew dev setup %s\n", wsName)
		os.Exit(1)
	}

	routes, err := dev.StartWorktree(wsName, projects, worktreeName, host)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Restarted dev servers for %s", wsName)
	if worktreeName != "" {
		fmt.Printf(" (worktree: %s)", worktreeName)
	}
	fmt.Println()
	fmt.Println()

	for _, r := range routes {
		fmt.Printf("  http://%s.%s.nip.io:%d\n", r.Subdomain, host, r.ExternalPort)
	}

	fmt.Println()
	fmt.Printf("Session: %s\n", dev.SessionName(wsName))
}

func cmdDevProxy() {
	wsName := ""
	host := ""

	for _, arg := range os.Args[3:] {
		switch {
		case strings.HasPrefix(arg, "--ws="):
			wsName = strings.TrimPrefix(arg, "--ws=")
		case strings.HasPrefix(arg, "--host="):
			host = strings.TrimPrefix(arg, "--host=")
		}
	}

	if wsName == "" {
		fmt.Fprintf(os.Stderr, "Usage: crew dev _proxy --ws=<name> [--host=<ip>]\n")
		os.Exit(1)
	}

	if err := dev.RunProxy(wsName, host); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func buildDevProjects(baseWs *workspace.Workspace, srcProjects []workspace.Project) []dev.DevProject {
	var projects []dev.DevProject
	for _, sp := range srcProjects {
		// Find dev servers from base workspace (config lives on base)
		var servers []dev.DevServerConfig
		for _, bp := range baseWs.Projects {
			if bp.Name == sp.Name {
				for _, ds := range bp.DevServers {
					servers = append(servers, dev.DevServerConfig{
						Name:    ds.Name,
						Port:    ds.Port,
						Command: ds.Command,
						Dir:     ds.Dir,
					})
				}
				break
			}
		}
		if len(servers) > 0 {
			projects = append(projects, dev.DevProject{
				Path:       sp.Path,
				DevServers: servers,
			})
		}
	}
	return projects
}

func detectDevCommand(projectPath string) string {
	data, err := os.ReadFile(projectPath + "/package.json")
	if err != nil {
		return ""
	}
	content := string(data)
	if strings.Contains(content, `"dev"`) {
		return "npm run dev"
	}
	if strings.Contains(content, `"start"`) {
		return "npm start"
	}
	return ""
}

func cmdKill() {
	killed := false

	// Clean up dev sessions and route files
	dev.StopAll("")

	// Kill tmux sessions
	for _, session := range exec.ListCrewSessions() {
		wsName := session[len("crew-"):]
		exec.KillTmuxSession(session)
		fmt.Printf("Killed session: %s\n", session)

		// Clean up prompt + workspace files
		os.Remove(workspace.PromptFilePath(wsName))

		wsFile := workspace.CodeWorkspaceFilePath(wsName)
		if _, err := os.Stat(wsFile); err == nil {
			editor := exec.DetectEditor()
			exec.CloseEditorWindow(exec.EditorProcessName(editor), wsName)
			os.Remove(wsFile)
		}

		killed = true
	}

	// Clean up orphaned .code-workspace files
	entries, _ := os.ReadDir(config.ConfigDir)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if len(name) > len(".code-workspace") && name[len(name)-len(".code-workspace"):] == ".code-workspace" {
			wsName := name[:len(name)-len(".code-workspace")]
			session := "crew-" + wsName
			if !exec.TmuxSessionExists(session) {
				wsFile := workspace.CodeWorkspaceFilePath(wsName)
				editor := exec.DetectEditor()
				exec.CloseEditorWindow(exec.EditorProcessName(editor), wsName)
				os.Remove(wsFile)
				os.Remove(workspace.PromptFilePath(wsName))
				killed = true
			}
		}
	}

	if !killed {
		fmt.Println("No crew sessions running.")
	}
}
