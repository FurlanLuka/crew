package main

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/transfer"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// exportArgs is what crew export was told. No flags means the picker.
type exportArgs struct {
	file       string
	all        bool
	projects   []string
	workspaces []string
}

func parseExportArgs(args []string) (exportArgs, error) {
	var a exportArgs
	for _, arg := range args {
		switch {
		case arg == "--all":
			a.all = true
		case strings.HasPrefix(arg, "--projects="):
			a.projects = splitList(strings.TrimPrefix(arg, "--projects="))
		case strings.HasPrefix(arg, "--workspaces="):
			a.workspaces = splitList(strings.TrimPrefix(arg, "--workspaces="))
		case strings.HasPrefix(arg, "-"):
			return a, fmt.Errorf("unknown flag '%s'", arg)
		case a.file != "":
			return a, fmt.Errorf("one file at most, got '%s' and '%s'", a.file, arg)
		default:
			a.file = arg
		}
	}
	if a.file == "" {
		a.file = transfer.DefaultExportFile
	}
	if a.all && (len(a.projects) > 0 || len(a.workspaces) > 0) {
		return a, errors.New("--all takes everything; drop --projects/--workspaces")
	}
	if len(a.workspaces) > 0 && len(a.projects) == 0 {
		return a, errors.New("--workspaces needs --projects naming every project they use")
	}
	return a, nil
}

func splitList(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

func (a exportArgs) interactive() bool { return !a.all && len(a.projects) == 0 }

func cmdExport() {
	a, err := parseExportArgs(os.Args[2:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if a.interactive() {
		runTUI(transfer.NewExportView(a.file))
		return
	}

	projNames, wsNames := a.projects, a.workspaces
	if a.all {
		var err error
		if projNames, wsNames, err = everything(); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
	} else if len(wsNames) > 0 {
		// A named workspace has to be covered, the same rule the picker uses.
		chosen := map[string]bool{}
		for _, n := range projNames {
			chosen[n] = true
		}
		for _, name := range wsNames {
			ws, err := workspace.Load(name)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: workspace %s: %v\n", name, err)
				os.Exit(1)
			}
			if missing := transfer.Uncovered(ws, chosen); len(missing) > 0 {
				fmt.Fprintf(os.Stderr, "Error: workspace %s needs %s — add them to --projects\n", name, strings.Join(missing, ", "))
				os.Exit(1)
			}
		}
	}

	b, err := transfer.Collect(projNames, wsNames)
	if err == nil {
		err = transfer.Write(a.file, b)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if jsonOutput {
		printJSON(map[string]any{"file": a.file, "projects": len(b.Projects), "workspaces": len(b.Workspaces)})
		return
	}
	fmt.Printf("Wrote %s — %d projects, %d workspaces\n", a.file, len(b.Projects), len(b.Workspaces))
}

func everything() (projNames, wsNames []string, err error) {
	pool, err := project.List()
	if err != nil {
		return nil, nil, err
	}
	for _, p := range pool {
		projNames = append(projNames, p.Name)
	}
	wsNames, err = workspace.List()
	return projNames, wsNames, err
}

func cmdImport() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew import <file> [--all]\n")
		os.Exit(1)
	}
	file, all := "", false
	for _, arg := range os.Args[2:] {
		switch {
		case arg == "--all":
			all = true
		case strings.HasPrefix(arg, "-"):
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
			os.Exit(1)
		default:
			file = arg
		}
	}
	b, err := transfer.Read(file)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if !all {
		runTUI(transfer.NewImportView(file, b))
		return
	}
	importAll(file, b)
}

// importAll is the non-interactive path: everything whose name is new, and
// only if every path is here — it never guesses and never clones.
func importAll(file string, b transfer.Bundle) {
	plan := transfer.Inspect(b)
	if missing := transfer.MissingPaths(b, plan); len(missing) > 0 {
		lines := make([]string, 0, len(missing))
		for _, e := range missing {
			lines = append(lines, fmt.Sprintf("  %s\t%s", e.Name, e.Path))
		}
		fmt.Fprintf(os.Stderr, "Error: these paths do not exist here; run crew import %s without --all to fix them one by one:\n%s\n", file, strings.Join(lines, "\n"))
		os.Exit(1)
	}

	present := plan.Known
	for i, e := range b.Projects {
		if plan.Projects[i].Exists {
			fmt.Printf("%s\tkept local\n", e.Name)
			continue
		}
		if err := transfer.ImportProject(e.Name, e.Project, false); err != nil {
			fmt.Printf("%s\tfailed\t%v\n", e.Name, err)
			continue
		}
		fmt.Printf("%s\timported\n", e.Name)
		present[e.Name] = true
	}
	for i, m := range b.Workspaces {
		if plan.Workspaces[i].Exists {
			fmt.Printf("%s\tkept local\n", m.Name)
			continue
		}
		if need := transfer.MissingMembers(m, present); len(need) > 0 {
			fmt.Printf("%s\tskipped\tneeds %s\n", m.Name, strings.Join(need, ", "))
			continue
		}
		if err := transfer.ImportWorkspace(m, nil); err != nil {
			fmt.Printf("%s\tfailed\t%v\n", m.Name, err)
			continue
		}
		fmt.Printf("%s\tcreated\n", m.Name)
	}
}
