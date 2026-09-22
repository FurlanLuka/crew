package main

import (
	"fmt"
	"os"
	osexec "os/exec"
	"strings"
	"syscall"

	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// resolvedTarget is `<project>[/<server>]` of a worktree, with the
// project's every resolution: Env() is the set one server gets — or the
// project-wide set when no server was named.
type resolvedTarget struct {
	Res    *workspace.Resolved
	Proj   workspace.ResolvedProject
	Target dev.ProjectServer
	Rows   []dev.Resolution
}

func (t resolvedTarget) Env() []dev.Resolution { return dev.EnvFor(t.Rows, t.Target) }

// resolveTarget is the pure half of mustResolveTarget: the argument parsed,
// the project found in the worktree, the server found on the project, the
// project's rows picked out of the worktree's.
func resolveTarget(res *workspace.Resolved, rows []dev.Resolution, targetArg string) (resolvedTarget, error) {
	target, err := dev.ParseTarget(targetArg)
	if err != nil {
		return resolvedTarget{}, err
	}
	p, ok := res.Project(target.Project)
	if !ok {
		return resolvedTarget{}, fmt.Errorf("project '%s' is not in %s\nProjects: %s", target.Project, res.Ref, res.ProjectNames())
	}
	if target.HasServer {
		if _, err := project.FindServer(p.Name, p.DevServers, target.Server); err != nil {
			return resolvedTarget{}, err
		}
	}
	return resolvedTarget{
		Res:    res,
		Proj:   p,
		Target: dev.ProjectServer{Project: target.Project, Server: target.Server},
		Rows:   dev.GroupResolutions(rows)[target.Project],
	}, nil
}

// mustResolveTarget resolves a worktree and the `<project>[/<server>]` in it.
func mustResolveTarget(refArg, targetArg string) resolvedTarget {
	res := mustResolve(refArg)
	t, err := resolveTarget(res, res.ResolveEnv(), targetArg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	return t
}

// scopedHint is the stderr line under a bare project's env: which servers
// have their own set, and how to see one.
func scopedHint(t resolvedTarget) string {
	if t.Target.Server != "" {
		return ""
	}
	servers := dev.ScopedServers(t.Rows)
	if len(servers) == 0 {
		return ""
	}
	var forms []string
	for _, s := range servers {
		forms = append(forms, fmt.Sprintf("crew env %s %s/%s", t.Res.Ref, t.Proj.Name, s))
	}
	return fmt.Sprintf("  some vars are bound per server (%s) — %s\n", strings.Join(servers, ", "), strings.Join(forms, " · "))
}

func cmdEnv() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew env <workspace>[/<worktree>] <project>[/<server>]\n")
		os.Exit(1)
	}

	t := mustResolveTarget(os.Args[2], os.Args[3])
	resolutions := t.Env()

	if jsonOutput {
		type envOut struct {
			Var    string `json:"var"`
			Server string `json:"server"`
			Value  string `json:"value"`
			Source string `json:"source"`
			Detail string `json:"detail"`
		}
		out := []envOut{}
		for _, r := range resolutions {
			out = append(out, envOut{Var: r.Var, Server: r.Server, Value: r.Value, Source: string(r.Source), Detail: r.Detail})
		}
		printJSON(out)
		return
	}

	// stdout stays pure KEY=VALUE so `eval "$(crew env ws/wt proj)"` works;
	// everything a human reads goes to stderr. A bare project is its
	// project-wide set — a var bound for one server only is not on stdout,
	// the table says so and names the per-server form.
	for _, line := range dev.EnvLines(resolutions) {
		fmt.Println(line)
	}

	if table := dev.FormatEnvTable(t.Rows); table != "" {
		fmt.Fprintf(os.Stderr, "\n%s %s\n", t.Res.Ref, t.Target)
		fmt.Fprint(os.Stderr, table)
		fmt.Fprint(os.Stderr, scopedHint(t))
	}
	fmt.Fprintf(os.Stderr, "\nValues are point-in-time and go stale when servers restart —\n")
	fmt.Fprintf(os.Stderr, "prefer `crew run %s %s -- <cmd>` over pasting them into a file.\n", t.Res.Ref, os.Args[3])
}

// splitRunArgs parses `<ref> <project>[/<server>] -- <cmd...>`; the target
// is passed through as typed. Pure.
func splitRunArgs(args []string) (ref, target string, command []string, err error) {
	for i, a := range args {
		if a != "--" {
			continue
		}
		if i < 2 {
			return "", "", nil, fmt.Errorf("missing workspace or project before '--'")
		}
		if i+1 >= len(args) {
			return "", "", nil, fmt.Errorf("no command after '--'")
		}
		return args[0], args[1], args[i+1:], nil
	}
	return "", "", nil, fmt.Errorf("missing '--' before the command")
}

func cmdRun() {
	usage := "Usage: crew run <workspace>[/<worktree>] <project>[/<server>] -- <command...>\n"

	refArg, targetArg, command, err := splitRunArgs(os.Args[2:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n%s", err, usage)
		os.Exit(1)
	}

	t := mustResolveTarget(refArg, targetArg)
	res, resolutions := t.Res, t.Env()
	projPath := t.Proj.Path

	binary, err := osexec.LookPath(command[0])
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	env := os.Environ()
	injected := 0
	for _, r := range resolutions {
		if !r.Resolved() {
			continue
		}
		env = append(env, r.Var+"="+r.Value)
		injected++
	}

	dev.LogResolutions(res.Slug, resolutions)
	debug.Log("dev", "run %s in %s (%s) with %d injected vars", command[0], projPath, res.Ref, injected)

	// Warn about anything crew could not resolve before handing the terminal
	// over — once exec replaces this process there is no chance to say it.
	for _, r := range resolutions {
		if !r.Resolved() {
			fmt.Fprintf(os.Stderr, "crew: %s left alone — %s\n", r.Label(), r.Detail)
		}
	}
	fmt.Fprint(os.Stderr, scopedHint(t))

	if err := os.Chdir(projPath); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if err := syscall.Exec(binary, command, env); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
