package main

import (
	"fmt"
	"os"
	osexec "os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
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
	case "check":
		cmdDevCheck()
	case "proxy":
		cmdDevProxyCtl()
	case "_proxy":
		cmdDevProxy()
	default:
		fmt.Fprintf(os.Stderr, "Unknown dev command '%s'.\nUsage: crew dev [setup|add|rm|show|start|stop|restart|status|check|logs|proxy|tui]\n", os.Args[2])
		os.Exit(1)
	}
}

// cmdDevCheck is the smoke's look at the running servers, on demand: which
// died, which run without listening while something points at them.
func cmdDevCheck() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev check <workspace>[/<worktree>] [--wait]\n")
		os.Exit(1)
	}
	wait := false
	for _, arg := range os.Args[4:] {
		switch arg {
		case "--wait":
			wait = true
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
			os.Exit(1)
		}
	}
	res := mustResolve(os.Args[3])
	var results []workspace.SmokeResult
	if wait {
		results = workspace.WaitServers(res)
	} else {
		results = workspace.CheckServers(res)
	}
	if jsonOutput {
		if results == nil {
			results = []workspace.SmokeResult{}
		}
		printJSON(results)
	} else if results == nil {
		fmt.Fprintf(os.Stderr, "nothing running on %s — crew dev start %s\n", res.Ref, res.Ref)
	} else {
		for _, r := range results {
			state, detail := "running", ""
			switch r.State() {
			case workspace.SmokeDied:
				state, detail = "died", firstLine(r.Tail)
			case workspace.SmokeUnreached:
				state, detail = "not listening", fmt.Sprintf("something points at :%d", r.Port)
			case workspace.SmokeIdle:
				state, detail = "not listening", "nothing points at it"
			}
			port := "-"
			if r.Port > 0 {
				port = fmt.Sprint(r.Port)
			}
			fmt.Printf("%s/%s\t%s\t%s\t%s\t%s\n", r.Project, r.Server, state, port, r.Took().Round(100*time.Millisecond), detail)
		}
	}
	if len(workspace.SmokeFailures(results)) > 0 {
		os.Exit(1)
	}
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// cmdDevProxyCtl is the proxy's own surface: what it is serving, and a stop
// that leaves every worktree's servers alone.
func cmdDevProxyCtl() {
	sub := "status"
	if len(os.Args) > 3 {
		sub = os.Args[3]
	}
	switch sub {
	case "status":
		st := dev.InspectProxy()
		if jsonOutput {
			printJSON(st)
			return
		}
		state := "down"
		switch {
		case st.Running && st.Listening:
			state = "up"
		case st.Running:
			state = "up (not listening)"
		}
		fmt.Printf("%s\t%s\t%d\t%s\n", state, st.Domain, st.Port, st.URL)
		switch {
		case st.Error != "" && !st.Listening:
			fmt.Fprintf(os.Stderr, "! %s\n", st.Error)
		case st.Running && !st.Listening:
			fmt.Fprintf(os.Stderr, "! another server holds the port? lsof -nP -iTCP:%d -sTCP:LISTEN\n", st.Port)
		}
	case "stop":
		dev.StopProxy()
		if jsonOutput {
			printJSON(map[string]bool{"stopped": true})
			return
		}
		fmt.Println("Stopped the proxy. Worktrees started with --proxy keep running; their hostnames answer again after crew dev restart <ref> --proxy.")
	default:
		fmt.Fprintf(os.Stderr, "Usage: crew dev proxy [status|stop]\n")
		os.Exit(1)
	}
}

// cmdDevSetup reports what crew can detect for a project and, with --apply,
// records it. Detection only knows package.json's dev/start scripts, so the
// port is always the caller's to give.
func cmdDevSetup() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev setup <project> [--apply --port=<port>]\n")
		os.Exit(1)
	}
	projName := os.Args[3]
	apply, port := false, 0
	for _, arg := range os.Args[4:] {
		switch {
		case arg == "--apply":
			apply = true
		case strings.HasPrefix(arg, "--port="):
			port = intFlag("--port", strings.TrimPrefix(arg, "--port="), true)
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
			os.Exit(1)
		}
	}
	if apply && port == 0 {
		fmt.Fprintf(os.Stderr, "Error: --apply needs --port=<port> — the script does not say which\n")
		os.Exit(1)
	}
	p := project.Get(projName)
	if p == nil {
		fmt.Fprintf(os.Stderr, "Error: project '%s' not found\n", projName)
		os.Exit(1)
	}

	proposal := setupProposal{Name: projName, Port: port, Command: exec.DetectDevCommand(p.Path), Outcome: "detected"}
	if proposal.Command == "" {
		fmt.Fprintf(os.Stderr, "Error: nothing detected in %s — crew dev add %s --name=%s --port=<port> --cmd=<command>\n", p.Path, projName, projName)
		os.Exit(1)
	}
	if apply {
		if err := project.AddDevServer(projName, project.DevServer{Name: proposal.Name, Port: port, Command: proposal.Command}); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		proposal.Outcome = "added"
	}
	if jsonOutput {
		printJSON(proposal)
		return
	}
	fmt.Printf("%s\t%s\t%s\n", proposal.Outcome, proposal.Name, proposal.Command)
	if !apply {
		fmt.Printf("crew dev setup %s --apply --port=<port> records it\n", projName)
	}
}

// setupProposal is the one server detection can offer: named after the
// project, running the detected script.
type setupProposal struct {
	Name    string `json:"name"`
	Port    int    `json:"port,omitempty"`
	Command string `json:"command"`
	Outcome string `json:"outcome"` // detected | added
}

func cmdDevAdd() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev add <project> --name=<n> [--port=<p>] --cmd=<c> [--dir=<d>]\n")
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
			port = intFlag("--port", strings.TrimPrefix(arg, "--port="), true)
		case strings.HasPrefix(arg, "--cmd="):
			cmd = strings.TrimPrefix(arg, "--cmd=")
		case strings.HasPrefix(arg, "--dir="):
			dir = strings.TrimPrefix(arg, "--dir=")
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
			os.Exit(1)
		}
	}

	if name == "" || cmd == "" {
		fmt.Fprintf(os.Stderr, "Error: --name and --cmd are required (--port only for a server that listens)\n")
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

	if ds.Listens() {
		fmt.Printf("Added dev server '%s' to %s (port %d)\n", name, projName, port)
	} else {
		fmt.Printf("Added dev server '%s' to %s (no port — it does not listen)\n", name, projName)
	}
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

	dropped, err := project.RemoveDevServer(projName, serverName)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Removed dev server '%s' from %s\n", serverName, projName)
	if len(dropped) > 0 {
		names := make([]string, 0, len(dropped))
		for _, b := range dropped {
			names = append(names, b.Var)
		}
		noun := "bindings"
		if len(dropped) == 1 {
			noun = "binding"
		}
		fmt.Printf("Removed %d %s scoped to %s: %s\n", len(dropped), noun, serverName, strings.Join(names, ", "))
	}
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
		port := "-"
		if ds.Listens() {
			port = fmt.Sprint(ds.Port)
		}
		if ds.Dir != "" {
			fmt.Printf("%s\t%s\t%s\t%s\n", ds.Name, port, ds.Command, ds.Dir)
		} else {
			fmt.Printf("%s\t%s\t%s\n", ds.Name, port, ds.Command)
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
	} else {
		for _, r := range rows {
			port, url := fmt.Sprint(r.ExternalPort), r.URL
			if r.URL == "" {
				port, url = "-", "-"
			}
			fmt.Printf("%s\t%s\t%s\t%s\n", r.Worktree, r.ServerName, port, url)
		}
	}
	// The hostnames above are the proxy's; without it they are dead URLs.
	if ref := firstProxied(allRoutes); ref != "" && !dev.InspectProxy().Running {
		fmt.Fprintf(os.Stderr, "! proxy is not running — crew dev restart %s --proxy\n", ref)
	}
}

func firstProxied(all []dev.WsRoutes) string {
	for _, wr := range all {
		for _, r := range wr.Routes {
			if r.Proxied() {
				return dev.DisplayRef(wr.Slug)
			}
		}
	}
	return ""
}

// parseProxyFlag parses extra args after the workspace name and reports
// whether to skip the proxy. Off by default — localhost URLs are what a
// single machine wants; --proxy opts into the shared reverse proxy for LAN
// hostnames. --no-proxy is still accepted so old habits and docs keep working.
func parseProxyFlag(args []string) (noProxy bool) {
	noProxy = true
	for _, arg := range args {
		switch arg {
		case "--proxy":
			noProxy = false
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
		fmt.Fprintf(os.Stderr, "Usage: crew dev start <workspace>[/<worktree>] [--proxy]\n")
		os.Exit(1)
	}
	startDev(os.Args[3], parseProxyFlag(os.Args[4:]), false)
}

// startDev backs both `crew dev start` and `crew dev restart`; restart differs
// only in tearing the existing session down first, and in the word it reports.
func startDev(arg string, noProxy, restart bool) {
	res := mustResolve(arg)
	if res.Ref.Worktree == "" {
		fmt.Fprintf(os.Stderr, "note: workspace '%s' predates worktrees — run `crew migrate` to get {{worktree}} and a second working copy\n\n", res.Ref.Workspace)
	}

	printHealthWarning(res)
	result, err := workspace.StartDev(res, noProxy, restart)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	if jsonOutput {
		out := startOut{
			Ref:         res.Ref.String(),
			URLs:        workspace.DevURLs(res, result.Routes),
			Resolutions: result.Resolutions,
			Conflicts:   result.Conflicts,
			Warnings:    result.Warnings,
			Health:      res.Health,
		}
		// Empty lists are lists; a reader should never branch on null.
		if out.Resolutions == nil {
			out.Resolutions = []dev.Resolution{}
		}
		if out.Conflicts == nil {
			out.Conflicts = []dev.Conflict{}
		}
		if out.Warnings == nil {
			out.Warnings = []string{}
		}
		printJSON(out)
		return
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
	for _, w := range result.Warnings {
		fmt.Printf("\n! %s\n", w)
	}

	fmt.Printf("\nSession: %s\n", dev.SessionName(res.Slug))
	if len(result.Resolutions) > 0 {
		fmt.Printf("crew env %s <project> — full table\n", res.Ref)
	}
	if !noProxy {
		// The one place the user is when a phone cannot open a URL; the
		// status page is the first thing to try there.
		fmt.Printf("Other devices: open %s first — crew help dev start if a URL fails there\n", dev.ProxyStatusURL())
	}
}

// startOut is crew dev start --json: everything the text form prints, as
// data. Health is the recorded failure the text form warns about first.
type startOut struct {
	Ref         string            `json:"ref"`
	URLs        []string          `json:"urls"`
	Resolutions []dev.Resolution  `json:"resolutions"`
	Conflicts   []dev.Conflict    `json:"conflicts"`
	Warnings    []string          `json:"warnings"`
	Health      *workspace.Health `json:"health,omitempty"`
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
		fmt.Fprintf(os.Stderr, "Usage: crew dev restart <workspace>[/<worktree>] [--proxy]\n")
		os.Exit(1)
	}
	startDev(os.Args[3], parseProxyFlag(os.Args[4:]), true)
}

func cmdDevLogs() {
	if len(os.Args) < 5 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev logs <workspace>[/<worktree>] <server> [-f|--follow]\n")
		os.Exit(1)
	}

	follow, lines := false, 0
	for _, arg := range os.Args[5:] {
		switch {
		case arg == "-f" || arg == "--follow":
			follow = true
		case strings.HasPrefix(arg, "--lines="):
			lines = intFlag("--lines", strings.TrimPrefix(arg, "--lines="), true)
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
	switch {
	case follow:
		tool = "tail"
		args = []string{"-n", "+1", "-f", logFile}
	case lines > 0:
		tool = "tail"
		args = []string{"-n", strconv.Itoa(lines), logFile}
	default:
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
			port = intFlag("--port", strings.TrimPrefix(arg, "--port="), true)
		}
	}

	if err := dev.RunProxy(domain, port); err != nil {
		debug.Log("dev", "proxy exited: %v", err)
		dev.RecordProxyError(err)
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
