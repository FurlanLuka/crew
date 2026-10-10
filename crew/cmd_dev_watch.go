package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// watchKeepalive: with nothing changing a watch writes nothing, and a reader
// that went away is only noticed on a write — so an empty line goes out this
// often. Readers skip empty lines.
const watchKeepalive = 15 * time.Second

// watchTick is how often `crew dev watch` looks: one pane read and one dial
// per server, cheap enough to catch a restart within a second.
const watchTick = 500 * time.Millisecond

// watchDoc is one `crew dev watch` snapshot: every declared server, the
// setup runners and the recorded health — what the crew pane in a Claude
// session draws from.
type watchDoc struct {
	Ref     string                 `json:"ref"`
	Running bool                   `json:"running"` // the worktree's dev session exists
	Proxied bool                   `json:"proxied"`
	Servers []workspace.ServerLine `json:"servers"`
	Setup   watchSetupDoc          `json:"setup"`
	Health  *workspace.Health      `json:"health"`
}

// watchSetupDoc is `setup status --json` without the ref it would repeat.
type watchSetupDoc struct {
	Running  bool                      `json:"running"`
	Failed   bool                      `json:"failed"`
	Projects []workspace.ProjectStatus `json:"projects"`
}

// watchInputs is everything one snapshot is built from, read by lookOnce.
type watchInputs struct {
	Res      *workspace.Resolved
	Routes   []dev.Route
	RoutesAt time.Time
	Checks   []workspace.SmokeResult
	Setup    workspace.Status
	Now      time.Time
	URL      func(dev.Route) string
}

// buildWatchDoc is pure over one look.
func buildWatchDoc(in watchInputs) watchDoc {
	return watchDoc{
		Ref:     in.Res.Ref.String(),
		Running: len(in.Routes) > 0,
		Proxied: dev.RoutesProxied(in.Routes),
		Servers: workspace.ServerLines(workspace.ServerLinesParams{
			Projects:  in.Res.DevProjects(),
			Routes:    in.Routes,
			Checks:    in.Checks,
			Reserved:  in.Res.Ports,
			StartedAt: in.RoutesAt,
			Now:       in.Now,
			URL:       in.URL,
		}),
		Setup:  watchSetupDoc{Running: in.Setup.Running(), Failed: in.Setup.Failed(), Projects: statusProjects(in.Setup)},
		Health: in.Res.Health,
	}
}

func lookOnce(ref workspace.Ref) (watchDoc, error) {
	res, err := workspace.Resolve(ref)
	if err != nil {
		return watchDoc{}, err
	}
	routes, _ := dev.LoadRoutes(res.Slug)
	var routesAt time.Time
	if info, err := os.Stat(dev.RoutesFilePath(res.Slug)); err == nil {
		routesAt = info.ModTime()
	}
	st, _ := workspace.SetupStatus(res.Ref)
	settings := config.LoadSettings()
	domain := settings.GetDomain(dev.ResolveHostIP())
	proxyPort := settings.GetProxyPort()
	return buildWatchDoc(watchInputs{
		Res:      res,
		Routes:   routes,
		RoutesAt: routesAt,
		Checks:   workspace.CheckServers(res),
		Setup:    st,
		Now:      time.Now(),
		URL:      func(r dev.Route) string { return dev.RouteURL(r, res.Slug, domain, proxyPort) },
	}), nil
}

// watchLines is the text form: one line per server, tab-separated. Pure.
func watchLines(doc watchDoc) string {
	var b strings.Builder
	for _, s := range doc.Servers {
		fmt.Fprintf(&b, "%s\t%s\t%s\n", dev.PortKey(s.Project, s.Server), s.State, s.URL)
	}
	if doc.Setup.Running {
		b.WriteString("setup\trunning\t\n")
	}
	if doc.Health != nil && len(doc.Health.Issues) > 0 {
		fmt.Fprintf(&b, "health\t%s\t\n", doc.Health.Summary())
	}
	return b.String()
}

func cmdDevWatch() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew dev watch <workspace>[/<worktree>] [--once]\n")
		os.Exit(1)
	}
	once := false
	for _, arg := range os.Args[4:] {
		if arg != "--once" {
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
			os.Exit(1)
		}
		once = true
	}
	ref := mustResolve(os.Args[3]).Ref

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	// Without this a write to a closed pipe kills the process by signal and
	// the exit below never runs.
	signal.Ignore(syscall.SIGPIPE)

	var last []byte
	wrote := time.Now()
	for {
		doc, err := lookOnce(ref)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		out := renderWatch(doc)
		changed := !bytes.Equal(last, out)
		if changed || time.Since(wrote) >= watchKeepalive {
			if !changed {
				out = []byte("\n")
			}
			// A reader that went away (the session closed the pipe) ends
			// the watch; nothing else would notice it.
			if _, err := os.Stdout.Write(out); err != nil {
				os.Exit(0)
			}
			if changed {
				last = out
			}
			wrote = time.Now()
		}
		if once {
			return
		}
		select {
		case <-stop:
			os.Exit(0)
		case <-time.After(watchTick):
		}
	}
}

// renderWatch is one snapshot as it goes out: a JSON line, or the text
// block with a blank line after it.
func renderWatch(doc watchDoc) []byte {
	if jsonOutput {
		data, _ := json.Marshal(doc)
		return append(data, '\n')
	}
	return []byte(watchLines(doc) + "\n")
}
