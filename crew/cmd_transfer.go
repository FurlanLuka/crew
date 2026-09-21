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
		if projNames == nil {
			projNames = []string{}
		}
		if wsNames == nil {
			wsNames = []string{}
		}
		printJSON(map[string]any{"file": a.file, "projects": projNames, "workspaces": wsNames})
		return
	}
	fmt.Printf("Wrote %s — %s\n", a.file, transfer.CountPhrase(len(b.Projects), len(b.Workspaces)))
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

// importArgs is what crew import was told. No mode means the wizard.
type importArgs struct {
	file    string
	plan    bool
	all     bool
	item    string // "project" | "workspace" | ""
	name    string
	project transfer.ProjectOptions
}

func parseImportArgs(args []string) (importArgs, error) {
	var a importArgs
	for _, arg := range args {
		switch {
		case arg == "--plan":
			a.plan = true
		case arg == "--all":
			a.all = true
		case arg == "--clone":
			a.project.Clone = true
		case strings.HasPrefix(arg, "--clone="):
			a.project.Clone, a.project.CloneTo = true, strings.TrimPrefix(arg, "--clone=")
		case arg == "--replace":
			a.project.Replace = true
		case strings.HasPrefix(arg, "--path="):
			a.project.Path = strings.TrimPrefix(arg, "--path=")
		case strings.HasPrefix(arg, "--name="):
			a.project.Name = strings.TrimPrefix(arg, "--name=")
		case strings.HasPrefix(arg, "--setup="):
			a.project.Setup = strings.TrimPrefix(arg, "--setup=")
		case strings.HasPrefix(arg, "-"):
			return a, fmt.Errorf("unknown flag '%s'", arg)
		case a.file == "":
			a.file = arg
		case a.item == "" && (arg == "project" || arg == "workspace"):
			a.item = arg
		case a.item != "" && a.name == "":
			a.name = arg
		default:
			return a, fmt.Errorf("unexpected argument '%s'", arg)
		}
	}
	if a.file == "" {
		return a, errors.New("a bundle file is needed")
	}
	if a.item != "" && a.name == "" {
		return a, fmt.Errorf("%s needs a name", a.item)
	}
	modes := 0
	for _, on := range []bool{a.plan, a.all, a.item != ""} {
		if on {
			modes++
		}
	}
	if modes > 1 {
		return a, errors.New("one of --plan, --all, project <name>, workspace <name>")
	}
	if a.item != "project" && (a.project.Path != "" || a.project.CloneTo != "" || a.project.Name != "" || a.project.Setup != "") {
		return a, errors.New("--path, --clone=<dir>, --name and --setup belong to import <file> project <name>")
	}
	if a.item == "workspace" && (a.project.Clone || a.project.Replace) {
		return a, errors.New("--clone and --replace belong to project imports")
	}
	if !a.all && a.item != "project" && (a.project.Clone || a.project.Replace) {
		return a, errors.New("--clone and --replace need --all or project <name>")
	}
	return a, nil
}

func cmdImport() {
	a, err := parseImportArgs(os.Args[2:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\nUsage: crew import <file> [--plan | --all [--clone] [--replace] | project <name> [--path=<dir>] [--clone[=<dir>]] [--replace] [--name=<new>] [--setup=<cmd>] | workspace <name>]\n", err)
		os.Exit(1)
	}
	b, err := transfer.Read(a.file)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	switch {
	case a.plan:
		printImportRows(transfer.PlanRows(b, transfer.Inspect(b)))
	case a.item == "project":
		res, err := transfer.ApplyProject(b, transfer.Inspect(b), a.name, a.project)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		printImportRows([]transfer.PlanRow{{Kind: "project", Name: res.Name, Status: outcomeWord(res), Detail: res.Path}})
	case a.item == "workspace":
		if err := transfer.ApplyWorkspace(b, a.name); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		printImportRows([]transfer.PlanRow{{Kind: "workspace", Name: a.name, Status: "created"}})
	case a.all:
		importAll(a.file, b, a.project)
	default:
		runTUI(transfer.NewImportView(a.file, b))
	}
}

// outcomeWord is the outcome column for a project. The parenthetical says
// a checkout was made, which is what a reader wants to know before deleting
// anything.
func outcomeWord(res transfer.ProjectResult) string {
	switch {
	case res.Replaced && res.Cloned:
		return "replaced (cloned)"
	case res.Replaced:
		return "replaced"
	case res.Cloned:
		return "imported (cloned)"
	}
	return "imported"
}

// printImportRows is the one shape every import mode prints: the plan's
// rows, with Status carrying the outcome once something was done.
func printImportRows(rows []transfer.PlanRow) {
	if jsonOutput {
		printJSON(rows)
		return
	}
	for _, r := range rows {
		fmt.Printf("%s\t%s\t%s\t%s\n", r.Kind, r.Name, r.Status, r.Detail)
	}
}

// importAll is the non-interactive path. By default it takes only what is
// new and already here, and refuses up front if any path is missing — never
// guessing. --clone lets a missing repo be cloned where a card would offer,
// --replace swaps records of the same name.
func importAll(file string, b transfer.Bundle, o transfer.ProjectOptions) {
	plan := transfer.Inspect(b)
	if missing := transfer.MissingPaths(b, plan); len(missing) > 0 && !o.Clone {
		lines := make([]string, 0, len(missing))
		for _, e := range missing {
			lines = append(lines, fmt.Sprintf("  %s\t%s", e.Name, e.Path))
		}
		fmt.Fprintf(os.Stderr, "Error: these paths do not exist here; add --clone, or run crew import %s without --all to fix them one by one:\n%s\n", file, strings.Join(lines, "\n"))
		os.Exit(1)
	}

	rows := make([]transfer.PlanRow, 0, len(b.Projects)+len(b.Workspaces))
	for i, e := range b.Projects {
		if plan.Projects[i].Exists && !o.Replace {
			rows = append(rows, transfer.PlanRow{Kind: "project", Name: e.Name, Status: "kept local"})
			continue
		}
		res, err := transfer.ApplyProject(b, plan, e.Name, o)
		if err != nil {
			rows = append(rows, transfer.PlanRow{Kind: "project", Name: e.Name, Status: "failed", Detail: err.Error()})
			continue
		}
		rows = append(rows, transfer.PlanRow{Kind: "project", Name: e.Name, Status: outcomeWord(res), Detail: res.Path})
	}
	for i, m := range b.Workspaces {
		if plan.Workspaces[i].Exists {
			rows = append(rows, transfer.PlanRow{Kind: "workspace", Name: m.Name, Status: "kept local"})
			continue
		}
		if err := transfer.ApplyWorkspace(b, m.Name); err != nil {
			rows = append(rows, transfer.PlanRow{Kind: "workspace", Name: m.Name, Status: "failed", Detail: err.Error()})
			continue
		}
		rows = append(rows, transfer.PlanRow{Kind: "workspace", Name: m.Name, Status: "created"})
	}
	printImportRows(rows)
}
