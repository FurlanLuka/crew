package main

import (
	"fmt"
	"os"
	osexec "os/exec"
	"strings"
	"syscall"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/help"
	"github.com/FurlanLuka/crew/crew/internal/notify"
	"github.com/FurlanLuka/crew/crew/internal/plans"
	"github.com/FurlanLuka/crew/crew/internal/profile"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/registry"
	"github.com/FurlanLuka/crew/crew/internal/settings"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

var Version = "dev"

func main() {
	config.Init()
	workspace.Migrate()

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

	case "config":
		runTUI(settings.NewView())

	case "workspace":
		runTUI(workspace.NewView())

	case "project":
		runTUI(project.NewView())

	case "registry":
		cmdRegistry()
		return

	case "profile":
		runTUI(profile.NewView())

	case "notify":
		runTUI(notify.NewView())

	case "plans":
		cmdPlans()

	case "ls":
		cmdLs()
		return

	case "start":
		cmdStart()
		return

	case "dev":
		cmdDev()
		return

	case "debug":
		cmdDebug()
		return

	case "launch":
		cmdLaunch()
		return

	case "stop":
		cmdStop()
		return

	case "rm":
		cmdRm()
		return

	case "code":
		cmdCode()
		return

	case "open":
		cmdOpen()
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
			Description: "Manage workspaces and launch",
			Page:        func() app.Page { return workspace.NewView() },
		},
		{
			Label:       "Project",
			Description: "Add/remove projects and configure dev servers",
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
		{
			Label:       "Plans",
			Description: "Claude plan viewer dashboard",
			Page:        func() app.Page { return plans.NewView() },
		},
		{
			Label:       "Settings",
			Description: "Server IP, SSH host, managed configs",
			Page:        func() app.Page { return settings.NewView() },
		},
		{
			Label:       "Debug",
			Description: "View debug log",
			Page:        func() app.Page { return debug.NewView() },
		},
	})
}

func runTUI(page app.Page) {
	a := app.New(page)
	p := tea.NewProgram(a, tea.WithAltScreen())
	m, err := p.Run()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if final, ok := m.(app.App); ok && final.ExitOutput != "" {
		fmt.Println(final.ExitOutput)
	}
}

func cmdLs() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew ls [projects|workspaces|sessions]\n")
		os.Exit(1)
	}

	switch os.Args[2] {
	case "projects":
		cmdLsProjects()
	case "workspaces":
		cmdLsWorkspaces()
	case "sessions":
		cmdLsSessions()
	default:
		fmt.Fprintf(os.Stderr, "Unknown ls target '%s'.\nUsage: crew ls [projects|workspaces|sessions]\n", os.Args[2])
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
		fmt.Printf("%s\t%d projects\n", s.Name, s.ProjectCount)
	}
}

func cmdOpen() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew open <workspace>\n")
		os.Exit(1)
	}

	wsName := os.Args[2]
	if !workspace.Exists(wsName) {
		fmt.Fprintf(os.Stderr, "Error: workspace '%s' not found\n", wsName)
		os.Exit(1)
	}

	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	shellPath, err := osexec.LookPath(shell)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: shell not found: %v\n", err)
		os.Exit(1)
	}

	dir := workspace.WorkspaceDir(wsName)
	if err := os.Chdir(dir); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	debug.Log("open", "exec %s in %s", shellPath, dir)
	if err := syscall.Exec(shellPath, []string{shell}, os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func cmdCode() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew code <workspace>\n")
		os.Exit(1)
	}

	wsName := os.Args[2]
	if !workspace.Exists(wsName) {
		fmt.Fprintf(os.Stderr, "Error: workspace '%s' not found\n", wsName)
		os.Exit(1)
	}

	settings := config.LoadSettings()
	if settings.SSHHost == "" {
		fmt.Fprintf(os.Stderr, "Error: ssh_host not configured\nSet it in %s:\n  {\"ssh_host\": \"your-host-alias\"}\n", config.SettingsFilePath())
		os.Exit(1)
	}

	ws, err := workspace.Load(wsName)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	var remotePath string
	if len(ws.Projects) == 1 {
		remotePath = workspace.ProjectPath(wsName, ws.Projects[0].Name)
	} else {
		// Generate .code-workspace file for multi-project workspaces
		wsFile := workspace.CodeWorkspaceFilePath(wsName)
		var projects []exec.WorkspaceProject
		for _, wp := range ws.Projects {
			projects = append(projects, exec.WorkspaceProject{
				Name: wp.Name,
				Path: workspace.ProjectPath(wsName, wp.Name),
			})
		}
		if err := exec.GenerateCodeWorkspace(wsFile, projects, "", "", "", false); err != nil {
			fmt.Fprintf(os.Stderr, "Error generating workspace file: %v\n", err)
			os.Exit(1)
		}
		remotePath = wsFile
	}

	for _, ed := range []struct{ name, scheme string }{
		{"cursor", "cursor://"},
		{"vscode", "vscode://"},
	} {
		uri := ed.scheme + "vscode-remote/ssh-remote+" + settings.SSHHost + remotePath
		display := ed.name + " → " + wsName
		// OSC 8 clickable hyperlink
		fmt.Printf("\033]8;;%s\033\\%s\033]8;;\033\\\n", uri, display)
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

	for _, wp := range ws.Projects {
		path := workspace.ProjectPath(wsName, wp.Name)
		fmt.Printf("%s\t%s\t%s\n", wp.Name, path, wp.Role)
	}
}

func cmdStart() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew start <workspace>\n")
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

	prompt, err := workspace.GeneratePrompt(ws)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Print(prompt)
}

func cmdLaunch() {
	if len(os.Args) < 3 {
		runTUI(workspace.NewView())
		return
	}

	wsName := os.Args[2]
	if !workspace.Exists(wsName) {
		fmt.Fprintf(os.Stderr, "Error: workspace '%s' not found\n", wsName)
		os.Exit(1)
	}

	runTUI(workspace.NewLaunchView(wsName))
}

func cmdRegistry() {
	if len(os.Args) < 3 {
		runTUI(registry.NewView())
		return
	}

	switch os.Args[2] {
	case "install":
		cmdRegistryInstall()
	default:
		fmt.Fprintf(os.Stderr, "Unknown registry command '%s'.\nUsage: crew registry [install]\n", os.Args[2])
		os.Exit(1)
	}
}

func cmdRegistryInstall() {
	installAll := false
	var name string

	for _, arg := range os.Args[3:] {
		if arg == "--all" {
			installAll = true
		} else if !strings.HasPrefix(arg, "-") {
			name = arg
		} else {
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'.\nUsage: crew registry install [<name> | --all]\n", arg)
			os.Exit(1)
		}
	}

	if installAll {
		fmt.Println("Installing all agents and skills...")
		fmt.Println()

		installedAgents, failedAgents, agentErr := registry.InstallAllAgents()
		if agentErr != nil {
			fmt.Fprintf(os.Stderr, "Error fetching agents: %v\n", agentErr)
		} else {
			for _, n := range installedAgents {
				fmt.Printf("  Installed agent: %s\n", n)
			}
			for _, n := range failedAgents {
				fmt.Fprintf(os.Stderr, "  Failed agent: %s\n", n)
			}
		}

		installedSkills, failedSkills, skillErr := registry.InstallAllSkills()
		if skillErr != nil {
			fmt.Fprintf(os.Stderr, "Error fetching skills: %v\n", skillErr)
		} else {
			for _, n := range installedSkills {
				fmt.Printf("  Installed skill: %s\n", n)
			}
			for _, n := range failedSkills {
				fmt.Fprintf(os.Stderr, "  Failed skill: %s\n", n)
			}
		}

		total := len(installedAgents) + len(installedSkills)
		if total == 0 && agentErr == nil && skillErr == nil {
			fmt.Println("Everything already installed.")
		} else if total > 0 {
			fmt.Printf("\nInstalled %d items.\n", total)
		}
		return
	}

	if name == "" {
		fmt.Fprintf(os.Stderr, "Usage: crew registry install [<name> | --all]\n")
		os.Exit(1)
	}

	// Try agent first, then skill
	if err := registry.InstallAgent(name); err == nil {
		fmt.Printf("Installed agent: %s\n", name)
		return
	}

	if err := registry.InstallSkill(name); err == nil {
		fmt.Printf("Installed skill: %s\n", name)
		return
	}

	fmt.Fprintf(os.Stderr, "Error: '%s' not found in registry\n", name)
	os.Exit(1)
}

func cmdDev() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev [setup|add|rm|show|start|stop|restart|status]\n")
		os.Exit(1)
	}

	switch os.Args[2] {
	case "setup":
		cmdDevSetup()
	case "add":
		cmdDevAdd()
	case "rm":
		cmdDevRm()
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
	case "tui":
		cmdDevTui()
	case "_proxy":
		cmdDevProxy()
	default:
		fmt.Fprintf(os.Stderr, "Unknown dev command '%s'.\nUsage: crew dev [setup|add|rm|show|start|stop|restart|status|tui]\n", os.Args[2])
		os.Exit(1)
	}
}

func cmdDevSetup() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev setup <project>\n")
		os.Exit(1)
	}

	projName := os.Args[3]
	p := project.Get(projName)
	if p == nil {
		fmt.Fprintf(os.Stderr, "Error: project '%s' not found\n", projName)
		os.Exit(1)
	}

	fmt.Printf("Setting up dev servers for \"%s\" (%s)\n\n", projName, p.Path)

	// Auto-detect from package.json
	detected := detectDevCommand(p.Path)
	if detected != "" {
		fmt.Printf("  Detected: %s\n", detected)
	}

	var count int
	fmt.Print("  How many dev servers? ")
	fmt.Scanln(&count)

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

		ds := project.DevServer{Name: name, Port: port, Command: cmd, Dir: dir}
		if err := project.AddDevServer(projName, ds); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
	}

	fmt.Printf("\nSaved dev server config for %s.\n", projName)
}

func cmdDevAdd() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev add <project> --name=<n> --port=<p> --cmd=<c> [--dir=<d>]\n")
		os.Exit(1)
	}

	projName := os.Args[3]
	var name, cmd, dir string
	var port int

	for _, arg := range os.Args[4:] {
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

	p := project.Get(projName)
	if p == nil {
		fmt.Fprintf(os.Stderr, "Error: project '%s' not found\n", projName)
		os.Exit(1)
	}

	ds := project.DevServer{Name: name, Port: port, Command: cmd, Dir: dir}
	if err := project.AddDevServer(projName, ds); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Added dev server '%s' to %s (port %d)\n", name, projName, port)
}

func cmdDevRm() {
	if len(os.Args) < 5 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev rm <project> <server-name>\n")
		os.Exit(1)
	}

	projName := os.Args[3]
	serverName := os.Args[4]

	p := project.Get(projName)
	if p == nil {
		fmt.Fprintf(os.Stderr, "Error: project '%s' not found\n", projName)
		os.Exit(1)
	}

	if err := project.RemoveDevServer(projName, serverName); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Removed dev server '%s' from %s\n", serverName, projName)
}

func cmdDevShow() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev show <project>\n")
		os.Exit(1)
	}

	projName := os.Args[3]
	p := project.Get(projName)
	if p == nil {
		fmt.Fprintf(os.Stderr, "Error: project '%s' not found\n", projName)
		os.Exit(1)
	}

	for _, ds := range p.DevServers {
		if ds.Dir != "" {
			fmt.Printf("%s\t%d\t%s\t%s\n", ds.Name, ds.Port, ds.Command, ds.Dir)
		} else {
			fmt.Printf("%s\t%d\t%s\n", ds.Name, ds.Port, ds.Command)
		}
	}
}

func cmdDevStatus() {
	wsFilter := ""
	if len(os.Args) > 3 {
		wsFilter = os.Args[3]
	}

	host := dev.ResolveHostIP()

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

	proxyPort := config.LoadSettings().GetProxyPort()

	for _, wr := range allRoutes {
		for _, r := range wr.Routes {
			url := fmt.Sprintf("http://%s.%s.%s.nip.io:%d", r.ServerName, wr.Workspace, host, proxyPort)
			fmt.Printf("%s\t%s\t%d\t%s\n", wr.Workspace, r.ServerName, r.ExternalPort, url)
		}
	}
}

func cmdDevStart() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev start <workspace> [--host=<ip>]\n")
		os.Exit(1)
	}

	wsName := os.Args[3]
	host := ""

	for _, arg := range os.Args[4:] {
		switch {
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
		host = dev.ResolveHostIP()
	}

	ws, err := workspace.Load(wsName)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	proxyPort := config.LoadSettings().GetProxyPort()

	projects := workspace.BuildDevProjects(wsName, ws.Projects)
	if len(projects) == 0 {
		fmt.Fprintf(os.Stderr, "Error: no dev_servers configured — configure via: crew dev setup <project>\n")
		os.Exit(1)
	}

	routes, err := dev.Start(wsName, projects, host, proxyPort)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Dev servers for %s\n\n", wsName)

	for _, r := range routes {
		fmt.Printf("  http://%s.%s.%s.nip.io:%d\n", r.ServerName, wsName, host, proxyPort)
	}

	fmt.Println()
	fmt.Printf("Session: %s\n", dev.SessionName(wsName))
}

func cmdDevStop() {
	wsName := ""

	for _, arg := range os.Args[3:] {
		if wsName == "" {
			wsName = arg
		} else {
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
			os.Exit(1)
		}
	}

	if wsName == "" {
		dev.StopAll("")
		fmt.Println("Stopped all dev sessions.")
		return
	}

	dev.StopAll(wsName)
	dev.StopProxyIfIdle()
	fmt.Printf("Stopped dev session for %s\n", wsName)
}

func cmdDevRestart() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev restart <workspace> [--host=<ip>]\n")
		os.Exit(1)
	}

	wsName := os.Args[3]
	host := ""

	for _, arg := range os.Args[4:] {
		switch {
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

	// Stop existing servers before restarting
	dev.StopAll(wsName)

	if host == "" {
		host = dev.ResolveHostIP()
	}

	proxyPort := config.LoadSettings().GetProxyPort()

	ws, err := workspace.Load(wsName)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	projects := workspace.BuildDevProjects(wsName, ws.Projects)
	if len(projects) == 0 {
		fmt.Fprintf(os.Stderr, "Error: no dev_servers configured — configure via: crew dev setup <project>\n")
		os.Exit(1)
	}

	routes, err := dev.Start(wsName, projects, host, proxyPort)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Restarted dev servers for %s\n\n", wsName)

	for _, r := range routes {
		fmt.Printf("  http://%s.%s.%s.nip.io:%d\n", r.ServerName, wsName, host, proxyPort)
	}

	fmt.Println()
	fmt.Printf("Session: %s\n", dev.SessionName(wsName))
}

func cmdDevTui() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev tui <workspace>\n")
		os.Exit(1)
	}

	wsName := os.Args[3]
	if !workspace.Exists(wsName) {
		fmt.Fprintf(os.Stderr, "Error: workspace '%s' not found\n", wsName)
		os.Exit(1)
	}

	runTUI(workspace.NewDevView(wsName))
}

func cmdDevProxy() {
	host := ""
	port := config.LoadSettings().GetProxyPort()

	for _, arg := range os.Args[3:] {
		switch {
		case strings.HasPrefix(arg, "--host="):
			host = strings.TrimPrefix(arg, "--host=")
		case strings.HasPrefix(arg, "--port="):
			fmt.Sscanf(strings.TrimPrefix(arg, "--port="), "%d", &port)
		}
	}

	if err := dev.RunProxy(host, port); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
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

func cmdDebug() {
	logPath := config.ConfigDir + "/debug.log"

	// Ensure the file exists before tail -f
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY, 0o644)
	if err == nil {
		f.Close()
	}

	tailPath, err := osexec.LookPath("tail")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: tail not found\n")
		os.Exit(1)
	}

	if err := syscall.Exec(tailPath, []string{"tail", "-f", logPath}, os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func cmdPlans() {
	if len(os.Args) < 3 {
		runTUI(plans.NewView())
		return
	}

	switch os.Args[2] {
	case "start":
		cfg := plans.LoadConfig()
		if err := plans.Start(cfg.Port); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Plan viewer started\n  %s\n", plans.URL())
	case "stop":
		plans.Stop()
		fmt.Println("Plan viewer stopped")
	case "_serve":
		cmdPlansServe()
	default:
		fmt.Fprintf(os.Stderr, "Unknown plans command '%s'.\nUsage: crew plans [start|stop]\n", os.Args[2])
		os.Exit(1)
	}
}

func cmdPlansServe() {
	port := 3080
	for _, arg := range os.Args[3:] {
		if strings.HasPrefix(arg, "--port=") {
			fmt.Sscanf(strings.TrimPrefix(arg, "--port="), "%d", &port)
		}
	}
	if err := plans.RunServer(port); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func cmdStop() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew stop <workspace>\n")
		os.Exit(1)
	}

	wsName := os.Args[2]

	if !workspace.Exists(wsName) {
		fmt.Fprintf(os.Stderr, "Error: workspace '%s' not found\n", wsName)
		os.Exit(1)
	}

	workspace.StopSession(wsName)

	// Remove .code-workspace and close editor window
	wsFile := workspace.CodeWorkspaceFilePath(wsName)
	if _, err := os.Stat(wsFile); err == nil {
		editor := exec.DetectEditor()
		exec.CloseEditorWindow(exec.EditorProcessName(editor), wsName)
		os.Remove(wsFile)
	}

	fmt.Printf("Stopped session: %s\n", wsName)
}

func cmdRm() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew rm <workspace>\n")
		os.Exit(1)
	}

	wsName := os.Args[2]

	if !workspace.Exists(wsName) {
		fmt.Fprintf(os.Stderr, "Error: workspace '%s' not found\n", wsName)
		os.Exit(1)
	}

	// Remove .code-workspace and close editor window
	wsFile := workspace.CodeWorkspaceFilePath(wsName)
	if _, err := os.Stat(wsFile); err == nil {
		editor := exec.DetectEditor()
		exec.CloseEditorWindow(exec.EditorProcessName(editor), wsName)
		os.Remove(wsFile)
	}

	// Full cleanup
	if err := workspace.Remove(wsName); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Removed workspace: %s\n", wsName)
}

func cmdLsSessions() {
	infos := workspace.ListSessionInfos()
	for _, s := range infos {
		label := fmt.Sprintf("%d projects", s.ProjectCount)
		if s.ProjectCount == 1 {
			label = "1 project"
		}
		devLabel := "-"
		if s.DevRunning {
			devLabel = "dev"
		}
		age := strings.TrimSuffix(s.Age, " ago")
		fmt.Printf("%s\t%s\t%s\t%s\n", s.Workspace, label, age, devLabel)
	}
}

func cmdKill() {
	killed := false

	// Clean up dev sessions and route files
	dev.StopAll("")

	// Kill tmux sessions
	for _, session := range exec.ListCrewSessions() {
		wsName := session[len("crew-"):]
		// Strip known suffixes to get the workspace name
		for _, suffix := range []string{"-claude", "-servers", "-git"} {
			wsName = strings.TrimSuffix(wsName, suffix)
		}

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
			if !exec.TmuxSessionExists("crew-"+wsName+"-claude") && !exec.TmuxSessionExists("crew-"+wsName) {
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
