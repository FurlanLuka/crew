package main

import (
	"fmt"
	"os"

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

	case "":
		runTUI(mainMenu())

	default:
		// Try as workspace name shortcut (launch directly)
		if workspace.Exists(cmd) {
			runTUI(workspace.NewLaunchView(cmd))
		} else {
			fmt.Fprintf(os.Stderr, "Unknown command '%s'.\nUsage: crew [workspace|project|registry|profile|notify|kill]\n", cmd)
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
