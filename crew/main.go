package main

import (
	"fmt"
	"os"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/homebrew-tap/crew/internal/app"
	"github.com/FurlanLuka/homebrew-tap/crew/internal/config"
	"github.com/FurlanLuka/homebrew-tap/crew/internal/exec"
	"github.com/FurlanLuka/homebrew-tap/crew/internal/notify"
	"github.com/FurlanLuka/homebrew-tap/crew/internal/profile"
	"github.com/FurlanLuka/homebrew-tap/crew/internal/project"
	"github.com/FurlanLuka/homebrew-tap/crew/internal/registry"
	"github.com/FurlanLuka/homebrew-tap/crew/internal/workspace"
)

var Version = "dev"

func main() {
	config.Init()

	cmd := ""
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}

	switch cmd {
	case "--version", "-v":
		fmt.Println("crew " + Version)
		return

	case "kill":
		cmdKill()
		return

	case "workspace":
		runTUI(workspace.NewView())

	case "project":
		runTUI(project.NewView())

	case "registry":
		runTUI(registry.NewView())

	case "profile":
		runTUI(profile.NewView())

	case "notify":
		runTUI(notify.NewView())

	case "ls":
		cmdLs()
		return

	case "start":
		cmdStart()
		return

	case "":
		runTUI(mainMenu())

	default:
		// Try as workspace name shortcut (launch directly)
		if workspace.Exists(cmd) {
			runTUI(workspace.NewLaunchView(cmd))
		} else {
			fmt.Fprintf(os.Stderr, "Unknown command '%s'.\nUsage: crew [workspace|project|registry|profile|notify|kill|ls|start]\n", cmd)
			os.Exit(1)
		}
	}
}

func mainMenu() app.Menu {
	return app.NewMenu([]app.MenuItem{
		{
			Label:       "Workspace",
			Description: "Manage workspaces, worktrees, and launch",
			Page:        func() app.Page { return workspace.NewView() },
		},
		{
			Label:       "Project",
			Description: "Add/remove projects in workspaces",
			Page:        func() app.Page { return project.NewView() },
		},
		{
			Label:       "Registry",
			Description: "Install and manage agents & skills",
			Page:        func() app.Page { return registry.NewView() },
		},
		{
			Label:       "Profile",
			Description: "Manage Claude profile",
			Page:        func() app.Page { return profile.NewView() },
		},
		{
			Label:       "Notifications",
			Description: "Push notification setup",
			Page:        func() app.Page { return notify.NewView() },
		},
	})
}

func runTUI(page app.Page) {
	a := app.New(page)
	p := tea.NewProgram(a, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func cmdLs() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew ls [projects|workspaces]\n")
		os.Exit(1)
	}

	switch os.Args[2] {
	case "projects":
		cmdLsProjects()
	case "workspaces":
		cmdLsWorkspaces()
	default:
		fmt.Fprintf(os.Stderr, "Unknown ls target '%s'.\nUsage: crew ls [projects|workspaces]\n", os.Args[2])
		os.Exit(1)
	}
}

func cmdLsProjects() {
	projects, err := project.List()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	for _, p := range projects {
		fmt.Printf("%s\t%s\n", p.Name, p.Path)
	}
}

func cmdLsWorkspaces() {
	summaries, err := workspace.ListSummaries()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	for _, s := range summaries {
		fmt.Printf("%s\t%d projects\t%d worktrees\n", s.Name, s.ProjectCount, s.WorktreeCount)
	}
}

func cmdStart() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew start <workspace> [--worktree=<name>] [--from=<branch>]\n")
		os.Exit(1)
	}

	wsName := os.Args[2]
	worktreeName := ""
	fromBranch := ""

	for _, arg := range os.Args[3:] {
		switch {
		case strings.HasPrefix(arg, "--worktree="):
			worktreeName = strings.TrimPrefix(arg, "--worktree=")
		case strings.HasPrefix(arg, "--from="):
			fromBranch = strings.TrimPrefix(arg, "--from=")
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'.\nUsage: crew start <workspace> [--worktree=<name>] [--from=<branch>]\n", arg)
			os.Exit(1)
		}
	}

	if !workspace.Exists(wsName) {
		fmt.Fprintf(os.Stderr, "Error: workspace '%s' not found\n", wsName)
		os.Exit(1)
	}

	loadName := wsName
	if worktreeName != "" {
		safeName, err := workspace.CreateWorktree(wsName, worktreeName, fromBranch)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		loadName = workspace.WorktreeWorkspaceName(wsName, safeName)
	}

	ws, err := workspace.Load(loadName)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	prompt, err := workspace.GeneratePrompt(ws)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Print(prompt)
}

func cmdKill() {
	killed := false

	// Kill tmux sessions
	for _, session := range exec.ListCrewSessions() {
		wsName := session[len("crew-"):]
		exec.KillTmuxSession(session)
		fmt.Printf("Killed session: %s\n", session)

		// Clean up prompt + workspace files
		os.Remove(workspace.PromptFilePath(wsName))

		wsFile := workspace.CodeWorkspaceFilePath(wsName)
		if _, err := os.Stat(wsFile); err == nil {
			editor := exec.DetectEditor()
			exec.CloseEditorWindow(exec.EditorProcessName(editor), wsName)
			os.Remove(wsFile)
		}

		killed = true
	}

	// Clean up orphaned .code-workspace files
	entries, _ := os.ReadDir(config.ConfigDir)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if len(name) > len(".code-workspace") && name[len(name)-len(".code-workspace"):] == ".code-workspace" {
			wsName := name[:len(name)-len(".code-workspace")]
			session := "crew-" + wsName
			if !exec.TmuxSessionExists(session) {
				wsFile := workspace.CodeWorkspaceFilePath(wsName)
				editor := exec.DetectEditor()
				exec.CloseEditorWindow(exec.EditorProcessName(editor), wsName)
				os.Remove(wsFile)
				os.Remove(workspace.PromptFilePath(wsName))
				killed = true
			}
		}
	}

	if !killed {
		fmt.Println("No crew sessions running.")
	}
}
