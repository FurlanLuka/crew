package dev

import (
	"fmt"
	"sort"
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
			p.Template = ProposeTemplate(owners[0], configured)
		}
		proposals = append(proposals, p)
	}

	sort.Slice(proposals, func(i, j int) bool { return proposals[i].Var < proposals[j].Var })
	return proposals
}

// ProposeTemplate writes the shortest template that names a target
// unambiguously — the bare project form when it owns one server.
func ProposeTemplate(target ProjectServer, configured map[int][]ProjectServer) string {
	servers := 0
	for _, owners := range configured {
		for _, o := range owners {
			if o.Project == target.Project {
				servers++
			}
		}
	}
	if servers == 1 {
		return fmt.Sprintf("{{url:%s}}", target.Project)
	}
	return fmt.Sprintf("{{url:%s/%s}}", target.Project, target.Server)
}
