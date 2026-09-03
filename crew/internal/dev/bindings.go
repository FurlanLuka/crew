package dev

import (
	"fmt"
	"regexp"
	"sort"
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
//
// Routes written before Route.Project existed carry no project and are
// skipped: two of them named "api" would collapse to one key, which is the
// silent wrong-port binding this whole thing exists to prevent. Those servers
// resolve as "not running" until they are restarted under this version.
func IndexRoutePorts(routes []Route) map[ProjectServer]int {
	ports := make(map[ProjectServer]int, len(routes))
	for _, r := range routes {
		if r.Project == "" {
			continue
		}
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

		out = append(out, extraOverrides(p.Overrides, proj.Name, seen)...)
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

// extraOverrides yields overrides naming variables no binding declared, in
// a stable order — they come from a map, and the export prefix and the env
// table would otherwise reshuffle between runs.
func extraOverrides(overrides map[string]string, projName string, seen map[string]bool) []Resolution {
	keys := make([]string, 0, len(overrides))
	for key := range overrides {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	var out []Resolution
	for _, key := range keys {
		name, ok := overrideTarget(key, projName)
		if !ok || seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, Resolution{
			Project: projName, Var: name, Value: overrides[key],
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

var tokenPattern = regexp.MustCompile(`\{\{([a-z]+)(?::([^}]*))?\}\}`)

// Token is one {{kind:arg}} occurrence in a binding template.
type Token struct {
	Raw  string
	Kind string
	Arg  string
	// HasArg distinguishes "{{worktree:}}" (a colon with nothing after it, a
	// typo) from "{{worktree}}".
	HasArg bool
}

// ParseTokens finds every token in a template. Pure.
//
// This is the one grammar; the validator in project and the resolver here both
// walk its output, so a token kind cannot be accepted at add time and then
// silently never expand at start time.
func ParseTokens(value string) []Token {
	var tokens []Token
	for _, m := range tokenPattern.FindAllStringSubmatch(value, -1) {
		tokens = append(tokens, Token{
			Raw:    m[0],
			Kind:   m[1],
			Arg:    m[2],
			HasArg: strings.Contains(m[0], ":"),
		})
	}
	return tokens
}

// TargetRef is a parsed "proj[/server]" token argument.
type TargetRef struct {
	Project   string
	Server    string
	HasServer bool
}

// ParseTarget splits a {{url:…}} / {{port:…}} argument. Pure.
func ParseTarget(arg string) (TargetRef, error) {
	if arg == "" {
		return TargetRef{}, fmt.Errorf("missing target — expected {{url:project}} or {{url:project/server}}")
	}
	proj, server, hasServer := strings.Cut(arg, "/")
	return TargetRef{Project: proj, Server: server, HasServer: hasServer}, nil
}

// AmbiguousTargetError is the message both validation and resolution give for a
// bare project reference that has more than one dev server.
func AmbiguousTargetError(proj string, count int, names string) error {
	return fmt.Errorf("%s has %d dev servers — name one, as %s/<server> (has: %s)", proj, count, proj, names)
}

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
// server, which is the common case and what the scan proposes.
//
// An unresolvable token fails the whole expansion rather than leaving a hole:
// a half-expanded value that reaches a process is exactly the silently-wrong
// URL this feature exists to prevent.
func ExpandTemplate(value string, ctx TemplateContext) (string, error) {
	expanded := value
	for _, tok := range ParseTokens(value) {
		replacement, err := ctx.expand(tok)
		if err != nil {
			return "", err
		}
		expanded = strings.Replace(expanded, tok.Raw, replacement, 1)
	}
	return expanded, nil
}

func (ctx TemplateContext) expand(tok Token) (string, error) {
	switch tok.Kind {
	case "worktree":
		if ctx.Worktree == "" {
			return "", fmt.Errorf("{{worktree}} is unavailable — workspace has no worktrees")
		}
		return ctx.Worktree, nil

	case "workspace":
		return ctx.Workspace, nil

	case "port", "url":
		port, err := ctx.lookupPort(tok.Arg)
		if err != nil {
			return "", err
		}
		if tok.Kind == "url" {
			return fmt.Sprintf("http://localhost:%d", port), nil
		}
		return strconv.Itoa(port), nil

	default:
		return "", fmt.Errorf("unknown token {{%s}}", tok.Kind)
	}
}

// lookupPort resolves a "proj[/server]" reference against the running servers.
func (ctx TemplateContext) lookupPort(arg string) (int, error) {
	target, err := ParseTarget(arg)
	if err != nil {
		return 0, err
	}

	if !ctx.InWorktree[target.Project] {
		return 0, fmt.Errorf("%s not in workspace", target.Project)
	}

	if target.HasServer {
		port, ok := ctx.Ports[ProjectServer{Project: target.Project, Server: target.Server}]
		if !ok {
			return 0, fmt.Errorf("%s/%s is not running", target.Project, target.Server)
		}
		return port, nil
	}

	// Bare project reference: unambiguous only when it owns one running server.
	var found int
	var names []string
	for ps, port := range ctx.Ports {
		if ps.Project == target.Project {
			found = port
			names = append(names, ps.Server)
		}
	}
	switch len(names) {
	case 0:
		return 0, fmt.Errorf("%s has no running dev server", target.Project)
	case 1:
		return found, nil
	default:
		sort.Strings(names)
		return 0, AmbiguousTargetError(target.Project, len(names), strings.Join(names, ", "))
	}
}

// describeTemplate names a template's source for the resolution table, in the
// "from project (server)" form. "a/b" already means workspace/worktree in the
// same output, so it is deliberately not reused here.
func describeTemplate(value string) string {
	tokens := ParseTokens(value)
	if len(tokens) == 0 {
		return "literal"
	}
	tok := tokens[0]
	switch tok.Kind {
	case "port", "url":
		target, err := ParseTarget(tok.Arg)
		if err != nil {
			return "literal"
		}
		if target.HasServer {
			return fmt.Sprintf("from %s (%s)", target.Project, target.Server)
		}
		return "from " + target.Project
	default:
		return "{{" + tok.Kind + "}}"
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
