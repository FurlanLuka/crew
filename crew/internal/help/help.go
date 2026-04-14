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
	Examples     []string      `json:"examples,omitempty"`
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
			Description: "Interactive workspace manager — create, configure, and launch workspaces",
			TUI:         true,
		},
		{
			Name:        "project",
			Description: "Interactive project manager — add/remove projects and configure dev servers",
			TUI:         true,
		},
		{
			Name:        "add",
			Description: "Add a project or workspace (CLI)",
			Subcommands: []CommandInfo{
				{
					Name:        "project",
					Description: "Register a git repo in the global project pool. Projects can be added to multiple workspaces.",
					Usage:       "crew add project <name> <path>",
					Examples: []string{
						"crew add project my-api /home/user/repos/api",
						"crew add project frontend ~/repos/web-app",
					},
				},
				{
					Name:        "workspace",
					Description: "Create a new workspace, or add a project to an existing one. Without a project argument, creates an empty workspace. With a project, creates a git worktree and adds it to the workspace.",
					Usage:       "crew add workspace <name> [<project> --role=<role>]",
					Flags: []FlagInfo{
						{Name: "--role=<r>", Description: "Role description for the project in this workspace (e.g., \"Backend API\", \"Frontend\")"},
					},
					Examples: []string{
						"crew add workspace feature-auth",
						"crew add workspace feature-auth my-api --role=\"Auth service\"",
						"crew add workspace feature-auth frontend --role=\"Login UI\"",
					},
				},
			},
		},
		{
			Name:        "registry",
			Description: "Install, update, and manage agents & skills from the crew registry",
			TUI:         true,
			Subcommands: []CommandInfo{
				{
					Name:        "install",
					Description: "Install agents and skills from the registry. Tries agent first, then skill.",
					Usage:       "crew registry install [<name> | --all]",
					Flags: []FlagInfo{
						{Name: "--all", Description: "Install all available agents and skills"},
					},
					Examples: []string{
						"crew registry install crew",
						"crew registry install crew-remote",
						"crew registry install --all",
					},
				},
				{
					Name:        "rm",
					Description: "Remove a locally installed agent or skill. Tries agent first, then skill.",
					Usage:       "crew registry rm <name>",
					Examples: []string{
						"crew registry rm crew",
						"crew registry rm crew-remote",
					},
				},
				{
					Name:        "update",
					Description: "Update an installed agent/skill to the latest version from the registry, or update all installed items at once.",
					Usage:       "crew registry update [<name> | --all]",
					Flags: []FlagInfo{
						{Name: "--all", Description: "Update all installed agents and skills"},
					},
					Examples: []string{
						"crew registry update crew",
						"crew registry update --all",
					},
				},
			},
		},
		{
			Name:        "profile",
			Description: "Manage the shared Claude profile (CLAUDE.md) installed from the registry",
			TUI:         true,
			Subcommands: []CommandInfo{
				{
					Name:        "install",
					Description: "Download and install the Claude profile from the registry to CLAUDE_CONFIG_DIR/CLAUDE.md",
					Usage:       "crew profile install",
				},
				{
					Name:        "update",
					Description: "Check for changes and update the Claude profile to the latest version. Prints 'Already up to date' if unchanged.",
					Usage:       "crew profile update",
				},
				{
					Name:        "rm",
					Description: "Remove the installed Claude profile",
					Usage:       "crew profile rm",
				},
				{
					Name:        "status",
					Description: "Check if the Claude profile is installed. Prints 'installed' or 'not installed'.",
					Usage:       "crew profile status",
				},
			},
		},
		{
			Name:        "config",
			Description: "View and edit crew settings (server IP, SSH host, proxy port, domain)",
			TUI:         true,
			Subcommands: []CommandInfo{
				{
					Name:         "show",
					Description:  "Show all settings as tab-separated key/value pairs",
					Usage:        "crew config show",
					OutputFormat: "<key>\\t<value>",
				},
				{
					Name:        "set",
					Description: "Set a config value. Valid keys: server_ip (LAN IP for dev proxy), ssh_host (for remote editor), proxy_port (reverse proxy port, default 80), domain (custom domain, default <ip>.nip.io)",
					Usage:       "crew config set <key> <value>",
					Examples: []string{
						"crew config set server_ip 192.168.1.50",
						"crew config set ssh_host my-dev-vm",
						"crew config set proxy_port 8080",
						"crew config set domain dev.example.com",
					},
				},
			},
		},
		{
			Name:        "notify",
			Description: "Configure push notifications via ntfy.sh — get alerted when Claude needs input",
			TUI:         true,
			Subcommands: []CommandInfo{
				{
					Name:        "setup",
					Description: "Enable push notifications. Generates a random topic if none given. Creates a hook script and registers it in Claude settings.",
					Usage:       "crew notify setup [<topic>]",
					Examples: []string{
						"crew notify setup",
						"crew notify setup my-custom-topic",
					},
				},
				{
					Name:        "test",
					Description: "Send a test notification to verify the setup is working",
					Usage:       "crew notify test",
				},
				{
					Name:        "rm",
					Description: "Remove the notification hook script and unregister from Claude settings",
					Usage:       "crew notify rm",
				},
			},
		},
		{
			Name:        "plans",
			Description: "Claude plan viewer dashboard — view agent plans in a web UI",
			TUI:         true,
			Subcommands: []CommandInfo{
				{
					Name:        "start",
					Description: "Start the plan viewer server",
					Usage:       "crew plans start",
				},
				{
					Name:        "stop",
					Description: "Stop the plan viewer server",
					Usage:       "crew plans stop",
				},
			},
		},
		{
			Name:        "ls",
			Description: "List workspaces or projects (tab-separated output for scripting)",
			Subcommands: []CommandInfo{
				{
					Name:         "workspaces",
					Description:  "List all workspaces with project counts",
					Usage:        "crew ls workspaces",
					OutputFormat: "<name>\\t<n> projects",
				},
				{
					Name:         "projects",
					Description:  "List all registered projects with their paths",
					Usage:        "crew ls projects",
					OutputFormat: "<name>\\t<path>",
				},
			},
		},
		{
			Name:         "show",
			Description:  "Show all projects in a workspace with their worktree paths and roles",
			Usage:        "crew show <workspace>",
			OutputFormat: "<name>\\t<path>\\t<role>",
			Examples:     []string{"crew show feature-auth"},
		},
		{
			Name:        "code",
			Description: "Open a workspace in Cursor/VSCode via SSH Remote. Requires ssh_host to be configured (crew config set ssh_host <host>). For multi-project workspaces, generates a .code-workspace file.",
			Usage:       "crew code <workspace>",
			Examples:    []string{"crew code feature-auth"},
		},
		{
			Name:        "start",
			Description: "Generate and print the agent prompt for a workspace. The prompt instructs Claude to create an agent team with the workspace's projects and roles.",
			Usage:       "crew start <workspace>",
			Examples:    []string{"crew start feature-auth"},
		},
		{
			Name:        "launch",
			Description: "Open the interactive launch view — choose Editor+Claude or Claude mode, start dev servers, and begin working",
			Usage:       "crew launch [<workspace>]",
			TUI:         true,
			Examples:    []string{"crew launch", "crew launch feature-auth"},
		},
		{
			Name:        "dev",
			Description: "Manage dev servers and reverse proxy. Each project can have named dev servers that run in tmux windows behind a shared reverse proxy.",
			Subcommands: []CommandInfo{
				{
					Name:        "setup",
					Description: "Interactive dev server configuration — auto-detects package.json scripts and walks you through naming, ports, and commands",
					Usage:       "crew dev setup <project>",
					TUI:         true,
					Examples:    []string{"crew dev setup my-api"},
				},
				{
					Name:        "add",
					Description: "Add a dev server to a project. The --port is for reference only — at runtime, crew assigns a random free port via the PORT env var.",
					Usage:       "crew dev add <project> [flags]",
					Flags: []FlagInfo{
						{Name: "--name=<n>", Description: "Server name (used as subdomain)", Required: true},
						{Name: "--port=<p>", Description: "Reference port (the port your app normally uses)", Required: true},
						{Name: "--cmd=<c>", Description: "Start command (use $PORT for the dynamic port)", Required: true},
						{Name: "--dir=<d>", Description: "Subdirectory relative to project root (for monorepos)"},
						{Name: "--local-port=<n>", Description: "Fixed local port used when started with --no-proxy"},
					},
					Examples: []string{
						"crew dev add my-api --name=api --port=3000 --cmd=\"npm run dev\"",
						"crew dev add my-app --name=web --port=5173 --cmd=\"npm run dev\" --dir=packages/web",
						"crew dev add my-api --name=api --port=3000 --cmd=\"npm run dev\" --local-port=3000",
					},
				},
				{
					Name:        "rm",
					Description: "Remove a dev server configuration from a project",
					Usage:       "crew dev rm <project> <server-name>",
					Examples:    []string{"crew dev rm my-api api"},
				},
				{
					Name:         "show",
					Description:  "Show configured dev servers for a project (not necessarily running)",
					Usage:        "crew dev show <project>",
					OutputFormat: "<server-name>\\t<port>\\t<command>[\\t<dir>[\\t<local-port>]]",
					Examples:     []string{"crew dev show my-api"},
				},
				{
					Name:        "start",
					Description: "Start all dev servers for a workspace in tmux windows and launch the shared reverse proxy. URLs use the format: http://<server>--<workspace>.<domain>. With --no-proxy, servers bind to their configured --local-port and URLs are plain http://localhost:<local-port>; the proxy is not started.",
					Usage:       "crew dev start <workspace> [--no-proxy]",
					Flags: []FlagInfo{
						{Name: "--no-proxy", Description: "Skip the reverse proxy; bind each server to its --local-port"},
					},
					Examples: []string{"crew dev start feature-auth", "crew dev start feature-auth --no-proxy"},
				},
				{
					Name:        "stop",
					Description: "Stop dev servers. Without a workspace name, stops all running dev servers.",
					Usage:       "crew dev stop [<workspace>]",
					Examples:    []string{"crew dev stop", "crew dev stop feature-auth"},
				},
				{
					Name:        "restart",
					Description: "Stop and restart dev servers for a workspace",
					Usage:       "crew dev restart <workspace> [--no-proxy]",
					Flags: []FlagInfo{
						{Name: "--no-proxy", Description: "Skip the reverse proxy; bind each server to its --local-port"},
					},
					Examples: []string{"crew dev restart feature-auth", "crew dev restart feature-auth --no-proxy"},
				},
				{
					Name:         "status",
					Description:  "Show running dev servers and their URLs. Without a workspace, shows all.",
					Usage:        "crew dev status [<workspace>]",
					OutputFormat: "<workspace>\\t<subdomain>\\t<port>\\t<url>",
					Examples:     []string{"crew dev status", "crew dev status feature-auth"},
				},
			},
		},
		{
			Name:        "git",
			Description: "Launch lazygit in a tmux session with one window per project. Sessions are ephemeral — they auto-destroy when you detach (ctrl-b d).",
			Usage:       "crew git <workspace>",
			Examples:    []string{"crew git feature-auth"},
		},
		{
			Name:        "rm",
			Description: "Remove workspaces, projects, or workspace projects. Without subcommand, removes an entire workspace (stops dev servers, removes worktrees, directory, and JSON).",
			Usage:       "crew rm <workspace>",
			Subcommands: []CommandInfo{
				{
					Name:        "project",
					Description: "Remove a project from the global pool (does not affect workspaces that use it)",
					Usage:       "crew rm project <name>",
					Examples:    []string{"crew rm project my-api"},
				},
				{
					Name:        "workspace",
					Description: "Remove a project from a workspace (removes the git worktree)",
					Usage:       "crew rm workspace <workspace> <project>",
					Examples:    []string{"crew rm workspace feature-auth my-api"},
				},
			},
			Examples: []string{"crew rm feature-auth"},
		},
		{
			Name:        "duplicate",
			Description: "Duplicate a workspace — creates a new workspace with fresh worktrees for the same projects",
			Usage:       "crew duplicate <source> <new-name>",
			Examples:    []string{"crew duplicate feature-auth feature-auth-v2"},
		},
		{
			Name:        "update",
			Description: "Update crew to the latest version",
			Usage:       "crew update",
		},
		{
			Name:        "help",
			Description: "Show help for any command. Use --json for machine-readable output of the full command tree.",
			Usage:       "crew help [<command>] [<subcommand>] [--json]",
			Examples: []string{
				"crew help",
				"crew help dev add",
				"crew help --json",
			},
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

	if len(cmd.Examples) > 0 {
		fmt.Println("\nExamples:")
		for _, ex := range cmd.Examples {
			fmt.Printf("  %s\n", ex)
		}
	}
}
