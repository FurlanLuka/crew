package project

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/dev"
)

var validVarName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// ValidateBinding checks a binding against the project pool before it is saved.
//
// Every check here is one that would otherwise surface as a variable silently
// left alone at dev-server start, which is far away from the edit that caused
// it. Failing the edit is the cheap place to be wrong.
func ValidateBinding(projName string, b Binding) error {
	if !validVarName.MatchString(b.Var) {
		return fmt.Errorf("'%s' is not a valid environment variable name", b.Var)
	}
	if b.Value == "" {
		return fmt.Errorf("binding for %s has no value", b.Var)
	}
	if b.Server != "" {
		p := Get(projName)
		if p == nil {
			return fmt.Errorf("project '%s' not found", projName)
		}
		if _, err := FindServer(projName, p.DevServers, b.Server); err != nil {
			return err
		}
	}

	tokens, err := dev.ParseTokens(b.Value)
	if err != nil {
		return err
	}
	for _, tok := range tokens {
		if tok.Kind == dev.TokenTarget {
			if err := validateTarget(tok.Target); err != nil {
				return err
			}
		}
	}
	return nil
}

// validateTarget checks that a token's target names a project in the pool
// and, when it omits the server, that the project has exactly one.
func validateTarget(ref dev.TargetRef) error {
	target := Get(ref.Project)
	if target == nil {
		return fmt.Errorf("no project '%s' in the pool", ref.Project)
	}

	if ref.HasServer {
		_, err := FindServer(ref.Project, target.DevServers, ref.Server)
		return err
	}

	switch len(target.DevServers) {
	case 0:
		return fmt.Errorf("project '%s' has no dev servers configured", ref.Project)
	case 1:
		return nil
	default:
		return dev.AmbiguousTargetError(ref.Project, len(target.DevServers), serverNames(target.DevServers))
	}
}

func serverNames(servers []DevServer) string {
	names := make([]string, 0, len(servers))
	for _, ds := range servers {
		names = append(names, ds.Name)
	}
	return strings.Join(names, ", ")
}

// FindServer names one of a project's dev servers, or says which ones it
// has — the one check behind a binding's scope, a token's target and the
// project/server argument of env and run.
func FindServer(projName string, servers []DevServer, name string) (DevServer, error) {
	for _, ds := range servers {
		if ds.Name == name {
			return ds, nil
		}
	}
	return DevServer{}, fmt.Errorf("project '%s' has no dev server '%s' (has: %s)",
		projName, name, serverNames(servers))
}

// AddBinding adds or replaces a binding on a project in the pool.
func AddBinding(projName string, b Binding) error {
	if err := ValidateBinding(projName, b); err != nil {
		return err
	}

	projects, err := List()
	if err != nil {
		return err
	}
	for i, p := range projects {
		if p.Name != projName {
			continue
		}
		projects[i].Bindings = upsertBinding(p.Bindings, b)
		return save(projects)
	}
	return fmt.Errorf("project '%s' not found", projName)
}

// upsertBinding replaces the binding with b's key in place, or appends.
// Pure.
func upsertBinding(bindings []Binding, b Binding) []Binding {
	out := append([]Binding(nil), bindings...)
	for i, existing := range out {
		if existing.Key() == b.Key() {
			out[i] = b
			return out
		}
	}
	return append(out, b)
}

// RemoveBinding drops the binding with that identity.
func RemoveBinding(projName string, key dev.BindingKey) error {
	projects, err := List()
	if err != nil {
		return err
	}
	for i, p := range projects {
		if p.Name != projName {
			continue
		}
		filtered, err := dropBinding(p.Bindings, key)
		if err != nil {
			return fmt.Errorf("project '%s' %w", projName, err)
		}
		projects[i].Bindings = filtered
		return save(projects)
	}
	return fmt.Errorf("project '%s' not found", projName)
}

// dropBinding removes the binding with key. Pure. A miss where scoped
// siblings share the var names them, so the error can point at the
// project/server form.
func dropBinding(bindings []Binding, key dev.BindingKey) ([]Binding, error) {
	var filtered []Binding
	var scoped []string
	found := false
	for _, b := range bindings {
		if b.Key() == key {
			found = true
			continue
		}
		if b.Var == key.Var && b.Server != "" {
			scoped = append(scoped, b.Server)
		}
		filtered = append(filtered, b)
	}
	if found {
		return filtered, nil
	}
	if key.Server == "" && len(scoped) > 0 {
		return nil, fmt.Errorf("has %s bound per server (%s) — crew rm binding <project>/<server> %s", key.Var, strings.Join(scoped, ", "), key.Var)
	}
	if key.Server != "" {
		return nil, fmt.Errorf("has no binding for %s scoped to %s", key.Var, key.Server)
	}
	return nil, fmt.Errorf("has no binding for %s", key.Var)
}

// scopedTo is the bindings scoped to one server. Pure.
func scopedTo(bindings []Binding, server string) []Binding {
	var out []Binding
	for _, b := range bindings {
		if b.Server == server {
			out = append(out, b)
		}
	}
	return out
}

// BoundFor is what a scan for one scope counts as already declared: a var
// bound project-wide covers every server, one bound for this same server is
// the same binding; one bound for another server is not. Pure.
func BoundFor(bindings []Binding, server string) map[string]bool {
	declared := map[string]bool{}
	for _, b := range bindings {
		if b.Server == "" || b.Server == server {
			declared[b.Var] = true
		}
	}
	return declared
}

// ConfiguredPorts maps each configured dev-server port to the projects that
// claim it. A port with two claimants is why Proposal carries Ambiguous rather
// than guessing.
func ConfiguredPorts() map[int][]dev.ProjectServer {
	ports := make(map[int][]dev.ProjectServer)

	projects, err := List()
	if err != nil {
		return ports
	}
	for _, p := range projects {
		for _, ds := range p.DevServers {
			ports[ds.Port] = append(ports[ds.Port], dev.ProjectServer{Project: p.Name, Server: ds.Name})
		}
	}
	return ports
}

// CheckoutDirs lists every directory a project's env files might live in:
// the canonical repo and each worktree checkout. Set by main, because the
// checkouts are the workspace package's to know and it imports this one.
// CopyEnvFiles puts .env into checkouts at creation, so the canonical repo
// alone is usually empty.
var CheckoutDirs = func(projName string) []string {
	if p := Get(projName); p != nil {
		return []string{p.Path}
	}
	return nil
}

// ScanEnv reads env values across every checkout of a project for the
// binding scan — under subdir when a server's dir is given (that dir alone:
// the root is the bare scan), the checkout root otherwise. A key given
// several values — in one file or across checkouts — yields the one pointing
// at localhost when there is one.
func ScanEnv(projName, subdir string) map[string]string {
	all := map[string][]string{}
	for _, dir := range CheckoutDirs(projName) {
		for k, vs := range dev.ReadEnvValuesAll(filepath.Join(dir, subdir)) {
			all[k] = append(all[k], vs...)
		}
	}
	return dev.PreferLocalhost(all)
}
