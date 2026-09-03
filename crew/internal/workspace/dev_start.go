package workspace

import (
	"fmt"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
)

// StartDev starts a worktree's dev servers.
//
// The single place the checks, settings lookup and dev.Start call live — the
// CLI's start and restart paths and the TUI's two were four copies of it.
func StartDev(res *Resolved, noProxy bool) (dev.StartResult, error) {
	if !exec.HasTmux() {
		return dev.StartResult{}, fmt.Errorf("tmux not found — install with: brew install tmux")
	}
	if err := AssertDirectProjectsAvailable(res); err != nil {
		return dev.StartResult{}, err
	}

	projects := res.DevProjects()
	if len(projects) == 0 {
		return dev.StartResult{}, fmt.Errorf("no dev_servers configured — configure via: crew dev setup <project>")
	}

	settings := config.LoadSettings()
	return dev.Start(dev.StartParams{
		Slug:      res.Slug,
		Workspace: res.Ref.Workspace,
		Worktree:  res.Ref.Worktree,
		Projects:  projects,
		Overrides: res.Overrides,
		Domain:    settings.GetDomain(dev.ResolveHostIP()),
		ProxyPort: settings.GetProxyPort(),
		NoProxy:   noProxy,
	})
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
