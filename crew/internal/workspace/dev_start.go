package workspace

import (
	"fmt"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
)

// StartDev starts a worktree's dev servers. With restart, the existing session
// is torn down first; the proxy is left running, since Start would only bring
// it straight back.
//
// The single place the checks, settings lookup and dev.Start call live — the
// CLI's start and restart paths and the TUI's two were four copies of it.
func StartDev(res *Resolved, noProxy, restart bool) (dev.StartResult, error) {
	if !exec.HasTmux() {
		return dev.StartResult{}, fmt.Errorf("tmux not found — install with: brew install tmux")
	}
	if err := AssertDirectProjectsAvailable(res); err != nil {
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
	return result, nil
}

// DevURLs renders one URL per route for a worktree.
func DevURLs(res *Resolved, routes []dev.Route) []string {
	settings := config.LoadSettings()
	domain := settings.GetDomain(dev.ResolveHostIP())
	proxyPort := settings.GetProxyPort()

	urls := make([]string, 0, len(routes))
	for _, r := range routes {
		urls = append(urls, dev.RouteURL(r, res.Slug, domain, proxyPort))
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
