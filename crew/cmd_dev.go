package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

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
			url := dev.RouteURL(r, wr.Workspace, domain, proxyPort)
			fmt.Printf("%s\t%s\t%d\t%s\n", wr.Workspace, r.ServerName, r.ExternalPort, url)
		}
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

// printRouteURLs prints one URL per route, one per line, indented.
func printRouteURLs(routes []dev.Route, wsName, domain string, proxyPort int) {
	for _, r := range routes {
		fmt.Printf("  %s\n", dev.RouteURL(r, wsName, domain, proxyPort))
	}
}

func cmdDevStart() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev start <workspace>\n")
		os.Exit(1)
	}

	wsName := os.Args[3]
	noProxy := parseNoProxyFlag(os.Args[4:])

	if !workspace.Exists(wsName) {
		fmt.Fprintf(os.Stderr, "Error: workspace '%s' not found\n", wsName)
		os.Exit(1)
	}

	if !exec.HasTmux() {
		fmt.Fprintf(os.Stderr, "Error: tmux not found — install with: brew install tmux\n")
		os.Exit(1)
	}

	settings := config.LoadSettings()
	host := dev.ResolveHostIP()
	domain := settings.GetDomain(host)
	proxyPort := settings.GetProxyPort()

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

	routes, err := dev.Start(wsName, projects, domain, proxyPort, noProxy)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Dev servers for %s\n\n", wsName)
	printRouteURLs(routes, wsName, domain, proxyPort)

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
		fmt.Fprintf(os.Stderr, "Usage: crew dev restart <workspace>\n")
		os.Exit(1)
	}

	wsName := os.Args[3]
	noProxy := parseNoProxyFlag(os.Args[4:])

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

	settings := config.LoadSettings()
	host := dev.ResolveHostIP()
	domain := settings.GetDomain(host)
	proxyPort := settings.GetProxyPort()

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

	routes, err := dev.Start(wsName, projects, domain, proxyPort, noProxy)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Restarted dev servers for %s\n\n", wsName)
	printRouteURLs(routes, wsName, domain, proxyPort)

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
