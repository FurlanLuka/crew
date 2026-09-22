package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	osexec "os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/addproject"
	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/help"
	"github.com/FurlanLuka/crew/crew/internal/housekeeping"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/settings"
	"github.com/FurlanLuka/crew/crew/internal/transfer"
	"github.com/FurlanLuka/crew/crew/internal/trash"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

var Version = "dev"

// jsonOutput is set once at startup from the global --json flag and read by
// list/show commands to emit JSON instead of tab-separated output.
var jsonOutput bool

// human is where progress and narration go: stdout normally, stderr under
// --json so the document on stdout stays parseable.
var human io.Writer = os.Stdout

// parseIntFlag reads a flag value strictly: Sscanf's %d would take "30x0"
// as 30. positive rejects zero and below for counts (--tail, --lines). Pure.
func parseIntFlag(raw string, positive bool) (int, error) {
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || (positive && n <= 0) {
		what := "a number"
		if positive {
			what = "a positive number"
		}
		return 0, fmt.Errorf("needs %s, got '%s'", what, raw)
	}
	return n, nil
}

// intFlag is parseIntFlag for a command: the message names the flag and
// the process ends, the way every other bad argument ends.
func intFlag(name, raw string, positive bool) int {
	n, err := parseIntFlag(raw, positive)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s %v\n", name, err)
		os.Exit(1)
	}
	return n
}

// extractFlag returns args with all occurrences of flag removed, plus whether
// it was present.
// extractFlag pulls a global flag out of argv wherever it appears.
//
// It stops at "--": everything after that belongs to a child process (see
// `crew run`), so `crew run ws/wt proj -- node --json` has to leave the child's
// flag alone rather than eating it and switching crew to JSON output.
func extractFlag(args []string, flag string) ([]string, bool) {
	out := make([]string, 0, len(args))
	found := false
	for i, a := range args {
		if a == "--" {
			out = append(out, args[i:]...)
			break
		}
		if a == flag {
			found = true
			continue
		}
		out = append(out, a)
	}
	return out, found
}

func printJSON(v any) {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(string(data))
}

func main() {
	config.Init()
	project.Previewer = workspace.PreviewBinding
	project.CheckoutDirs = workspace.ProjectCheckouts
	project.AddWizard = addproject.New

	// Strip the global --json flag before computing cmd so it works in any
	// position and is not rejected by strict per-command arg parsers.
	os.Args, jsonOutput = extractFlag(os.Args, "--json")
	if jsonOutput {
		human = os.Stderr
	}

	cmd := ""
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}

	housekeeping.SweepOnStart(os.Args[1:])

	// Check for updates in background (skip for dev builds and update command)
	var updateCh chan string
	if Version != "dev" && cmd != "update" {
		updateCh = make(chan string, 1)
		go func() {
			latest, err := fetchLatestVersion()
			if err != nil || latest == Version {
				updateCh <- ""
				return
			}
			updateCh <- latest
		}()
	}
	defer func() {
		if updateCh == nil {
			return
		}
		select {
		case latest := <-updateCh:
			if latest != "" {
				fmt.Fprintf(os.Stderr, "\nUpdate available: v%s → v%s (run 'crew update')\n", Version, latest)
			}
		default:
		}
	}()

	switch cmd {
	case "--version", "-v":
		fmt.Println("crew " + Version)
		return

	case "config":
		if len(os.Args) > 2 {
			cmdConfig()
			return
		}
		runTUI(settings.NewView())

	case "workspace":
		runTUI(workspace.NewView())

	case "project":
		runTUI(project.NewView())

	case "add":
		cmdAdd()
		return

	case "ls":
		cmdLs()
		return

	case "ps":
		cmdPs()
		return

	case "kill":
		cmdKill()
		return

	case "start":
		cmdStart()
		return

	case "env":
		cmdEnv()
		return

	case "run":
		cmdRun()
		return

	case "migrate":
		cmdMigrate()
		return

	case "export":
		cmdExport()
		return

	case "import":
		cmdImport()
		return

	case "uninstall":
		cmdUninstall()
		return

	case "setup":
		cmdSetup()
		return

	case "check":
		cmdCheck()
		return

	case "_setup":
		cmdSetupRunner()
		return

	case "dev":
		cmdDev()
		return

	case "debug":
		cmdDebug()
		return

	case "launch":
		cmdLaunch()
		return

	case "duplicate":
		cmdDuplicate()
		return

	case "rm":
		cmdRm()
		return

	case "code":
		cmdCode()
		return

	case "open":
		cmdOpen()
		return

	case "claude":
		cmdClaude()
		return

	case "verify":
		cmdVerify()
		return

	case "fix":
		cmdFix()
		return

	case "edit":
		cmdEdit()
		return

	case "trash":
		cmdTrash()
		return

	case "clean":
		cmdClean()
		return

	case "show":
		cmdShow()
		return

	case "update":
		cmdUpdate()
		return

	case "help":
		help.Run(os.Args[2:], jsonOutput)
		return

	case "":
		runTUI(mainMenu())

	default:
		// Try as workspace/worktree ref shortcut (launch directly)
		if ref, err := workspace.ParseRef(cmd); err == nil && workspace.Addressable(ref) {
			runTUI(workspace.NewWorktreeView(mustResolve(ref.String()).Ref))
		} else {
			fmt.Fprintf(os.Stderr, "Unknown command '%s'. Run 'crew help' for usage.\n", cmd)
			os.Exit(1)
		}
	}
}

func mainMenu() app.Menu {
	return app.NewMenu([]app.MenuItem{
		{
			Label:       "Workspace",
			Description: "Manage workspaces and launch",
			Page:        func() app.Page { return workspace.NewView() },
		},
		{
			Label:       "Project",
			Description: "Add/remove projects and configure dev servers",
			Page:        func() app.Page { return project.NewView() },
		},
		{
			Label:       "Export",
			Description: "Pick projects and workspaces to carry to another machine",
			Page:        func() app.Page { return transfer.NewExportView("") },
		},
		{
			Label:       "Settings",
			Description: "Server IP, SSH host, managed configs",
			Page:        func() app.Page { return settings.NewView() },
		},
		{
			Label:       "Debug",
			Description: "View debug log",
			Page:        func() app.Page { return debug.NewView() },
		},
	})
}

func runTUI(page app.Page) {
	a := app.New(page)
	p := tea.NewProgram(a, tea.WithAltScreen(), tea.WithMouseCellMotion())
	m, err := p.Run()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if final, ok := m.(app.App); ok && final.ExitOutput != "" {
		fmt.Println(final.ExitOutput)
	}
}

// mustResolve turns a "<workspace>[/<worktree>]" argument into a resolved
// worktree, or exits with the parse/lookup error. Every command taking a
// workspace argument goes through here so the "which worktree did you mean"
// message is written once.
func mustResolve(arg string) *workspace.Resolved {
	ref, err := workspace.ParseRef(arg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	res, err := workspace.Resolve(ref)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	return res
}

func cmdLs() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew ls [projects|workspaces|worktrees|bindings|overrides]\n")
		os.Exit(1)
	}

	switch os.Args[2] {
	case "projects":
		cmdLsProjects()
	case "workspaces":
		cmdLsWorkspaces()
	case "worktrees":
		cmdLsWorktrees()
	case "bindings":
		cmdLsBindings()
	case "overrides":
		cmdLsOverrides()
	default:
		fmt.Fprintf(os.Stderr, "Unknown ls target '%s'.\nUsage: crew ls [projects|workspaces|worktrees|bindings|overrides]\n", os.Args[2])
		os.Exit(1)
	}
}

func cmdLsProjects() {
	projects, err := project.List()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	// The remote is read off each checkout — one git call per row, which a
	// list can afford; it is the project's identity and the export's.
	type projectOut struct {
		project.Project
		Remote string `json:"remote"`
	}
	out := []projectOut{}
	for _, p := range projects {
		out = append(out, projectOut{Project: p, Remote: project.RemoteOf(p)})
	}
	if jsonOutput {
		printJSON(out)
		return
	}
	for _, p := range out {
		fmt.Println(projectLine(p.Project, p.Remote))
	}
}

// projectLine is one row of crew ls projects: name, path, remote or "-".
func projectLine(p project.Project, remote string) string {
	if remote == "" {
		remote = "-"
	}
	return p.Name + "\t" + p.Path + "\t" + remote
}

func cmdLsWorkspaces() {
	names, err := workspace.List()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	type workspaceOut struct {
		Name         string   `json:"name"`
		ProjectCount int      `json:"project_count"`
		Worktrees    []string `json:"worktrees"`
		DevRunning   bool     `json:"dev_running"`
	}

	out := []workspaceOut{}
	for _, name := range names {
		ws, err := workspace.Load(name)
		if err != nil {
			continue
		}
		row := workspaceOut{Name: name, ProjectCount: len(ws.Projects), Worktrees: []string{}}
		for _, ref := range workspace.Refs(ws) {
			row.Worktrees = append(row.Worktrees, ref.Worktree)
			if dev.Running(ref.Slug()) {
				row.DevRunning = true
			}
		}
		out = append(out, row)
	}

	if jsonOutput {
		printJSON(out)
		return
	}
	for _, w := range out {
		fmt.Printf("%s\t%d projects\t%s\n", w.Name, w.ProjectCount, strings.Join(w.Worktrees, ","))
	}
}

func cmdOpen() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew open <workspace>\n")
		os.Exit(1)
	}

	requireTerminal("open", "crew show <ref> prints every checkout's path")
	res := mustResolve(os.Args[2])

	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	shellPath, err := osexec.LookPath(shell)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: shell not found: %v\n", err)
		os.Exit(1)
	}

	dir := res.Dir
	if err := os.Chdir(dir); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	debug.Log("open", "exec %s in %s", shellPath, dir)
	if err := syscall.Exec(shellPath, []string{shell}, os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func cmdCode() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew code <workspace>[/<worktree>]\n")
		os.Exit(1)
	}

	wsName := os.Args[2]

	settings := config.LoadSettings()
	if settings.SSHHost == "" {
		fmt.Fprintf(os.Stderr, "Error: ssh_host not configured\nSet it in %s:\n  {\"ssh_host\": \"your-host-alias\"}\n", config.SettingsFilePath())
		os.Exit(1)
	}

	links, err := workspace.EditorLinks(mustResolve(wsName), settings.SSHHost)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Print(links)
}

func cmdShow() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew show <workspace>\n")
		os.Exit(1)
	}

	wsName := os.Args[2]

	res := mustResolve(wsName)

	type wsProjectOut struct {
		Name string `json:"name"`
		Path string `json:"path"`
		Mode string `json:"mode"`
		Role string `json:"role"`
	}

	out := []wsProjectOut{}
	for _, p := range res.Projects {
		mode := "worktree"
		if p.Direct {
			mode = "direct"
		}
		out = append(out, wsProjectOut{Name: p.Name, Path: p.Path, Mode: mode, Role: p.Role})
	}

	if jsonOutput {
		printJSON(out)
		return
	}
	for _, p := range out {
		fmt.Printf("%s\t%s\t%s\t%s\n", p.Name, p.Path, p.Mode, p.Role)
	}
}

func cmdStart() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew start <workspace>\n")
		os.Exit(1)
	}

	wsName := os.Args[2]

	prompt, err := workspace.GeneratePrompt(mustResolve(wsName))
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Print(prompt)
}

// cmdDuplicate copies a worktree within its workspace. This is what
// duplicating a workspace was actually being used for — a second working copy
// of the same projects — and a worktree is now the thing that is.
func cmdDuplicate() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew duplicate <workspace>[/<worktree>] <new-worktree> [--no-install] [--no-smoke] [--wait]\n")
		os.Exit(1)
	}

	src := mustResolve(os.Args[2]).Ref
	newName := os.Args[3]

	f := parseSetupFlags(os.Args[4:], false)
	fmt.Fprintf(human, "Duplicating %s → %s/%s\n", src, src.Workspace, newName)
	if err := workspace.DuplicateWorktree(src, newName, f.checkoutOptions()); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	dst := workspace.Ref{Workspace: src.Workspace, Worktree: newName}
	landOn(dst, fmt.Sprintf("Duplicated %s → %s", src, dst), f.wait)
}

func cmdRm() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew rm <workspace> | crew rm project <name> | crew rm workspace <ws> <project>\n")
		os.Exit(1)
	}

	switch os.Args[2] {
	case "project":
		cmdRmProject()
		return
	case "workspace":
		cmdRmWorkspaceProject()
		return
	case "worktree":
		cmdRmWorktree()
		return
	case "binding":
		cmdRmBinding()
		return
	case "override":
		cmdRmOverride()
		return
	}

	// Default: remove entire workspace
	wsName := os.Args[2]

	if !workspace.Exists(wsName) {
		fmt.Fprintf(os.Stderr, "Error: workspace '%s' not found\n", wsName)
		os.Exit(1)
	}

	if ws, err := workspace.Load(wsName); err == nil {
		editor := exec.DetectEditor()
		for _, ref := range workspace.Refs(ws) {
			if _, err := os.Stat(workspace.CodeWorkspaceFilePath(ref)); err == nil {
				exec.CloseEditorWindow(exec.EditorProcessName(editor), string(ref.Slug()))
			}
		}
	}

	if err := workspace.Remove(wsName); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Removed workspace: %s\n", wsName)
}

func cmdRmProject() {
	name, purge, err := parseRmProjectArgs(os.Args[3:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\nUsage: crew rm project <name> [--purge]\n", err)
		os.Exit(1)
	}
	p := project.Get(name)
	if p == nil {
		fmt.Fprintf(os.Stderr, "Error: project '%s' not found\n", name)
		os.Exit(1)
	}
	if purge {
		members, _ := workspace.WorkspacesWith(name)
		if err := purgeAllowed(*p, members, workspace.CheckExists(name)); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
	}
	if err := project.Remove(name); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Removed project: %s\n", name)
	if !purge {
		if project.CrewOwned(*p) {
			fmt.Fprintf(human, "clone kept at %s — crew rm project %s --purge removes it\n", p.Path, name)
		}
		return
	}
	if _, err := trash.Put(p.Path); err != nil {
		// The pool entry is already gone; say where the clone still is.
		fmt.Fprintf(os.Stderr, "Error: %v — clone left at %s\n", err, p.Path)
		os.Exit(1)
	}
	trash.Sweep()
	fmt.Fprintf(human, "clone at %s moved to the trash\n", p.Path)
}

// parseRmProjectArgs reads `<name> [--purge]`. Pure.
func parseRmProjectArgs(args []string) (name string, purge bool, err error) {
	for _, arg := range args {
		switch {
		case arg == "--purge":
			purge = true
		case strings.HasPrefix(arg, "-"):
			return "", false, fmt.Errorf("unknown flag '%s'", arg)
		case name == "":
			name = arg
		default:
			return "", false, fmt.Errorf("unexpected argument '%s'", arg)
		}
	}
	if name == "" {
		return "", false, errors.New("a project name is needed")
	}
	return name, purge, nil
}

// purgeAllowed: only a clone crew made may be trashed, and not while any
// workspace still lists the project or a check of it is kept — a trashed
// canonical breaks every git worktree off it. Pure.
func purgeAllowed(p project.Project, members []string, hasCheck bool) error {
	if !project.CrewOwned(p) {
		return fmt.Errorf("%s is not a clone crew made (not under %s) — --purge never touches it", p.Path, config.ProjectsDir)
	}
	if len(members) > 0 {
		hints := make([]string, 0, len(members))
		for _, m := range members {
			hints = append(hints, "crew rm workspace "+m+" "+p.Name)
		}
		return fmt.Errorf("project '%s' is still in workspace %s — %s first", p.Name, strings.Join(members, ", "), strings.Join(hints, "; "))
	}
	if hasCheck {
		return fmt.Errorf("a check of '%s' is kept — crew rm worktree check/%s first", p.Name, p.Name)
	}
	return nil
}

func cmdRmWorkspaceProject() {
	if len(os.Args) < 5 {
		fmt.Fprintf(os.Stderr, "Usage: crew rm workspace <workspace> <project>\n")
		os.Exit(1)
	}
	wsName := os.Args[3]
	projName := os.Args[4]
	if err := workspace.RemoveProject(wsName, projName); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Removed %s from %s\n", projName, wsName)
}

func cmdAdd() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew add [project|workspace|worktree|binding] ...\n")
		os.Exit(1)
	}

	switch os.Args[2] {
	case "project":
		cmdAddProject()
	case "workspace":
		cmdAddWorkspace()
	case "worktree":
		cmdAddWorktree()
	case "binding":
		cmdAddBinding()
	case "override":
		cmdAddOverride()
	default:
		fmt.Fprintf(os.Stderr, "Unknown add target '%s'.\nUsage: crew add [project|workspace|worktree|binding|override]\n", os.Args[2])
		os.Exit(1)
	}
}

// addProjectArgs is what crew add project was told; the same command
// registers a new project and updates an existing one.
type addProjectArgs struct {
	name, url, setup string
	hasSetup         bool
	envCmd           string
	hasEnvCmd        bool
	// newPath: --path=<dir> — adopt a checkout you already have (new name),
	// or "the repo moved" (existing name).
	newPath string
}

func parseAddProjectArgs(args []string) (addProjectArgs, error) {
	var a addProjectArgs
	if len(args) == 0 {
		return a, errors.New("usage: crew add project <name> <url> | --path=<dir> [--setup=<cmd>] [--env-cmd=<cmd>]")
	}
	a.name = args[0]
	for _, arg := range args[1:] {
		switch {
		case strings.HasPrefix(arg, "--setup="):
			a.setup, a.hasSetup = strings.TrimPrefix(arg, "--setup="), true
		case strings.HasPrefix(arg, "--env-cmd="):
			a.envCmd, a.hasEnvCmd = strings.TrimPrefix(arg, "--env-cmd="), true
		case strings.HasPrefix(arg, "--path="):
			a.newPath = config.ExpandHome(strings.TrimPrefix(arg, "--path="))
		case strings.HasPrefix(arg, "-"):
			return a, fmt.Errorf("unknown flag '%s'", arg)
		case a.url != "":
			return a, fmt.Errorf("one url at most, got '%s' and '%s'", a.url, arg)
		default:
			a.url = arg
		}
	}
	return a, nil
}

// updatesExisting is the branch for a project already in the pool: only
// --setup, --env-cmd and --path mean anything, and at least one must be given.
func (a addProjectArgs) updatesExisting() error {
	if !a.hasSetup && !a.hasEnvCmd && a.newPath == "" {
		return fmt.Errorf("project '%s' already exists — pass --setup, --env-cmd or --path to change it", a.name)
	}
	return nil
}

func cmdAddProject() {
	a, err := parseAddProjectArgs(os.Args[3:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	name := a.name
	existing := project.Get(name)
	path, clone, err := addProjectTarget(a, existing)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if existing != nil {
		lines, err := applyProjectUpdate(a)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		for _, line := range lines {
			fmt.Println(line)
		}
		return
	}
	if clone {
		fmt.Fprintf(human, "Cloning %s → %s\n", a.url, path)
		if err := exec.Clone(a.url, path); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
	}
	p := project.Project{Name: name, Path: path, Setup: a.setup, EnvCmd: a.envCmd}
	if err := project.Add(p); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Added project: %s (%s)\n", name, path)
	if steps := workspace.SetupStepsFor(p); len(steps) > 0 {
		fmt.Printf("New checkouts will run: %s\n", exec.StepLine(steps))
	}
}

// addProjectTarget is crew add project's reading of its flags: a URL
// clones (the default), --path adopts, a bare path is refused so "the
// default is a clone" stays true, a URL cannot ride along with --path. The
// rules both entry points share — the name (taken or not: a URL cannot
// update a project, the clone is the fact), the clone dir, the adopted
// directory — are project.NewTarget's. An existing project with --path is
// the update case — the caller's.
func addProjectTarget(a addProjectArgs, existing *project.Project) (path string, clone bool, err error) {
	switch {
	case a.url != "" && !exec.IsGitURL(a.url):
		return "", false, fmt.Errorf("a path is adopted with crew add project %s --path=%s; the default is a git URL", a.name, a.url)
	case a.url == "":
		if existing == nil && a.newPath == "" {
			return "", false, errors.New("usage: crew add project <name> <url> | --path=<dir> [--setup=<cmd>] [--env-cmd=<cmd>]")
		}
		if existing != nil {
			return a.newPath, false, nil
		}
		path, _, err := project.NewTarget(a.name, a.newPath)
		return path, false, err
	case a.newPath != "":
		return "", false, fmt.Errorf("%s: a URL always clones to %s — drop --path to clone it, or drop the URL to adopt %s", a.name, project.ClonePath(a.name), a.newPath)
	}
	return project.NewTarget(a.name, "")
}

// applyProjectUpdate is `crew add project` on a project already in the
// pool: each given flag lands, and the lines say what changed.
func applyProjectUpdate(a addProjectArgs) ([]string, error) {
	if err := a.updatesExisting(); err != nil {
		return nil, err
	}
	var lines []string
	if a.hasSetup {
		if err := project.SetSetup(a.name, a.setup); err != nil {
			return nil, err
		}
		lines = append(lines, fmt.Sprintf("Setup for %s: %s", a.name, a.setup))
	}
	if a.hasEnvCmd {
		if err := project.SetEnvCmd(a.name, a.envCmd); err != nil {
			return nil, err
		}
		lines = append(lines, fmt.Sprintf("Env command for %s: %s", a.name, a.envCmd))
	}
	if a.newPath != "" {
		if err := project.SetPath(a.name, a.newPath); err != nil {
			return nil, err
		}
		// SetPath records the path absolute; say what was recorded.
		path := a.newPath
		if p := project.Get(a.name); p != nil {
			path = p.Path
		}
		lines = append(lines, fmt.Sprintf("Path for %s: %s", a.name, path))
	}
	return lines, nil
}

// parseProjectSpecs reads "<project>[:<role>]" arguments and the flags that
// apply to the whole call. --role= is the single-project spelling; with
// several projects the role rides on each name. Pure.
func parseProjectSpecs(args []string) ([]workspace.ProjectSpec, error) {
	var specs []workspace.ProjectSpec
	role, direct := "", false
	for _, arg := range args {
		switch {
		case strings.HasPrefix(arg, "--role="):
			role = strings.TrimPrefix(arg, "--role=")
		case arg == "--direct":
			direct = true
		case strings.HasPrefix(arg, "-"):
			return nil, fmt.Errorf("unknown flag '%s'", arg)
		default:
			name, r, _ := strings.Cut(arg, ":")
			if name == "" {
				return nil, fmt.Errorf("'%s': a project name is needed before the colon", arg)
			}
			specs = append(specs, workspace.ProjectSpec{Name: name, Role: r})
		}
	}
	if role != "" {
		if len(specs) != 1 {
			return nil, errors.New("--role= names one project's role; with several, write <project>:<role>")
		}
		if specs[0].Role != "" {
			return nil, errors.New("give the role once: --role= or <project>:<role>")
		}
		specs[0].Role = role
	}
	for i := range specs {
		if specs[i].Role == "" {
			specs[i].Role = "works on " + specs[i].Name
		}
		if direct {
			specs[i].Mode = workspace.ModeDirect
		}
	}
	return specs, nil
}

func cmdAddWorkspace() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: crew add workspace <name> [<project>[:<role>] ...] [--role=<role>] [--direct] [--wait]\n")
		os.Exit(1)
	}
	wsName := os.Args[3]

	if len(os.Args) == 4 {
		if err := workspace.Create(wsName); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		fmt.Fprintf(human, "Created workspace: %s\n", wsName)
		return
	}

	args, wait := extractFlag(os.Args[4:], "--wait")
	specs, err := parseProjectSpecs(args)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	// One command for "workspace with these projects": the create is implied.
	if !workspace.Exists(wsName) {
		if err := workspace.Create(wsName); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		fmt.Fprintf(human, "Created workspace: %s\n", wsName)
	}
	refs, err := workspace.AddProjects(wsName, specs, workspace.CheckoutOptions{Install: true, Smoke: true})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	// One row per project. Added means the member is recorded and its
	// runners are going; with --wait, failed is what they recorded — the
	// member stays, the fix line follows.
	type row struct {
		Project string `json:"project"`
		Outcome string `json:"outcome"` // added | failed
		Mode    string `json:"mode"`
		Detail  string `json:"detail,omitempty"`
	}
	failed := map[string]workspace.Issue{}
	if wait {
		for _, ref := range refs {
			watchSetup(ref)
			if h := recordedHealth(ref); h != nil {
				for _, i := range h.Issues {
					if _, seen := failed[i.Project]; !seen {
						failed[i.Project] = i
					}
				}
			}
		}
	}
	rows := make([]row, 0, len(specs))
	for _, spec := range specs {
		mode := "worktree"
		if spec.Mode == workspace.ModeDirect {
			mode = "direct"
		}
		r := row{Project: spec.Name, Outcome: "added", Mode: mode}
		if i, ok := failed[spec.Name]; ok {
			r.Outcome, r.Detail = "failed", i.Summary()
		} else if !wait && len(refs) > 0 {
			r.Detail = "installing"
		}
		rows = append(rows, r)
	}
	if jsonOutput {
		printJSON(rows)
	} else {
		for _, r := range rows {
			fmt.Printf("%s\t%s\t%s\t%s\n", r.Project, r.Outcome, r.Mode, r.Detail)
		}
	}
	if !wait && len(refs) > 0 {
		for _, ref := range refs {
			fmt.Fprintf(human, "  crew setup status %s [--wait]\n", ref)
		}
		return
	}
	if len(failed) > 0 {
		fmt.Fprintf(os.Stderr, "! %d of %d failed\n", len(failed), len(specs))
		for _, ref := range refs {
			if recordedHealth(ref) != nil {
				fmt.Fprintf(os.Stderr, "  crew fix %s --print / crew verify %s\n", ref, ref)
			}
		}
		os.Exit(1)
	}
}

func cmdConfig() {
	switch os.Args[2] {
	case "show":
		s := config.LoadSettings()
		if jsonOutput {
			printJSON(struct {
				ServerIP  string `json:"server_ip"`
				SSHHost   string `json:"ssh_host"`
				ProxyPort int    `json:"proxy_port"`
				Domain    string `json:"domain"`
			}{s.ServerIP, s.SSHHost, s.ProxyPort, s.Domain})
			return
		}
		fmt.Printf("server_ip\t%s\n", s.ServerIP)
		fmt.Printf("ssh_host\t%s\n", s.SSHHost)
		fmt.Printf("proxy_port\t%d\n", s.ProxyPort)
		fmt.Printf("domain\t%s\n", s.Domain)
	case "set":
		if len(os.Args) < 5 {
			fmt.Fprintf(os.Stderr, "Usage: crew config set <key> <value>\n")
			os.Exit(1)
		}
		key := os.Args[3]
		value := os.Args[4]
		s := config.LoadSettings()
		switch key {
		case "server_ip":
			s.ServerIP = value
		case "ssh_host":
			s.SSHHost = value
		case "proxy_port":
			s.ProxyPort = intFlag("proxy_port", value, false)
		case "domain":
			s.Domain = value
		default:
			fmt.Fprintf(os.Stderr, "Unknown key '%s'. Valid keys: server_ip, ssh_host, proxy_port, domain\n", key)
			os.Exit(1)
		}
		if err := config.SaveSettings(s); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Set %s = %s\n", key, value)
	case "refresh":
		exec.EnsureTmuxConfig()
		fmt.Printf("Refreshed %s\n", exec.TmuxConfigPath())
	default:
		fmt.Fprintf(os.Stderr, "Unknown config command '%s'.\nUsage: crew config [show|set|refresh]\n", os.Args[2])
		os.Exit(1)
	}
}

// cmdDebug follows the log in a terminal; --tail=N prints the last lines
// and returns, which is what a script or an agent wants.
func cmdDebug() {
	tail := 0
	for _, arg := range os.Args[2:] {
		switch {
		case strings.HasPrefix(arg, "--tail="):
			tail = intFlag("--tail", strings.TrimPrefix(arg, "--tail="), true)
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\nUsage: crew debug [--tail=<n>]\n", arg)
			os.Exit(1)
		}
	}
	if tail == 0 && jsonOutput {
		tail = debug.DefaultTail
	}
	if tail > 0 {
		lines := debug.TailLines(tail)
		if jsonOutput {
			printJSON(debug.ParseLines(lines))
			return
		}
		for _, l := range lines {
			fmt.Println(l)
		}
		return
	}

	logPath := config.ConfigDir + "/debug.log"

	// Ensure the file exists before tail -f
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY, 0o644)
	if err == nil {
		f.Close()
	}

	tailPath, err := osexec.LookPath("tail")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: tail not found\n")
		os.Exit(1)
	}

	if err := syscall.Exec(tailPath, []string{"tail", "-f", logPath}, os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func cmdUpdate() {
	selfPath, err := osexec.LookPath("crew")
	if err != nil {
		selfPath, err = os.Executable()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: cannot determine crew binary path\n")
			os.Exit(1)
		}
	}

	latest, err := fetchLatestVersion()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error fetching latest version: %v\n", err)
		os.Exit(1)
	}

	current := Version
	if current == latest {
		fmt.Printf("crew is already up to date (v%s)\n", current)
		return
	}

	fmt.Printf("Updating crew v%s → v%s\n", current, latest)

	osName := strings.ToLower(runtime.GOOS)
	arch := runtime.GOARCH

	url := fmt.Sprintf("https://github.com/%s/releases/download/v%s/crew_%s_%s_%s.tar.gz",
		config.Repo, latest, latest, osName, arch)

	tmpDir, err := os.MkdirTemp("", "crew-update-*")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating temp dir: %v\n", err)
		os.Exit(1)
	}
	defer os.RemoveAll(tmpDir)

	tarPath := filepath.Join(tmpDir, "crew.tar.gz")
	dlCmd := osexec.Command("curl", "-fsSL", "-o", tarPath, url)
	dlCmd.Stderr = os.Stderr
	if err := dlCmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error downloading release: %v\n", err)
		os.Exit(1)
	}

	extractCmd := osexec.Command("tar", "-xzf", tarPath, "-C", tmpDir)
	if err := extractCmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error extracting release: %v\n", err)
		os.Exit(1)
	}

	newBin := filepath.Join(tmpDir, "crew")
	if err := os.Rename(newBin, selfPath); err != nil {
		// rename may fail across filesystems; fall back to copy
		if err := copyFile(newBin, selfPath); err != nil {
			fmt.Fprintf(os.Stderr, "Error replacing binary: %v\n", err)
			os.Exit(1)
		}
	}
	os.Chmod(selfPath, 0o755)

	fmt.Printf("crew updated to v%s\n", latest)
}

func fetchLatestVersion() (string, error) {
	cmd := osexec.Command("gh", "api", "repos/"+config.Repo+"/releases/latest", "--jq", ".tag_name")
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("gh api failed: %w (is gh installed and authenticated?)", err)
	}
	tag := strings.TrimSpace(string(out))
	return strings.TrimPrefix(tag, "v"), nil
}

func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0o755)
}
