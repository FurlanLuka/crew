package main

import (
	"fmt"
	"os"
	osexec "os/exec"
	"syscall"

	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// mustResolveProject resolves a worktree and confirms the project is in it.
func mustResolveProject(refArg, projName string) (*workspace.Resolved, workspace.ResolvedProject, []dev.Resolution) {
	res := mustResolve(refArg)

	p, ok := res.Project(projName)
	if !ok {
		fmt.Fprintf(os.Stderr, "Error: project '%s' is not in %s\n", projName, res.Ref)
		fmt.Fprintf(os.Stderr, "Projects: %s\n", res.ProjectNames())
		os.Exit(1)
	}

	return res, p, dev.GroupResolutions(res.ResolveEnv())[projName]
}

func cmdEnv() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew env <workspace>[/<worktree>] <project>\n")
		os.Exit(1)
	}

	res, _, resolutions := mustResolveProject(os.Args[2], os.Args[3])

	if jsonOutput {
		type envOut struct {
			Var    string `json:"var"`
			Value  string `json:"value"`
			Source string `json:"source"`
			Detail string `json:"detail"`
		}
		out := []envOut{}
		for _, r := range resolutions {
			out = append(out, envOut{Var: r.Var, Value: r.Value, Source: string(r.Source), Detail: r.Detail})
		}
		printJSON(out)
		return
	}

	// stdout stays pure KEY=VALUE so `eval "$(crew env ws/wt proj)"` works;
	// everything a human reads goes to stderr.
	for _, line := range dev.EnvLines(resolutions) {
		fmt.Println(line)
	}

	if table := dev.FormatEnvTable(resolutions); table != "" {
		fmt.Fprintf(os.Stderr, "\n%s\n", res.Ref)
		fmt.Fprint(os.Stderr, table)
	}
	fmt.Fprintf(os.Stderr, "\nValues are point-in-time and go stale when servers restart —\n")
	fmt.Fprintf(os.Stderr, "prefer `crew run %s %s -- <cmd>` over pasting them into a file.\n", res.Ref, os.Args[3])
}

// splitRunArgs parses `<ref> <project> -- <cmd...>`. Pure.
func splitRunArgs(args []string) (ref, projName string, command []string, err error) {
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
	usage := "Usage: crew run <workspace>[/<worktree>] <project> -- <command...>\n"

	refArg, projName, command, err := splitRunArgs(os.Args[2:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n%s", err, usage)
		os.Exit(1)
	}

	res, proj, resolutions := mustResolveProject(refArg, projName)
	projPath := proj.Path

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
			fmt.Fprintf(os.Stderr, "crew: %s left alone — %s\n", r.Var, r.Detail)
		}
	}

	if err := os.Chdir(projPath); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if err := syscall.Exec(binary, command, env); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
