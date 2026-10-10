package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// proxyMode is what a restart does with the proxy: keep what the running
// worktree has unless the flag says otherwise.
type proxyMode int

const (
	proxyKeep proxyMode = iota
	proxyOn
	proxyOff
)

// restartArgs is `crew dev restart <ref> …` after the ref.
type restartArgs struct {
	Server string // empty: every server
	Proxy  proxyMode
}

// parseRestartArgs reads one optional server and the proxy flags. A server
// with a proxy flag is refused: one server keeps the worktree's routes. Pure.
func parseRestartArgs(args []string) (restartArgs, error) {
	var out restartArgs
	for _, arg := range args {
		switch {
		case arg == "--proxy":
			out.Proxy = proxyOn
		case arg == "--no-proxy":
			out.Proxy = proxyOff
		case strings.HasPrefix(arg, "-"):
			return restartArgs{}, fmt.Errorf("unknown flag '%s'", arg)
		case out.Server != "":
			return restartArgs{}, fmt.Errorf("one server at a time, got '%s' and '%s'", out.Server, arg)
		default:
			out.Server = arg
		}
	}
	if out.Server != "" && out.Proxy != proxyKeep {
		return restartArgs{}, fmt.Errorf("--proxy and --no-proxy apply to the whole worktree; a single server keeps its routes")
	}
	return out, nil
}

func cmdDevRestart() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev restart <workspace>[/<worktree>] [<server>|<project>/<server>] [--proxy|--no-proxy]\n")
		os.Exit(1)
	}
	args, err := parseRestartArgs(os.Args[4:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	res := mustResolve(os.Args[3])
	if args.Server == "" {
		routes, _ := dev.LoadRoutes(res.Slug)
		startDevResolved(res, noProxyFor(args.Proxy, dev.RoutesProxied(routes)), true)
		return
	}
	restartOneServer(res, args.Server)
}

// noProxyFor turns the mode into Start's flag: kept is what the running
// worktree had — a restart with no flag used to drop --proxy silently. Pure.
func noProxyFor(mode proxyMode, wasProxied bool) bool {
	switch mode {
	case proxyOn:
		return false
	case proxyOff:
		return true
	}
	return !wasProxied
}

// restartOutput is `crew dev restart <ref> <server> --json`.
type restartOutput struct {
	Ref     string `json:"ref"`
	Project string `json:"project"`
	Server  string `json:"server"`
	Port    int    `json:"port"`
}

func restartOneServer(res *workspace.Resolved, serverArg string) {
	target, err := dev.ResolveServerName(res.DevProjects(), serverArg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	route, err := workspace.RestartDevServer(res, target)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if jsonOutput {
		printJSON(restartOutput{Ref: res.Ref.String(), Project: target.Project, Server: target.Server, Port: route.InternalPort})
		return
	}
	port := ""
	if route.Listens() {
		port = fmt.Sprintf(" on :%d", route.InternalPort)
	}
	fmt.Fprintf(human, "Restarted %s in %s%s\n", dev.PortKey(target.Project, target.Server), res.Ref, port)
	fmt.Fprintf(human, "crew dev check %s --wait — to confirm it listens\n", res.Ref)
}
