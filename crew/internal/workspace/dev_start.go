package workspace

import (
	"errors"
	"fmt"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
)

// StartDev starts a worktree's dev servers. With restart, the existing session
// is torn down first; the proxy is left running, since Start would only bring
// it straight back.
//
// The single place the checks, settings lookup and dev.Start call live, for
// the CLI's start and restart paths alike.
func StartDev(res *Resolved, noProxy, restart bool) (dev.StartResult, error) {
	if err := devPreflight(res); err != nil {
		return dev.StartResult{}, err
	}

	projects := res.DevProjects()
	if !hasServers(projects) {
		return dev.StartResult{}, fmt.Errorf("no dev_servers configured — configure via: crew dev setup <project>")
	}

	if restart {
		dev.StopAll(res.Slug)
		// KillTmuxSession returns before the servers have died. Allocating
		// right away sees the reserved ports still held and moves every
		// server to a fresh port — the opposite of what restart is for.
		dev.WaitPortsFree(res.Ports, 3*time.Second)
	}

	settings := config.LoadSettings()
	result, err := dev.Start(dev.StartParams{
		Slug:      res.Slug,
		Workspace: res.Ref.Workspace,
		Worktree:  res.Ref.Worktree,
		Projects:  projects,
		Overrides: res.Overrides,
		Reserved:  res.Ports,
		Domain:    settings.GetDomain(dev.ResolveHostIP()),
		ProxyPort: settings.GetProxyPort(),
		NoProxy:   noProxy,
	})
	if err != nil {
		return result, err
	}

	if err := SavePorts(res.Ref, result.Ports); err != nil {
		return result, fmt.Errorf("servers started but ports could not be remembered: %w", err)
	}
	// A port can move when its reservation was taken; Desktop's preview
	// follows the file, so crew's own copy is kept current.
	if err := RefreshLaunchConfig(res); err != nil {
		debug.Log("dev", "launch.json refresh: %v", err)
	}
	return result, nil
}

// devPreflight is what any start of a worktree's servers needs first.
func devPreflight(res *Resolved) error {
	if !exec.HasTmux() {
		return fmt.Errorf("tmux not found — install with: brew install tmux")
	}
	if err := AssertDirectProjectsAvailable(res); err != nil {
		return err
	}
	// A server on top of an install still writing the same checkout is
	// corruption, not a warning — the refusal crew owns.
	if SetupRunning(res.Ref) {
		return SetupRunningError(res.Ref)
	}
	return nil
}

// RestartDevServer restarts one server of a running worktree on its port.
func RestartDevServer(res *Resolved, target dev.ProjectServer) (dev.Route, error) {
	if err := devPreflight(res); err != nil {
		return dev.Route{}, err
	}
	route, err := dev.RestartServer(dev.RestartServerParams{
		Slug:      res.Slug,
		Workspace: res.Ref.Workspace,
		Worktree:  res.Ref.Worktree,
		Projects:  res.DevProjects(),
		Overrides: res.Overrides,
		Target:    target,
	})
	return route, RestartRefusal(res.Ref, err)
}

// RestartRefusal words a one-server restart's refusal with the command that
// gets past it. Pure.
func RestartRefusal(ref Ref, err error) error {
	var notIn dev.NotInRunningSetError
	switch {
	case errors.Is(err, dev.ErrNotRunning):
		return fmt.Errorf("%s is not running — crew dev start %s", ref, ref)
	case errors.Is(err, dev.ErrStartedBefore66):
		return fmt.Errorf("%s's servers were started before crew 6.6 — restart them all once: crew dev restart %s", ref, ref)
	case errors.As(err, &notIn):
		return fmt.Errorf("%s is not in the running set (added since the last start?) — restart them all: crew dev restart %s", notIn.Server, ref)
	}
	return err
}

// DevURLs renders one URL per route for a worktree.
func DevURLs(res *Resolved, routes []dev.Route) []string {
	settings := config.LoadSettings()
	domain := settings.GetDomain(dev.ResolveHostIP())
	proxyPort := settings.GetProxyPort()

	urls := make([]string, 0, len(routes))
	for _, r := range routes {
		// A server with no port has no URL to hand out.
		if url := dev.RouteURL(r, res.Slug, domain, proxyPort); url != "" {
			urls = append(urls, url)
		}
	}
	return urls
}

func hasServers(projects []dev.DevProject) bool {
	for _, p := range projects {
		if len(p.DevServers) > 0 {
			return true
		}
	}
	return false
}
