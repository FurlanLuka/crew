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

// Conflict is an env file value pointing at a port crew handed to something
// else. Not a guess: crew allocated the port and knows what it gave it to.
type Conflict struct {
	Project string
	Var     string
	Value   string
	Port    int
	Owner   PortOwner
}

// DetectParams scopes conflict detection to one project.
//
// Per-project because two projects can each define API_URL with different
// values; a flat map would attribute the conflict to the wrong one, in a
// warning whose whole value is naming the right one.
type DetectParams struct {
	Project   string
	EnvValues map[string]string
	Injected  []Resolution
	Allocated map[int]PortOwner
}

// DetectPortConflicts finds env values aimed at a port owned by another
// project. Pure.
//
// It scans every env value, not just the ones a binding failed to resolve. The
// variable behind the bug this exists to catch — an eval env pointing at
// localhost:3000, which was another project's homepage — had no binding at all,
// so scoping the scan to bindings would mean it could never fire on its own
// motivating example.
//
// Variables crew is injecting are skipped: crew has already replaced them, so
// whatever the file says about them no longer reaches the process.
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

		owner, allocated := p.Allocated[port]
		if !allocated || owner.Project == p.Project {
			continue
		}

		conflicts = append(conflicts, Conflict{
			Project: p.Project,
			Var:     name,
			Value:   value,
			Port:    port,
			Owner:   owner,
		})
	}

	sort.Slice(conflicts, func(i, j int) bool { return conflicts[i].Var < conflicts[j].Var })
	return conflicts
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
