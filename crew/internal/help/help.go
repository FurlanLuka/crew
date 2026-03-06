package help

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

type CommandInfo struct {
	Name         string        `json:"name"`
	Description  string        `json:"description"`
	Usage        string        `json:"usage,omitempty"`
	Flags        []FlagInfo    `json:"flags,omitempty"`
	Subcommands  []CommandInfo `json:"subcommands,omitempty"`
	OutputFormat string        `json:"output_format,omitempty"`
	TUI          bool          `json:"tui,omitempty"`
}

type FlagInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Required    bool   `json:"required,omitempty"`
	Default     string `json:"default,omitempty"`
}

var Root = CommandInfo{
	Name:        "crew",
	Description: "Agent team launcher, workspace manager & package registry",
	Subcommands: []CommandInfo{
		{
			Name:        "workspace",
			Description: "Manage workspaces and launch",
			TUI:         true,
		},
		{
			Name:        "project",
			Description: "Add/remove projects and configure dev servers",
			TUI:         true,
		},
		{
			Name:        "registry",
			Description: "Install and manage agents & skills",
			TUI:         true,
			Subcommands: []CommandInfo{
				{
					Name:        "install",
					Description: "Install agents and skills from registry",
					Usage:       "crew registry install [<name> | --all]",
					Flags: []FlagInfo{
						{Name: "--all", Description: "Install all available agents and skills"},
					},
				},
			},
		},
		{
			Name:        "profile",
			Description: "Manage Claude profile",
			TUI:         true,
		},
		{
			Name:        "config",
			Description: "View and edit crew settings",
			TUI:         true,
		},
		{
			Name:        "notify",
			Description: "Push notification setup",
			TUI:         true,
		},
		{
			Name:        "plans",
			Description: "Claude plan viewer dashboard",
			TUI:         true,
			Subcommands: []CommandInfo{
				{Name: "start", Description: "Start the plan viewer"},
				{Name: "stop", Description: "Stop the plan viewer"},
			},
		},
		{
			Name:        "ls",
			Description: "List workspaces or projects",
			Subcommands: []CommandInfo{
				{
					Name:         "workspaces",
					Description:  "List all workspaces with project counts",
					Usage:        "crew ls workspaces",
					OutputFormat: "<name>\\t<n> projects",
				},
				{
					Name:         "projects",
					Description:  "List all registered projects",
					Usage:        "crew ls projects",
					OutputFormat: "<name>\\t<path>",
				},
			},
		},
		{
			Name:         "show",
			Description:  "Show projects in a workspace",
			Usage:        "crew show <workspace>",
			OutputFormat: "<name>\\t<path>\\t<role>",
		},
		{
			Name:        "code",
			Description: "Open workspace in Cursor/VSCode via Remote SSH",
			Usage:       "crew code <workspace>",
		},
		{
			Name:        "start",
			Description: "Generate agent prompt for a workspace",
			Usage:       "crew start <workspace>",
		},
		{
			Name:        "launch",
			Description: "Open the launch view for a workspace",
			Usage:       "crew launch [<workspace>]",
			TUI:         true,
		},
		{
			Name:        "dev",
			Description: "Manage dev servers and reverse proxy",
			Subcommands: []CommandInfo{
				{
					Name:        "setup",
					Description: "Interactive dev server configuration",
					Usage:       "crew dev setup <project>",
				},
				{
					Name:        "add",
					Description: "Add a dev server to a project",
					Usage:       "crew dev add <project> [flags]",
					Flags: []FlagInfo{
						{Name: "--name=<n>", Description: "Server name", Required: true},
						{Name: "--port=<p>", Description: "External port", Required: true},
						{Name: "--cmd=<c>", Description: "Start command", Required: true},
						{Name: "--dir=<d>", Description: "Subdirectory (relative to project)"},
					},
				},
				{
					Name:        "rm",
					Description: "Remove a dev server from a project",
					Usage:       "crew dev rm <project> <server-name>",
				},
				{
					Name:         "show",
					Description:  "Show configured dev servers for a project",
					Usage:        "crew dev show <project>",
					OutputFormat: "<server-name>\\t<port>\\t<command>[\\t<dir>]",
				},
				{
					Name:        "start",
					Description: "Start dev servers with reverse proxy",
					Usage:       "crew dev start <workspace> [flags]",
					Flags: []FlagInfo{
						{Name: "--host=<ip>", Description: "IP for nip.io URLs", Default: "auto-detect LAN IP"},
					},
				},
				{
					Name:        "stop",
					Description: "Stop dev servers",
					Usage:       "crew dev stop [<workspace>]",
				},
				{
					Name:        "restart",
					Description: "Restart dev servers",
					Usage:       "crew dev restart <workspace> [flags]",
					Flags: []FlagInfo{
						{Name: "--host=<ip>", Description: "IP for nip.io URLs", Default: "auto-detect LAN IP"},
					},
				},
				{
					Name:         "status",
					Description:  "Show running dev servers and their URLs",
					Usage:        "crew dev status [<workspace>]",
					OutputFormat: "<workspace>\\t<subdomain>\\t<port>\\t<url>",
				},
			},
		},
		{
			Name:        "git",
			Description: "Launch lazygit in tmux for a workspace",
			Usage:       "crew git <workspace>",
		},
		{
			Name:        "rm",
			Description: "Remove a workspace",
			Usage:       "crew rm <workspace>",
		},
		{
			Name:        "help",
			Description: "Show help for commands",
			Usage:       "crew help [<command>] [<subcommand>] [--json]",
		},
	},
}

// Run handles `crew help [args...]`.
func Run(args []string) {
	jsonOutput := false
	var filtered []string
	for _, a := range args {
		if a == "--json" {
			jsonOutput = true
		} else {
			filtered = append(filtered, a)
		}
	}

	if jsonOutput {
		data, _ := json.MarshalIndent(Root, "", "  ")
		fmt.Println(string(data))
		return
	}

	cmd := &Root
	for _, name := range filtered {
		child := findSubcommand(cmd, name)
		if child == nil {
			fmt.Fprintf(os.Stderr, "Unknown command: %s\n", strings.Join(filtered, " "))
			os.Exit(1)
		}
		cmd = child
	}

	printHelp(cmd, filtered)
}

func findSubcommand(parent *CommandInfo, name string) *CommandInfo {
	for i := range parent.Subcommands {
		if parent.Subcommands[i].Name == name {
			return &parent.Subcommands[i]
		}
	}
	return nil
}

func printHelp(cmd *CommandInfo, path []string) {
	fullName := "crew"
	if len(path) > 0 {
		fullName += " " + strings.Join(path, " ")
	}

	fmt.Printf("%s - %s\n", fullName, cmd.Description)

	if cmd.Usage != "" {
		fmt.Printf("\nUsage: %s\n", cmd.Usage)
	}

	if len(cmd.Subcommands) > 0 {
		fmt.Println("\nCommands:")
		maxLen := 0
		for _, sc := range cmd.Subcommands {
			if len(sc.Name) > maxLen {
				maxLen = len(sc.Name)
			}
		}
		for _, sc := range cmd.Subcommands {
			suffix := ""
			if sc.TUI {
				suffix = " (TUI)"
			}
			fmt.Printf("  %-*s  %s%s\n", maxLen, sc.Name, sc.Description, suffix)
		}
		hint := "crew help <command>"
		if len(path) > 0 {
			hint = "crew help " + strings.Join(path, " ") + " <command>"
		}
		fmt.Printf("\nRun '%s' for details.\n", hint)
	}

	if len(cmd.Flags) > 0 {
		fmt.Println("\nFlags:")
		maxLen := 0
		for _, f := range cmd.Flags {
			if len(f.Name) > maxLen {
				maxLen = len(f.Name)
			}
		}
		for _, f := range cmd.Flags {
			extra := ""
			if f.Required {
				extra = " (required)"
			} else if f.Default != "" {
				extra = " (default: " + f.Default + ")"
			}
			fmt.Printf("  %-*s  %s%s\n", maxLen, f.Name, f.Description, extra)
		}
	}

	if cmd.OutputFormat != "" {
		fmt.Printf("\nOutput: %s\n", cmd.OutputFormat)
	}
}
