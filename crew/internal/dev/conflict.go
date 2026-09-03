package dev

import (
	"net/url"
	"sort"
	"strconv"
	"strings"
)

// PortOwner is the dev server crew allocated a port to.
type PortOwner struct {
	Slug    Slug
	Project string
	Server  string
}

// Conflict is an env file value pointing at a port crew knows is wrong for it.
//
// Two shapes, both facts crew owns rather than guesses. Owner is set when the
// port was allocated to a server in another worktree. Stale is set when the
// port is a sibling project's configured port — the number in its dev-server
// config — while that server is actually running somewhere else in this
// worktree: the env file predates dynamic ports, and a binding is the fix.
type Conflict struct {
	Project string
	Var     string
	Value   string
	Port    int
	Owner   PortOwner
	Stale   *StaleTarget
}

// StaleTarget is the sibling server an env value was written for, and where
// it actually is now.
type StaleTarget struct {
	Project    string
	Server     string
	ActualPort int
}

// DetectParams scopes conflict detection to one project in one worktree.
//
// Per-project because two projects can each define API_URL with different
// values; a flat map would attribute the conflict to the wrong one, in a
// warning whose whole value is naming the right one.
type DetectParams struct {
	Project   string
	Slug      Slug
	EnvValues map[string]string
	Injected  []Resolution
	Allocated map[int]PortOwner
	// Siblings are this worktree's own servers as planned: configured port →
	// where they actually run. Optional; only the stale check uses it.
	Siblings []PlannedServer
}

// DetectPortConflicts finds env values aimed at a port crew gave to a server
// in a DIFFERENT worktree. Pure.
//
// The boundary is the worktree, not the project. A value pointing at a sibling
// project in the same worktree is the expected topology — it is what bindings
// formalise and what the scan proposes. A value pointing into another worktree
// is the bug: an env file copied from elsewhere, or a port that collides
// across worktrees. That is the case behind this feature — an eval env in one
// worktree pointing at localhost:3000, which was another workspace's homepage.
//
// It scans every env value, not just the ones a binding failed to resolve; the
// variable in that case had no binding at all. Variables crew is injecting are
// skipped: crew has already replaced them, so whatever the file says about them
// no longer reaches the process.
func DetectPortConflicts(p DetectParams) []Conflict {
	injected := make(map[string]bool, len(p.Injected))
	for _, r := range p.Injected {
		if r.Resolved() {
			injected[r.Var] = true
		}
	}

	var conflicts []Conflict
	for name, value := range p.EnvValues {
		if injected[name] {
			continue
		}

		port, ok := ParseLocalhostPort(value)
		if !ok {
			continue
		}

		if owner, allocated := p.Allocated[port]; allocated && owner.Slug != p.Slug {
			conflicts = append(conflicts, Conflict{
				Project: p.Project, Var: name, Value: value, Port: port, Owner: owner,
			})
			continue
		}

		if stale := staleSibling(p, port); stale != nil {
			conflicts = append(conflicts, Conflict{
				Project: p.Project, Var: name, Value: value, Port: port, Stale: stale,
			})
		}
	}

	sort.Slice(conflicts, func(i, j int) bool { return conflicts[i].Var < conflicts[j].Var })
	return conflicts
}

// staleSibling reports whether port is the configured port of another server
// in this worktree that is not actually bound there.
func staleSibling(p DetectParams, port int) *StaleTarget {
	for _, ps := range p.Siblings {
		if ps.Project == p.Project || ps.Server.Port != port || ps.Route.InternalPort == port {
			continue
		}
		return &StaleTarget{Project: ps.Project, Server: ps.Server.Name, ActualPort: ps.Route.InternalPort}
	}
	return nil
}

// ParseLocalhostPort extracts the port from a value addressing the local
// machine. Pure.
//
// Deliberately strict — this drives a warning, and a false positive costs more
// than a miss. Only localhost and 127.0.0.1 count: 0.0.0.0 is a bind address
// rather than something a client is pointed at.
func ParseLocalhostPort(value string) (int, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, false
	}

	host, port := "", ""
	if u, err := url.Parse(value); err == nil && u.Host != "" {
		host, port = u.Hostname(), u.Port()
	} else if h, p, found := strings.Cut(value, ":"); found {
		host, port = h, p
	} else {
		return 0, false
	}

	if host != "localhost" && host != "127.0.0.1" {
		return 0, false
	}

	n, err := strconv.Atoi(port)
	if err != nil || n <= 0 || n > 65535 {
		return 0, false
	}
	return n, true
}

// AllocatedPorts maps every port crew currently has handed out, across every
// running worktree, to what it gave it to.
func AllocatedPorts() map[int]PortOwner {
	allocated := make(map[int]PortOwner)

	all, err := ListAllRoutes()
	if err != nil {
		return allocated
	}

	for _, wr := range all {
		for _, r := range wr.Routes {
			allocated[r.InternalPort] = PortOwner{
				Slug:    wr.Slug,
				Project: r.Project,
				Server:  r.ServerName,
			}
		}
	}
	return allocated
}
