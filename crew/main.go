package main

import (
	"fmt"
	"os"
	osexec "os/exec"
	"path/filepath"
	"runtime"
	"strings"
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

	// Check for updates in background (skip for dev builds and update command)
	var updateCh chan string
	if Version != "dev" && cmd != "update" {
		updateCh = make(chan string, 1)
		go func() {
			latest, err := fetchLatestVersion()
			if err != nil || latest == Version {
				updateCh <- ""
				return
			}
			updateCh <- latest
		}()
	}
	defer func() {
		if updateCh == nil {
			return
		}
		select {
		case latest := <-updateCh:
			if latest != "" {
				fmt.Fprintf(os.Stderr, "\nUpdate available: v%s → v%s (run 'crew update')\n", Version, latest)
			}
		default:
		}
	}()

	switch cmd {
	case "--version", "-v":
		fmt.Println("crew " + Version)
		return

	case "config":
		if len(os.Args) > 2 {
			cmdConfig()
			return
		}
		runTUI(settings.NewView())

	case "workspace":
		runTUI(workspace.NewView())

	case "project":
		runTUI(project.NewView())

	case "registry":
		cmdRegistry()
		return

	case "add":
		cmdAdd()
		return

	case "profile":
		if len(os.Args) > 2 {
			cmdProfile()
			return
		}
		runTUI(profile.NewView())

	case "notify":
		if len(os.Args) > 2 {
			cmdNotify()
			return
		}
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

	case "update":
		cmdUpdate()
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
		if err := exec.GenerateCodeWorkspace(wsFile, projects, nil); err != nil {
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
		fmt.Fprintf(os.Stderr, "Usage: crew rm <workspace> | crew rm project <name> | crew rm workspace <ws> <project>\n")
		os.Exit(1)
	}

	switch os.Args[2] {
	case "project":
		cmdRmProject()
		return
	case "workspace":
		cmdRmWorkspaceProject()
		return
	}

	// Default: remove entire workspace
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

func cmdRmProject() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew rm project <name>\n")
		os.Exit(1)
	}
	name := os.Args[3]
	if err := project.Remove(name); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Removed project: %s\n", name)
}

func cmdRmWorkspaceProject() {
	if len(os.Args) < 5 {
		fmt.Fprintf(os.Stderr, "Usage: crew rm workspace <workspace> <project>\n")
		os.Exit(1)
	}
	wsName := os.Args[3]
	projName := os.Args[4]
	if err := workspace.RemoveProject(wsName, projName); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Removed %s from %s\n", projName, wsName)
}

func cmdAdd() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew add project <name> <path> | crew add workspace <name> [<project> --role=<role>]\n")
		os.Exit(1)
	}

	switch os.Args[2] {
	case "project":
		cmdAddProject()
	case "workspace":
		cmdAddWorkspace()
	default:
		fmt.Fprintf(os.Stderr, "Unknown add target '%s'.\nUsage: crew add [project|workspace]\n", os.Args[2])
		os.Exit(1)
	}
}

func cmdAddProject() {
	if len(os.Args) < 5 {
		fmt.Fprintf(os.Stderr, "Usage: crew add project <name> <path>\n")
		os.Exit(1)
	}
	name := os.Args[3]
	path := os.Args[4]
	if err := project.Add(project.Project{Name: name, Path: path}); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Added project: %s (%s)\n", name, path)
}

func cmdAddWorkspace() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew add workspace <name> [<project> --role=<role>]\n")
		os.Exit(1)
	}
	wsName := os.Args[3]

	// If only name given, create workspace
	if len(os.Args) == 4 {
		if err := workspace.Create(wsName); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Created workspace: %s\n", wsName)
		return
	}

	// With project arg, add project to workspace
	projName := os.Args[4]
	role := ""
	for _, arg := range os.Args[5:] {
		if strings.HasPrefix(arg, "--role=") {
			role = strings.TrimPrefix(arg, "--role=")
		} else {
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
			os.Exit(1)
		}
	}

	if err := workspace.AddProject(wsName, projName, role); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Added %s to %s\n", projName, wsName)
}

func cmdConfig() {
	switch os.Args[2] {
	case "show":
		s := config.LoadSettings()
		fmt.Printf("server_ip\t%s\n", s.ServerIP)
		fmt.Printf("ssh_host\t%s\n", s.SSHHost)
		fmt.Printf("proxy_port\t%d\n", s.ProxyPort)
		fmt.Printf("domain\t%s\n", s.Domain)
	case "set":
		if len(os.Args) < 5 {
			fmt.Fprintf(os.Stderr, "Usage: crew config set <key> <value>\n")
			os.Exit(1)
		}
		key := os.Args[3]
		value := os.Args[4]
		s := config.LoadSettings()
		switch key {
		case "server_ip":
			s.ServerIP = value
		case "ssh_host":
			s.SSHHost = value
		case "proxy_port":
			var port int
			if n, _ := fmt.Sscanf(value, "%d", &port); n != 1 {
				fmt.Fprintf(os.Stderr, "Error: invalid port value\n")
				os.Exit(1)
			}
			s.ProxyPort = port
		case "domain":
			s.Domain = value
		default:
			fmt.Fprintf(os.Stderr, "Unknown key '%s'. Valid keys: server_ip, ssh_host, proxy_port, domain\n", key)
			os.Exit(1)
		}
		if err := config.SaveSettings(s); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Set %s = %s\n", key, value)
	default:
		fmt.Fprintf(os.Stderr, "Unknown config command '%s'.\nUsage: crew config [show|set]\n", os.Args[2])
		os.Exit(1)
	}
}

func cmdProfile() {
	switch os.Args[2] {
	case "install":
		if err := profile.Install(); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("Installed profile")
	case "update":
		changed, err := profile.Update()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		if changed {
			fmt.Println("Updated")
		} else {
			fmt.Println("Already up to date")
		}
	case "rm":
		if err := profile.Remove(); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("Removed profile")
	case "status":
		if profile.IsInstalled() {
			fmt.Println("installed")
		} else {
			fmt.Println("not installed")
		}
	default:
		fmt.Fprintf(os.Stderr, "Unknown profile command '%s'.\nUsage: crew profile [install|update|rm|status]\n", os.Args[2])
		os.Exit(1)
	}
}

func cmdNotify() {
	switch os.Args[2] {
	case "setup":
		topic := ""
		if len(os.Args) > 3 {
			topic = os.Args[3]
		}
		if topic == "" {
			topic = notify.GenerateTopic()
		}
		if err := notify.Setup(topic); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Notifications enabled (topic: %s)\n", topic)
	case "test":
		topic := notify.ExtractTopic()
		if topic == "" {
			fmt.Fprintf(os.Stderr, "Error: notifications not set up. Run 'crew notify setup' first.\n")
			os.Exit(1)
		}
		if err := notify.TestNotification(topic); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("Test notification sent")
	case "rm":
		if err := notify.RemoveHook(); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("Notifications disabled")
	default:
		fmt.Fprintf(os.Stderr, "Unknown notify command '%s'.\nUsage: crew notify [setup|test|rm]\n", os.Args[2])
		os.Exit(1)
	}
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

func cmdUpdate() {
	selfPath, err := osexec.LookPath("crew")
	if err != nil {
		selfPath, err = os.Executable()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: cannot determine crew binary path\n")
			os.Exit(1)
		}
	}

	latest, err := fetchLatestVersion()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error fetching latest version: %v\n", err)
		os.Exit(1)
	}

	current := Version
	if current == latest {
		fmt.Printf("crew is already up to date (v%s)\n", current)
		return
	}

	fmt.Printf("Updating crew v%s → v%s\n", current, latest)

	osName := strings.ToLower(runtime.GOOS)
	arch := runtime.GOARCH

	url := fmt.Sprintf("https://github.com/%s/releases/download/v%s/crew_%s_%s_%s.tar.gz",
		config.RegistryRepo, latest, latest, osName, arch)

	tmpDir, err := os.MkdirTemp("", "crew-update-*")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating temp dir: %v\n", err)
		os.Exit(1)
	}
	defer os.RemoveAll(tmpDir)

	tarPath := filepath.Join(tmpDir, "crew.tar.gz")
	dlCmd := osexec.Command("curl", "-fsSL", "-o", tarPath, url)
	dlCmd.Stderr = os.Stderr
	if err := dlCmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error downloading release: %v\n", err)
		os.Exit(1)
	}

	extractCmd := osexec.Command("tar", "-xzf", tarPath, "-C", tmpDir)
	if err := extractCmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error extracting release: %v\n", err)
		os.Exit(1)
	}

	newBin := filepath.Join(tmpDir, "crew")
	if err := os.Rename(newBin, selfPath); err != nil {
		// rename may fail across filesystems; fall back to copy
		if err := copyFile(newBin, selfPath); err != nil {
			fmt.Fprintf(os.Stderr, "Error replacing binary: %v\n", err)
			os.Exit(1)
		}
	}
	os.Chmod(selfPath, 0o755)

	fmt.Printf("crew updated to v%s\n", latest)
}

func fetchLatestVersion() (string, error) {
	cmd := osexec.Command("gh", "api", "repos/"+config.RegistryRepo+"/releases/latest", "--jq", ".tag_name")
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("gh api failed: %w (is gh installed and authenticated?)", err)
	}
	tag := strings.TrimSpace(string(out))
	return strings.TrimPrefix(tag, "v"), nil
}

func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0o755)
}
