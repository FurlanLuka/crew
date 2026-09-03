package main

import (
	"encoding/json"
	"fmt"
	"os"
	osexec "os/exec"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

func cmdDev() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev [setup|add|rm|show|start|stop|restart|status|logs]\n")
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
	case "logs":
		cmdDevLogs()
	case "tui":
		cmdDevTui()
	case "_proxy":
		cmdDevProxy()
	default:
		fmt.Fprintf(os.Stderr, "Unknown dev command '%s'.\nUsage: crew dev [setup|add|rm|show|start|stop|restart|status|logs|tui]\n", os.Args[2])
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
			if n, _ := fmt.Sscanf(strings.TrimPrefix(arg, "--port="), "%d", &port); n != 1 {
				fmt.Fprintf(os.Stderr, "Error: invalid --port value\n")
				os.Exit(1)
			}
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

	if jsonOutput {
		servers := p.DevServers
		if servers == nil {
			servers = []project.DevServer{}
		}
		printJSON(servers)
		return
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

	settings := config.LoadSettings()
	host := dev.ResolveHostIP()
	domain := settings.GetDomain(host)
	proxyPort := settings.GetProxyPort()

	var allRoutes []dev.WsRoutes
	var err error

	if wsFilter != "" {
		for _, slug := range slugsFor(wsFilter) {
			routes, loadErr := dev.LoadRoutes(slug)
			if loadErr != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", loadErr)
				os.Exit(1)
			}
			if len(routes) > 0 {
				allRoutes = append(allRoutes, dev.WsRoutes{Slug: slug, Routes: routes})
			}
		}
	} else {
		allRoutes, err = dev.ListAllRoutes()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
	}

	rows := dev.StatusRows(allRoutes, domain, proxyPort)
	if jsonOutput {
		printJSON(rows)
		return
	}
	for _, r := range rows {
		fmt.Printf("%s\t%s\t%d\t%s\n", r.Worktree, r.ServerName, r.ExternalPort, r.URL)
	}
}

// parseNoProxyFlag parses extra args after the workspace name, accepting only
// --no-proxy. Exits on unknown flags.
func parseNoProxyFlag(args []string) bool {
	noProxy := false
	for _, arg := range args {
		switch arg {
		case "--no-proxy":
			noProxy = true
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
			os.Exit(1)
		}
	}
	return noProxy
}

func cmdDevStart() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev start <workspace>[/<worktree>]\n")
		os.Exit(1)
	}
	startDev(os.Args[3], parseNoProxyFlag(os.Args[4:]), false)
}

// startDev backs both `crew dev start` and `crew dev restart`; restart differs
// only in tearing the existing session down first, and in the word it reports.
func startDev(arg string, noProxy, restart bool) {
	res := mustResolve(arg)
	if res.Ref.Worktree == "" {
		fmt.Fprintf(os.Stderr, "note: workspace '%s' predates worktrees — run `crew migrate` to get {{worktree}} and a second working copy\n\n", res.Ref.Workspace)
	}

	result, err := workspace.StartDev(res, noProxy, restart)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	verb := "Dev servers for"
	if restart {
		verb = "Restarted dev servers for"
	}
	fmt.Printf("%s %s\n\n", verb, res.Ref)
	for _, url := range workspace.DevURLs(res, result.Routes) {
		fmt.Printf("  %s\n", url)
	}

	if summary := dev.FormatResolutions(result.Resolutions); summary != "" {
		fmt.Printf("\n%s", summary)
	}
	if warnings := dev.FormatConflicts(result.Conflicts); warnings != "" {
		fmt.Print(warnings)
	}

	fmt.Printf("\nSession: %s\n", dev.SessionName(res.Slug))
	if len(result.Resolutions) > 0 {
		fmt.Printf("crew env %s <project> — full table\n", res.Ref)
	}
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

	for _, slug := range slugsFor(wsName) {
		dev.StopAll(slug)
		fmt.Printf("Stopped dev session for %s\n", dev.DisplayRef(slug))
	}
	dev.StopProxyIfIdle()
}

// slugsFor expands a ref argument for the read-only and stop-everything
// commands: a bare workspace means every worktree in it, which is what stop
// and status meant before worktrees existed. Commands that start something
// still have to be told which worktree.
func slugsFor(arg string) []dev.Slug {
	ref, err := workspace.ParseRef(arg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if ref.Worktree != "" {
		return []dev.Slug{ref.Slug()}
	}

	ws, err := workspace.Load(ref.Workspace)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: workspace '%s' not found\n", ref.Workspace)
		os.Exit(1)
	}
	var slugs []dev.Slug
	for _, r := range workspace.Refs(ws) {
		slugs = append(slugs, r.Slug())
	}
	return slugs
}

func cmdDevRestart() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev restart <workspace>[/<worktree>]\n")
		os.Exit(1)
	}
	startDev(os.Args[3], parseNoProxyFlag(os.Args[4:]), true)
}

func cmdDevLogs() {
	if len(os.Args) < 5 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev logs <workspace>[/<worktree>] <server> [-f|--follow]\n")
		os.Exit(1)
	}

	follow := false
	for _, arg := range os.Args[5:] {
		switch arg {
		case "-f", "--follow":
			follow = true
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
			os.Exit(1)
		}
	}

	res := mustResolve(os.Args[3])
	serverName := os.Args[4]

	logFile := dev.LogFile(res.Slug, serverName)
	if _, err := os.Stat(logFile); err != nil {
		fmt.Fprintf(os.Stderr, "Error: no log file for %s %s — has the server been started?\n", res.Ref, serverName)
		os.Exit(1)
	}

	var tool string
	var args []string
	if follow {
		tool = "tail"
		args = []string{"-n", "+1", "-f", logFile}
	} else {
		tool = "cat"
		args = []string{logFile}
	}

	cmd := osexec.Command(tool, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*osexec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func cmdDevTui() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev tui <workspace>[/<worktree>]\n")
		os.Exit(1)
	}

	runTUI(workspace.NewWorktreeView(mustResolve(os.Args[3]).Ref))
}

func cmdDevProxy() {
	domain := ""
	port := config.LoadSettings().GetProxyPort()

	for _, arg := range os.Args[3:] {
		switch {
		case strings.HasPrefix(arg, "--domain="):
			domain = strings.TrimPrefix(arg, "--domain=")
		case strings.HasPrefix(arg, "--port="):
			if n, _ := fmt.Sscanf(strings.TrimPrefix(arg, "--port="), "%d", &port); n != 1 {
				fmt.Fprintf(os.Stderr, "Error: invalid --port value\n")
				os.Exit(1)
			}
		}
	}

	if err := dev.RunProxy(domain, port); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func detectDevCommand(projectPath string) string {
	data, err := os.ReadFile(projectPath + "/package.json")
	if err != nil {
		return ""
	}
	var pkg struct {
		Scripts map[string]string `json:"scripts"`
	}
	if json.Unmarshal(data, &pkg) != nil {
		return ""
	}
	if _, ok := pkg.Scripts["dev"]; ok {
		return "npm run dev"
	}
	if _, ok := pkg.Scripts["start"]; ok {
		return "npm start"
	}
	return ""
}
