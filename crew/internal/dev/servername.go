package dev

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// LogFile is where one dev server's output goes. Keyed by project and
// server: server names are unique only within a project, and two projects
// each running "web" used to share one file.
func LogFile(slug Slug, project, server string) string {
	return filepath.Join(LogDir(slug), project+"-"+server+".log")
}

// legacyLogFile is the server-only name crew used before 6.6. A session
// started then keeps writing there until its next start.
func legacyLogFile(slug Slug, server string) string {
	return filepath.Join(LogDir(slug), server+".log")
}

// DevWindow is a dev server's tmux window in its worktree's session, keyed
// like LogFile and for the same reason.
func DevWindow(slug Slug, project, server string) string {
	return string(slug) + "/" + project + "/" + server
}

// RouteWindow is the window a running route lives in. A route file written
// before 6.6 has no Window: that session named windows by server alone.
func RouteWindow(slug Slug, r Route) string {
	if r.Window != "" {
		return r.Window
	}
	return string(slug) + "/" + r.ServerName
}

// RouteLogFile is where a running route's output goes, on the same rule.
func RouteLogFile(slug Slug, r Route) string {
	if r.Window != "" {
		return LogFile(slug, r.Project, r.ServerName)
	}
	return legacyLogFile(slug, r.ServerName)
}

// ExistingLogFile is the log to show for a server that may not be running:
// its own file, else the one a pre-6.6 session left, else its own path.
func ExistingLogFile(slug Slug, project, server string) string {
	current := LogFile(slug, project, server)
	if fileExists(current) {
		return current
	}
	if legacy := legacyLogFile(slug, server); fileExists(legacy) {
		return legacy
	}
	return current
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// RouteFor finds a server's running route. A pre-6.6 route may have no
// Project; its server name was unique enough for that session or it could
// not have run. Pure.
func RouteFor(routes []Route, target ProjectServer) (Route, bool) {
	for _, r := range routes {
		if r.ServerName == target.Server && (r.Project == target.Project || r.Project == "") {
			return r, true
		}
	}
	return Route{}, false
}

// WindowFor is the window a server runs in: its route's, or the name a
// start would give it now.
func WindowFor(slug Slug, routes []Route, target ProjectServer) string {
	if r, ok := RouteFor(routes, target); ok {
		return RouteWindow(slug, r)
	}
	return DevWindow(slug, target.Project, target.Server)
}

// ResolveServerName reads the server argument of `dev logs` and `dev
// restart`: `<project>/<server>`, or a bare server name when exactly one
// project has it. Pure.
func ResolveServerName(projects []DevProject, arg string) (ProjectServer, error) {
	if strings.Contains(arg, "/") {
		target, err := ParseTarget(arg)
		if err != nil || !target.HasServer {
			return ProjectServer{}, fmt.Errorf("expected <server> or <project>/<server>, got %q", arg)
		}
		for _, p := range projects {
			if p.Name != target.Project {
				continue
			}
			for _, ds := range p.DevServers {
				if ds.Name == target.Server {
					return ProjectServer{Project: p.Name, Server: ds.Name}, nil
				}
			}
			return ProjectServer{}, fmt.Errorf("project '%s' has no dev server '%s' (has: %s)", p.Name, target.Server, serverNames(p))
		}
		return ProjectServer{}, fmt.Errorf("no project %q in this worktree (servers: %s)", target.Project, allServers(projects))
	}

	var matches []ProjectServer
	for _, p := range projects {
		for _, ds := range p.DevServers {
			if ds.Name == arg {
				matches = append(matches, ProjectServer{Project: p.Name, Server: ds.Name})
			}
		}
	}
	switch len(matches) {
	case 1:
		return matches[0], nil
	case 0:
		return ProjectServer{}, fmt.Errorf("no dev server %q in this worktree (servers: %s)", arg, allServers(projects))
	}
	forms := make([]string, len(matches))
	for i, m := range matches {
		forms[i] = PortKey(m.Project, m.Server)
	}
	return ProjectServer{}, fmt.Errorf("%q is a server in %d projects — name one: %s", arg, len(matches), strings.Join(forms, ", "))
}

// LogFileFor is the log of one server: where its running window writes, or
// for a stopped one the file it left (ExistingLogFile).
func LogFileFor(slug Slug, routes []Route, target ProjectServer) string {
	if r, ok := RouteFor(routes, target); ok {
		return RouteLogFile(slug, r)
	}
	return ExistingLogFile(slug, target.Project, target.Server)
}

func serverNames(p DevProject) string {
	names := make([]string, len(p.DevServers))
	for i, ds := range p.DevServers {
		names[i] = ds.Name
	}
	return strings.Join(names, ", ")
}

func allServers(projects []DevProject) string {
	var out []string
	for _, p := range projects {
		for _, ds := range p.DevServers {
			out = append(out, PortKey(p.Name, ds.Name))
		}
	}
	if len(out) == 0 {
		return "none"
	}
	return strings.Join(out, ", ")
}
