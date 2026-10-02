package workspace

import (
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// BindingWire is one wire between two pool projects: a binding of From
// whose template targets To. OK when To is in the workspace too — picked
// or already a member.
type BindingWire struct {
	Var  string `json:"var"`
	From string `json:"from"`
	To   string `json:"to"`
	OK   bool   `json:"ok"`
}

// BindingWires is what the picked projects would wire up and what they
// would miss, pure over the pool: a token that targets another pool
// project makes a wire; {{worktree}}/{{workspace}}, a target outside the
// pool and a malformed template make none. One wire per (var, from, to).
func BindingWires(pool []project.Project, picked, members map[string]bool) []BindingWire {
	inPool := map[string]bool{}
	for _, p := range pool {
		inPool[p.Name] = true
	}
	wires := []BindingWire{}
	seen := map[BindingWire]bool{}
	for _, p := range pool {
		if !picked[p.Name] {
			continue
		}
		for _, bd := range p.Bindings {
			tokens, err := dev.ParseTokens(bd.Value)
			if err != nil {
				continue
			}
			for _, tok := range tokens {
				to := tok.Target.Project
				if tok.Kind != dev.TokenTarget || to == p.Name || !inPool[to] {
					continue
				}
				w := BindingWire{Var: bd.Var, From: p.Name, To: to, OK: picked[to] || members[to]}
				if !seen[w] {
					seen[w] = true
					wires = append(wires, w)
				}
			}
		}
	}
	return wires
}

// MemberWires is BindingWires for a workspace as it stands: its members
// are the picked set. Pure.
func MemberWires(pool []project.Project, ws *Workspace) []BindingWire {
	members := map[string]bool{}
	for _, wp := range ws.Projects {
		members[wp.Name] = true
	}
	return BindingWires(pool, members, nil)
}
