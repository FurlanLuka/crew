package dev

import (
	"sort"
	"strings"
)

// Proposal is a binding crew thinks a project's env file is already asking for.
type Proposal struct {
	Var       string
	Value     string // the env file's current value
	Port      int
	Template  string // the binding that would replace it
	Target    ProjectServer
	Ambiguous bool // two projects configured on the same port
}

// ProposeBindings turns a project's env file into bindings it could declare.
// Pure.
//
// Runs on the configured dev-server ports from the project pool rather than
// live routes, so scanning works with nothing running — which is when you are
// most likely to be setting a project up.
//
// This is the constructive half of the same read that DetectPortConflicts does
// after the fact: one finds a variable that should have been a binding, the
// other warns about one that wasn't.
func ProposeBindings(envValues map[string]string, configured map[int][]ProjectServer) []Proposal {
	var proposals []Proposal

	for name, value := range envValues {
		port, ok := ParseLocalhostPort(value)
		if !ok {
			continue
		}

		owners := configured[port]
		if len(owners) == 0 {
			continue
		}

		p := Proposal{
			Var:       name,
			Value:     value,
			Port:      port,
			Target:    owners[0],
			Ambiguous: len(owners) > 1,
		}
		if !p.Ambiguous {
			p.Template = ProposeTemplate(value, owners[0], configured)
		}
		proposals = append(proposals, p)
	}

	sort.Slice(proposals, func(i, j int) bool { return proposals[i].Var < proposals[j].Var })
	return proposals
}

// ProposeTemplate writes the shortest template that names a target
// unambiguously — the bare project form when it owns one server.
//
// The env file's scheme and path are kept: {{proj}} expands to http://, so
// proposing it for ws://localhost:7880 would silently turn a WebSocket URL into
// an HTTP one, and --apply would write that without anyone seeing it. Only
// plain http collapses to the bare token; everything else keeps its scheme
// around {{proj.host}}.
func ProposeTemplate(value string, target ProjectServer, configured map[int][]ProjectServer) string {
	ref := TargetRef{Project: target.Project}
	if configuredServerCount(target.Project, configured) > 1 {
		ref.Server, ref.HasServer = target.Server, true
	}

	scheme, rest := splitScheme(strings.TrimSpace(value))
	_, tail := splitHostPort(rest)

	if scheme == "http" {
		return TokenFor(ref, AccessorURL) + tail
	}
	if scheme == "" {
		return TokenFor(ref, AccessorHost) + tail
	}
	return scheme + "://" + TokenFor(ref, AccessorHost) + tail
}

func configuredServerCount(project string, configured map[int][]ProjectServer) int {
	n := 0
	for _, owners := range configured {
		for _, o := range owners {
			if o.Project == project {
				n++
			}
		}
	}
	return n
}

// splitScheme separates "ws://host:port/x" into ("ws", "host:port/x").
func splitScheme(value string) (scheme, rest string) {
	if i := strings.Index(value, "://"); i > 0 {
		return value[:i], value[i+3:]
	}
	return "", value
}

// splitHostPort separates "host:port/path?q" into ("host:port", "/path?q").
func splitHostPort(rest string) (hostPort, tail string) {
	if i := strings.IndexAny(rest, "/?#"); i >= 0 {
		return rest[:i], rest[i:]
	}
	return rest, ""
}
