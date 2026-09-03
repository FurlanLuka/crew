package project

import (
	"fmt"
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

	for _, tok := range dev.ParseTokens(b.Value) {
		switch tok.Kind {
		case "worktree", "workspace":
			if tok.HasArg {
				return fmt.Errorf("{{%s}} takes no argument", tok.Kind)
			}
		case "url", "port":
			if err := validateTarget(tok.Arg); err != nil {
				return err
			}
		default:
			return fmt.Errorf("unknown token {{%s}} — expected url, port, worktree or workspace", tok.Kind)
		}
	}
	return nil
}

// validateTarget checks that a {{url:…}} / {{port:…}} target names a project in
// the pool and, when it omits the server, that the project has exactly one.
func validateTarget(arg string) error {
	ref, err := dev.ParseTarget(arg)
	if err != nil {
		return err
	}

	target := Get(ref.Project)
	if target == nil {
		return fmt.Errorf("no project '%s' in the pool", ref.Project)
	}

	if ref.HasServer {
		for _, ds := range target.DevServers {
			if ds.Name == ref.Server {
				return nil
			}
		}
		return fmt.Errorf("project '%s' has no dev server '%s' (has: %s)",
			ref.Project, ref.Server, serverNames(*target))
	}

	switch len(target.DevServers) {
	case 0:
		return fmt.Errorf("project '%s' has no dev servers configured", ref.Project)
	case 1:
		return nil
	default:
		return dev.AmbiguousTargetError(ref.Project, len(target.DevServers), serverNames(*target))
	}
}

func serverNames(p Project) string {
	names := make([]string, 0, len(p.DevServers))
	for _, ds := range p.DevServers {
		names = append(names, ds.Name)
	}
	return strings.Join(names, ", ")
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
		for j, existing := range p.Bindings {
			if existing.Var == b.Var {
				projects[i].Bindings[j] = b
				return save(projects)
			}
		}
		projects[i].Bindings = append(projects[i].Bindings, b)
		return save(projects)
	}
	return fmt.Errorf("project '%s' not found", projName)
}

// RemoveBinding drops a binding by variable name.
func RemoveBinding(projName, varName string) error {
	projects, err := List()
	if err != nil {
		return err
	}
	for i, p := range projects {
		if p.Name != projName {
			continue
		}
		var filtered []Binding
		found := false
		for _, b := range p.Bindings {
			if b.Var == varName {
				found = true
				continue
			}
			filtered = append(filtered, b)
		}
		if !found {
			return fmt.Errorf("project '%s' has no binding for %s", projName, varName)
		}
		projects[i].Bindings = filtered
		return save(projects)
	}
	return fmt.Errorf("project '%s' not found", projName)
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
// binding scan. A key given several values — in one file or across checkouts
// — yields the one pointing at localhost when there is one.
func ScanEnv(projName string) map[string]string {
	all := map[string][]string{}
	for _, dir := range CheckoutDirs(projName) {
		for k, vs := range dev.ReadEnvValuesAll(dir) {
			all[k] = append(all[k], vs...)
		}
	}
	return dev.PreferLocalhost(all)
}
