package dev

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/debug"
	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

// Binding declares that a project needs Var set, and how to compute it.
// Value is a template; see ExpandTemplate.
type Binding struct {
	Var   string
	Value string
}

// ProjectServer names one dev server unambiguously. Server names are unique
// only within a project, so the pair is the key.
type ProjectServer struct {
	Project string
	Server  string
}

// Source records how a variable got its value, and is the sentinel for whether
// it got one at all. Never test Value == "": an override may deliberately set
// an empty string, which is not the same as leaving the variable alone.
type Source string

const (
	SourceOverride   Source = "override"
	SourceBinding    Source = "binding"
	SourceUnresolved Source = "unresolved"
)

// Resolution is one variable's outcome for one project in one worktree.
type Resolution struct {
	Project string
	Var     string
	Value   string
	Source  Source
	Detail  string
}

// Resolved reports whether this variable should be injected.
func (r Resolution) Resolved() bool { return r.Source != SourceUnresolved }

// ResolveParams is everything ResolveBindings needs, all pre-resolved.
//
// Ports is a lookup rather than []Route on purpose: rule 3 becomes a map miss
// instead of a re-derivation of Start's ordering, and the two callers can build
// it from whichever source they have — planned servers, or a loaded route file.
type ResolveParams struct {
	Projects  []DevProject
	Ports     map[ProjectServer]int
	Workspace string
	Worktree  string
	Overrides map[string]string
}

// IndexPorts builds the port lookup from servers about to be started.
func IndexPorts(planned []PlannedServer) map[ProjectServer]int {
	ports := make(map[ProjectServer]int, len(planned))
	for _, ps := range planned {
		ports[ProjectServer{Project: ps.Project, Server: ps.Server.Name}] = ps.Route.InternalPort
	}
	return ports
}

// IndexRoutePorts builds the port lookup from servers already running.
func IndexRoutePorts(routes []Route) map[ProjectServer]int {
	ports := make(map[ProjectServer]int, len(routes))
	for _, r := range routes {
		ports[ProjectServer{Project: r.Project, Server: r.ServerName}] = r.InternalPort
	}
	return ports
}

// ResolveBindings computes every project's variables for one worktree. Pure.
//
// Precedence per variable: a worktree override wins; otherwise the binding's
// template is expanded; otherwise the variable is left alone entirely.
//
// Overrides that name a variable no binding declares still apply — an override
// is "set this here", not "amend that binding".
func ResolveBindings(p ResolveParams) []Resolution {
	inWorktree := make(map[string]bool, len(p.Projects))
	for _, proj := range p.Projects {
		inWorktree[proj.Name] = true
	}

	var out []Resolution
	for _, proj := range p.Projects {
		seen := make(map[string]bool)

		for _, b := range proj.Bindings {
			seen[b.Var] = true
			out = append(out, resolveOne(p, proj.Name, b, inWorktree))
		}

		for _, r := range extraOverrides(p.Overrides, proj.Name, seen) {
			out = append(out, r)
		}
	}
	return out
}

func resolveOne(p ResolveParams, projName string, b Binding, inWorktree map[string]bool) Resolution {
	if value, ok := lookupOverride(p.Overrides, projName, b.Var); ok {
		return Resolution{
			Project: projName, Var: b.Var, Value: value,
			Source: SourceOverride, Detail: "worktree override",
		}
	}

	value, err := ExpandTemplate(b.Value, TemplateContext{
		Workspace:  p.Workspace,
		Worktree:   p.Worktree,
		Ports:      p.Ports,
		InWorktree: inWorktree,
	})
	if err != nil {
		return Resolution{
			Project: projName, Var: b.Var,
			Source: SourceUnresolved, Detail: err.Error(),
		}
	}

	return Resolution{
		Project: projName, Var: b.Var, Value: value,
		Source: SourceBinding, Detail: describeTemplate(b.Value),
	}
}

// extraOverrides yields overrides naming variables no binding declared.
func extraOverrides(overrides map[string]string, projName string, seen map[string]bool) []Resolution {
	var out []Resolution
	for key, value := range overrides {
		name, ok := overrideTarget(key, projName)
		if !ok || seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, Resolution{
			Project: projName, Var: name, Value: value,
			Source: SourceOverride, Detail: "worktree override",
		})
	}
	return out
}

// overrideTarget reports the variable an override key names for this project.
// A key is either "VAR" (any project) or "project.VAR" (that project only).
func overrideTarget(key, projName string) (string, bool) {
	if proj, name, found := strings.Cut(key, "."); found {
		return name, proj == projName
	}
	return key, true
}

// lookupOverride finds an override for one variable. The project-qualified form
// wins, so a variable name shared by two projects stays addressable.
func lookupOverride(overrides map[string]string, projName, varName string) (string, bool) {
	if value, ok := overrides[projName+"."+varName]; ok {
		return value, true
	}
	value, ok := overrides[varName]
	return value, ok
}

// TemplateContext is what a binding template can refer to.
type TemplateContext struct {
	Workspace  string
	Worktree   string
	Ports      map[ProjectServer]int
	InWorktree map[string]bool
}

var tokenPattern = regexp.MustCompile(`\{\{([a-z]+)(?::([^}]+))?\}\}`)

// ExpandTemplate substitutes every token in a binding value. Pure.
//
// Tokens:
//
//	{{url:proj/server}}   http://localhost:<port>
//	{{port:proj/server}}  the allocated port
//	{{worktree}}          this worktree's name
//	{{workspace}}         this workspace's name
//
// The server half is optional when the target project has exactly one dev
// server, which is the common case and what the pickers generate.
//
// An unresolvable token fails the whole expansion rather than leaving a hole:
// a half-expanded value that reaches a process is exactly the silently-wrong
// URL this feature exists to prevent.
func ExpandTemplate(value string, ctx TemplateContext) (string, error) {
	var failure error

	expanded := tokenPattern.ReplaceAllStringFunc(value, func(token string) string {
		m := tokenPattern.FindStringSubmatch(token)
		kind, arg := m[1], m[2]

		switch kind {
		case "worktree":
			if ctx.Worktree == "" {
				failure = fmt.Errorf("{{worktree}} is unavailable — workspace has no worktrees")
				return token
			}
			return ctx.Worktree

		case "workspace":
			return ctx.Workspace

		case "port", "url":
			port, err := ctx.lookupPort(arg)
			if err != nil {
				failure = err
				return token
			}
			if kind == "url" {
				return fmt.Sprintf("http://localhost:%d", port)
			}
			return strconv.Itoa(port)

		default:
			failure = fmt.Errorf("unknown token {{%s}}", kind)
			return token
		}
	})

	if failure != nil {
		return "", failure
	}
	return expanded, nil
}

// lookupPort resolves a "proj[/server]" reference against the running servers.
func (ctx TemplateContext) lookupPort(arg string) (int, error) {
	if arg == "" {
		return 0, fmt.Errorf("missing target — expected {{port:project/server}}")
	}

	proj, server, hasServer := strings.Cut(arg, "/")

	if !ctx.InWorktree[proj] {
		return 0, fmt.Errorf("%s not in workspace", proj)
	}

	if hasServer {
		port, ok := ctx.Ports[ProjectServer{Project: proj, Server: server}]
		if !ok {
			return 0, fmt.Errorf("%s/%s is not running", proj, server)
		}
		return port, nil
	}

	// Bare project reference: unambiguous only when it owns one running server.
	var found int
	matches := 0
	for ps, port := range ctx.Ports {
		if ps.Project == proj {
			found = port
			matches++
		}
	}
	switch matches {
	case 0:
		return 0, fmt.Errorf("%s has no running dev server", proj)
	case 1:
		return found, nil
	default:
		return 0, fmt.Errorf("%s has %d dev servers — name one, as %s/<server>", proj, matches, proj)
	}
}

// describeTemplate names a template's source for the resolution table, in the
// "from project (server)" form. "a/b" already means workspace/worktree in the
// same output, so it is deliberately not reused here.
func describeTemplate(value string) string {
	m := tokenPattern.FindStringSubmatch(value)
	if m == nil {
		return "literal"
	}
	switch m[1] {
	case "port", "url":
		proj, server, hasServer := strings.Cut(m[2], "/")
		if hasServer {
			return fmt.Sprintf("from %s (%s)", proj, server)
		}
		return "from " + proj
	default:
		return "{{" + m[1] + "}}"
	}
}

// EnvPrefix renders resolved variables as shell exports. Pure.
//
// Exports rather than inline VAR=x assignments, which bind only to the next
// simple command: a configured command like `cd worker && npm start` would
// silently drop every one of them.
//
// Returns "" when nothing resolved, so a project with no bindings produces a
// byte-identical command line to before this existed.
func EnvPrefix(resolutions []Resolution) string {
	var b strings.Builder
	for _, r := range resolutions {
		if !r.Resolved() {
			continue
		}
		fmt.Fprintf(&b, "export %s=%s; ", r.Var, crewExec.ShellQuote(r.Value))
	}
	return b.String()
}

// LogResolutions records what each variable resolved to.
//
// Names, sources and targets only — never values. Bindings and overrides carry
// service URLs and could carry credentials; the debug log is not the place.
func LogResolutions(slug Slug, resolutions []Resolution) {
	for _, r := range resolutions {
		debug.Log("dev", "%s %s/%s → %s (%s)", slug, r.Project, r.Var, r.Source, r.Detail)
	}
}
