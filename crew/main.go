package main

import (
	"encoding/json"
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

// jsonOutput is set once at startup from the global --json flag and read by
// list/show commands to emit JSON instead of tab-separated output.
var jsonOutput bool

// extractFlag returns args with all occurrences of flag removed, plus whether
// it was present.
// extractFlag pulls a global flag out of argv wherever it appears.
//
// It stops at "--": everything after that belongs to a child process (see
// `crew run`), so `crew run ws/wt proj -- node --json` has to leave the child's
// flag alone rather than eating it and switching crew to JSON output.
func extractFlag(args []string, flag string) ([]string, bool) {
	out := make([]string, 0, len(args))
	found := false
	for i, a := range args {
		if a == "--" {
			out = append(out, args[i:]...)
			break
		}
		if a == flag {
			found = true
			continue
		}
		out = append(out, a)
	}
	return out, found
}

func printJSON(v any) {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(string(data))
}

func main() {
	config.Init()
	project.Previewer = workspace.PreviewBinding
	project.CheckoutDirs = workspace.ProjectCheckouts

	// Strip the global --json flag before computing cmd so it works in any
	// position and is not rejected by strict per-command arg parsers.
	os.Args, jsonOutput = extractFlag(os.Args, "--json")

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

	case "ps":
		cmdPs()
		return

	case "kill":
		cmdKill()
		return

	case "start":
		cmdStart()
		return

	case "env":
		cmdEnv()
		return

	case "run":
		cmdRun()
		return

	case "migrate":
		cmdMigrate()
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

	case "duplicate":
		cmdDuplicate()
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
		// Try as workspace/worktree ref shortcut (launch directly)
		if ref, err := workspace.ParseRef(cmd); err == nil && workspace.Exists(ref.Workspace) {
			runTUI(workspace.NewWorktreeView(mustResolve(ref.String()).Ref))
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

// mustResolve turns a "<workspace>[/<worktree>]" argument into a resolved
// worktree, or exits with the parse/lookup error. Every command taking a
// workspace argument goes through here so the "which worktree did you mean"
// message is written once.
func mustResolve(arg string) *workspace.Resolved {
	ref, err := workspace.ParseRef(arg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	res, err := workspace.Resolve(ref)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	return res
}

func cmdLs() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew ls [projects|workspaces|worktrees|bindings|overrides]\n")
		os.Exit(1)
	}

	switch os.Args[2] {
	case "projects":
		cmdLsProjects()
	case "workspaces":
		cmdLsWorkspaces()
	case "worktrees":
		cmdLsWorktrees()
	case "bindings":
		cmdLsBindings()
	case "overrides":
		cmdLsOverrides()
	default:
		fmt.Fprintf(os.Stderr, "Unknown ls target '%s'.\nUsage: crew ls [projects|workspaces|worktrees|bindings|overrides]\n", os.Args[2])
		os.Exit(1)
	}
}

func cmdLsProjects() {
	projects, err := project.List()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if jsonOutput {
		if projects == nil {
			projects = []project.Project{}
		}
		printJSON(projects)
		return
	}
	for _, p := range projects {
		fmt.Printf("%s\t%s\n", p.Name, p.Path)
	}
}

func cmdLsWorkspaces() {
	names, err := workspace.List()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	type workspaceOut struct {
		Name         string   `json:"name"`
		ProjectCount int      `json:"project_count"`
		Worktrees    []string `json:"worktrees"`
		DevRunning   bool     `json:"dev_running"`
	}

	out := []workspaceOut{}
	for _, name := range names {
		ws, err := workspace.Load(name)
		if err != nil {
			continue
		}
		row := workspaceOut{Name: name, ProjectCount: len(ws.Projects), Worktrees: []string{}}
		for _, ref := range workspace.Refs(ws) {
			row.Worktrees = append(row.Worktrees, ref.Worktree)
			if dev.Running(ref.Slug()) {
				row.DevRunning = true
			}
		}
		out = append(out, row)
	}

	if jsonOutput {
		printJSON(out)
		return
	}
	for _, w := range out {
		fmt.Printf("%s\t%d projects\t%s\n", w.Name, w.ProjectCount, strings.Join(w.Worktrees, ","))
	}
}

func cmdOpen() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew open <workspace>\n")
		os.Exit(1)
	}

	res := mustResolve(os.Args[2])

	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	shellPath, err := osexec.LookPath(shell)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: shell not found: %v\n", err)
		os.Exit(1)
	}

	dir := res.Dir
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
		fmt.Fprintf(os.Stderr, "Usage: crew code <workspace>[/<worktree>]\n")
		os.Exit(1)
	}

	wsName := os.Args[2]

	settings := config.LoadSettings()
	if settings.SSHHost == "" {
		fmt.Fprintf(os.Stderr, "Error: ssh_host not configured\nSet it in %s:\n  {\"ssh_host\": \"your-host-alias\"}\n", config.SettingsFilePath())
		os.Exit(1)
	}

	links, err := workspace.EditorLinks(mustResolve(wsName), settings.SSHHost)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Print(links)
}

func cmdShow() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew show <workspace>\n")
		os.Exit(1)
	}

	wsName := os.Args[2]

	res := mustResolve(wsName)

	type wsProjectOut struct {
		Name string `json:"name"`
		Path string `json:"path"`
		Mode string `json:"mode"`
		Role string `json:"role"`
	}

	out := []wsProjectOut{}
	for _, p := range res.Projects {
		mode := "worktree"
		if p.Direct {
			mode = "direct"
		}
		out = append(out, wsProjectOut{Name: p.Name, Path: p.Path, Mode: mode, Role: p.Role})
	}

	if jsonOutput {
		printJSON(out)
		return
	}
	for _, p := range out {
		fmt.Printf("%s\t%s\t%s\t%s\n", p.Name, p.Path, p.Mode, p.Role)
	}
}

func cmdStart() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew start <workspace>\n")
		os.Exit(1)
	}

	wsName := os.Args[2]

	prompt, err := workspace.GeneratePrompt(mustResolve(wsName))
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

	runTUI(workspace.NewWorktreeView(mustResolve(os.Args[2]).Ref))
}

// cmdDuplicate copies a worktree within its workspace. This is what
// duplicating a workspace was actually being used for — a second working copy
// of the same projects — and a worktree is now the thing that is.
func cmdDuplicate() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew duplicate <workspace>[/<worktree>] <new-worktree>\n")
		os.Exit(1)
	}

	src := mustResolve(os.Args[2]).Ref
	newName := os.Args[3]

	if err := workspace.DuplicateWorktree(src, newName); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	dst := workspace.Ref{Workspace: src.Workspace, Worktree: newName}
	fmt.Printf("Duplicated %s → %s\n", src, dst)
	fmt.Printf("crew dev start %s\n", dst)
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
	case "worktree":
		cmdRmWorktree()
		return
	case "binding":
		cmdRmBinding()
		return
	case "override":
		cmdRmOverride()
		return
	}

	// Default: remove entire workspace
	wsName := os.Args[2]

	if !workspace.Exists(wsName) {
		fmt.Fprintf(os.Stderr, "Error: workspace '%s' not found\n", wsName)
		os.Exit(1)
	}

	if ws, err := workspace.Load(wsName); err == nil {
		editor := exec.DetectEditor()
		for _, ref := range workspace.Refs(ws) {
			if _, err := os.Stat(workspace.CodeWorkspaceFilePath(ref)); err == nil {
				exec.CloseEditorWindow(exec.EditorProcessName(editor), string(ref.Slug()))
			}
		}
	}

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
		fmt.Fprintf(os.Stderr, "Usage: crew add [project|workspace|worktree|binding] ...\n")
		os.Exit(1)
	}

	switch os.Args[2] {
	case "project":
		cmdAddProject()
	case "workspace":
		cmdAddWorkspace()
	case "worktree":
		cmdAddWorktree()
	case "binding":
		cmdAddBinding()
	case "override":
		cmdAddOverride()
	default:
		fmt.Fprintf(os.Stderr, "Unknown add target '%s'.\nUsage: crew add [project|workspace|worktree|binding|override]\n", os.Args[2])
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

	if len(os.Args) == 4 {
		if err := workspace.Create(wsName); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Created workspace: %s\n", wsName)
		return
	}

	projName := os.Args[4]
	role := ""
	mode := workspace.ModeWorktree
	for _, arg := range os.Args[5:] {
		switch {
		case strings.HasPrefix(arg, "--role="):
			role = strings.TrimPrefix(arg, "--role=")
		case arg == "--direct":
			mode = workspace.ModeDirect
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
			os.Exit(1)
		}
	}

	if err := workspace.AddProject(wsName, projName, role, mode); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if mode == workspace.ModeDirect {
		fmt.Printf("Added %s to %s (direct mode — no worktree, points at canonical repo)\n", projName, wsName)
	} else {
		fmt.Printf("Added %s to %s\n", projName, wsName)
	}
}

func cmdConfig() {
	switch os.Args[2] {
	case "show":
		s := config.LoadSettings()
		if jsonOutput {
			printJSON(struct {
				ServerIP  string `json:"server_ip"`
				SSHHost   string `json:"ssh_host"`
				ProxyPort int    `json:"proxy_port"`
				Domain    string `json:"domain"`
			}{s.ServerIP, s.SSHHost, s.ProxyPort, s.Domain})
			return
		}
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
