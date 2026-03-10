package main

import (
	"fmt"
	"os"
	osexec "os/exec"
	"syscall"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
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

	case "git":
		cmdGit()
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
	p := tea.NewProgram(a, tea.WithAltScreen(), tea.WithMouseCellMotion())
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
		fmt.Fprintf(os.Stderr, "Usage: crew ls [projects|workspaces]\n")
		os.Exit(1)
	}

	switch os.Args[2] {
	case "projects":
		cmdLsProjects()
	case "workspaces":
		cmdLsWorkspaces()
	default:
		fmt.Fprintf(os.Stderr, "Unknown ls target '%s'.\nUsage: crew ls [projects|workspaces]\n", os.Args[2])
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

func cmdGit() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew git <workspace>\n")
		os.Exit(1)
	}

	wsName := os.Args[2]
	if !workspace.Exists(wsName) {
		fmt.Fprintf(os.Stderr, "Error: workspace '%s' not found\n", wsName)
		os.Exit(1)
	}

	if err := workspace.LaunchGitSession(wsName); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
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
