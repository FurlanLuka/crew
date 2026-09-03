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
	Description: "Workspace manager, dev-server runner & package registry",
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
			Description: "Add a project, workspace, worktree, or binding (CLI)",
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
					Description: "Create a new workspace, or add a project to an existing one. Without a project argument, creates an empty workspace. With a project, creates a git worktree (default) and adds it to the workspace, or attaches the canonical repo with --direct.",
					Usage:       "crew add workspace <name> [<project> --role=<role>] [--direct]",
					Flags: []FlagInfo{
						{Name: "--role=<r>", Description: "Role description for the project in this workspace (e.g., \"Backend API\", \"Frontend\")"},
						{Name: "--direct", Description: "Attach the project's canonical checkout instead of creating a fresh worktree. Changes are NOT isolated. Only one workspace at a time may direct-mount a given project."},
					},
					Examples: []string{
						"crew add workspace feature-auth",
						"crew add workspace feature-auth my-api --role=\"Auth service\"",
						"crew add workspace feature-auth frontend --role=\"Login UI\"",
						"crew add workspace quickfix my-api --role=\"Hotfix\" --direct",
					},
				},
				{
					Name:        "worktree",
					Description: "Add a second working copy to a workspace. Every project in the workspace gets a fresh git worktree under <workspace>/<name>, on branch crew/<workspace>/<name>/<project>. A workspace holding a direct-mode project can only have one worktree.",
					Usage:       "crew add worktree <workspace>/<name>",
					Examples:    []string{"crew add worktree phone-speak/wrk3"},
				},
				{
					Name:        "binding",
					Description: "Declare an env variable a project needs, and how crew computes it at dev-server start. Value is a template over {{url:proj[/server]}}, {{port:proj[/server]}}, {{worktree}} and {{workspace}}; the server is optional when the target has one. Resolved values are injected into the process env — env files are never rewritten. With --scan, propose bindings from the project's own .env.",
					Usage:       "crew add binding <project> --var=<VAR> (--url=<proj[/server]> | --port=<proj[/server]> | --value=<template>) | --scan [--apply]",
					Flags: []FlagInfo{
						{Name: "--var=<VAR>", Description: "Environment variable to set"},
						{Name: "--url=<p[/s]>", Description: "Shorthand for --value='{{url:p/s}}' — http://localhost:<port> of that dev server"},
						{Name: "--port=<p[/s]>", Description: "Shorthand for --value='{{port:p/s}}' — just the port number"},
						{Name: "--value=<t>", Description: "Full template, for composition (e.g. ws://localhost:{{port:livekit}})"},
						{Name: "--scan", Description: "Read the project's .env and propose bindings for values pointing at ports crew allocates"},
						{Name: "--apply", Description: "With --scan, add every unambiguous proposal"},
					},
					Examples: []string{
						"crew add binding ai-tutor-api --var=SPEAK_API_URL --url=speak-api",
						"crew add binding ai-tutor-api --var=LIVEKIT_URL --value='ws://localhost:{{port:livekit}}'",
						"crew add binding ai-tutor-api --var=LIVEKIT_AGENT_NAME --value='{{worktree}}'",
						"crew add binding ai-tutor-api --scan",
						"crew add binding ai-tutor-api --scan --apply",
					},
				},
				{
					Name:        "override",
					Description: "Pin a variable for one worktree. Beats whatever the binding would resolve, and is the acknowledgement for a binding that legitimately never resolves here — it stops printing as an anomaly on every start. Key is VAR, or project.VAR to pin one project when two share a name.",
					Usage:       "crew add override <workspace>/<worktree> <VAR>=<value>",
					Examples: []string{
						"crew add override phone-speak/wrk2 SPEAK_API_URL=https://dev-api.speak.com",
						"crew add override phone-speak/wrk2 ai-tutor-api.API_URL=https://tutor.dev",
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
					Usage:       "crew plans start [--no-proxy]",
					Flags: []FlagInfo{
						{Name: "--no-proxy", Description: "Bind directly to a localhost port instead of routing through the shared proxy. URL becomes http://localhost:<port>."},
					},
				},
				{
					Name:        "stop",
					Description: "Stop the plan viewer server",
					Usage:       "crew plans stop",
				},
			},
		},
		{
			Name:         "ps",
			Description:  "List what crew is running: tmux sessions, and processes that leaked out of them. Loose processes are only those whose parent has exited while still working inside the workspace tree — anything still attached to a live process (a running Claude session, an editor terminal) is reported as left alone.",
			Usage:        "crew ps [--json]",
			OutputFormat: "<kind>\\t<pid>\\t<session|cwd>\\t<command>",
			Examples:     []string{"crew ps", "crew ps --json"},
		},
		{
			Name:        "kill",
			Description: "Stop every crew session and reclaim the processes that leaked out of them, without rebooting. Prints the commands to restore what it stopped. Processes with a live parent are never killed.",
			Usage:       "crew kill [--dry-run]",
			Examples:    []string{"crew kill", "crew kill --dry-run"},
		},
		{
			Name:        "ls",
			Description: "List workspaces or projects (tab-separated output for scripting)",
			Subcommands: []CommandInfo{
				{
					Name:         "workspaces",
					Description:  "List all workspaces with project counts and worktree names",
					Usage:        "crew ls workspaces",
					OutputFormat: "<name>\\t<n> projects\\t<worktree>,<worktree>",
				},
				{
					Name:         "worktrees",
					Description:  "List every working copy — one row per worktree, across all workspaces or one. This is the 'what do I have checked out' view.",
					Usage:        "crew ls worktrees [<workspace>]",
					OutputFormat: "<workspace>/<worktree>\\t<path>\\t[dev]",
					Examples:     []string{"crew ls worktrees", "crew ls worktrees phone-speak"},
				},
				{
					Name:         "projects",
					Description:  "List all registered projects with their paths",
					Usage:        "crew ls projects",
					OutputFormat: "<name>\\t<path>",
				},
				{
					Name:         "bindings",
					Description:  "List a project's bindings as declared. With --check, resolve each against a real worktree and show the value it would get there, or why it would be left alone.",
					Usage:        "crew ls bindings <project> [--check=<workspace>[/<worktree>]]",
					OutputFormat: "<var>\\t<template>[\\t<resolved value>]",
					Examples:     []string{"crew ls bindings ai-tutor-api", "crew ls bindings ai-tutor-api --check=phone-speak/wrk1"},
				},
				{
					Name:         "overrides",
					Description:  "List a worktree's overrides",
					Usage:        "crew ls overrides <workspace>/<worktree>",
					OutputFormat: "<key>\\t<value>",
					Examples:     []string{"crew ls overrides phone-speak/wrk2"},
				},
			},
		},
		{
			Name:         "show",
			Description:  "Show all projects in a workspace with their worktree paths and roles",
			Usage:        "crew show <workspace>[/<worktree>]",
			OutputFormat: "<name>\\t<path>\\t<role>",
			Examples:     []string{"crew show feature-auth"},
		},
		{
			Name:        "code",
			Description: "Open a workspace in Cursor/VSCode via SSH Remote. Requires ssh_host to be configured (crew config set ssh_host <host>). For multi-project workspaces, generates a .code-workspace file.",
			Usage:       "crew code <workspace>[/<worktree>]",
			Examples:    []string{"crew code feature-auth"},
		},
		{
			Name:        "start",
			Description: "Generate and print the orientation prompt for a workspace — the project list, working directories, roles, and worktree/direct framing. Paste it into a running Claude; launches inject it automatically for multi-project workspaces and any workspace with a direct-mode project.",
			Usage:       "crew start <workspace>[/<worktree>]",
			Examples:    []string{"crew start feature-auth"},
		},
		{
			Name:        "launch",
			Description: "Open the interactive launch view — choose Editor + Claude or Claude (both skip permissions), start dev servers, and begin working",
			Usage:       "crew launch [<workspace>[/<worktree>]]",
			TUI:         true,
			Examples:    []string{"crew launch", "crew launch feature-auth", "crew launch phone-speak/wrk2"},
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
						{Name: "--port=<p>", Description: "The port the server conventionally uses — reference only. Crew always allocates a free port and passes it as $PORT", Required: true},
						{Name: "--cmd=<c>", Description: "Start command (use $PORT for the dynamic port)", Required: true},
						{Name: "--dir=<d>", Description: "Subdirectory relative to project root (for monorepos)"},
					},
					Examples: []string{
						"crew dev add my-api --name=api --port=3000 --cmd=\"npm run dev\"",
						"crew dev add my-app --name=web --port=5173 --cmd=\"npm run dev\" --dir=packages/web",
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
					OutputFormat: "<server-name>\\t<port>\\t<command>[\\t<dir>]",
					Examples:     []string{"crew dev show my-api"},
				},
				{
					Name:        "start",
					Description: "Start all dev servers for a worktree in tmux windows and launch the shared reverse proxy. URLs use the format: http://<server>--<workspace>--<worktree>.<domain>. Ports are always allocated fresh — the configured --port is reference only — so any number of worktrees can run at once. With --no-proxy, URLs are plain http://localhost:<allocated-port> and the proxy is not started. Bindings are resolved after ports are allocated and injected into each server's env; anything left alone or pointing at a port crew gave to another project is printed.",
					Usage:       "crew dev start <workspace>[/<worktree>] [--no-proxy]",
					Flags: []FlagInfo{
						{Name: "--no-proxy", Description: "Skip the reverse proxy; address each server as localhost:<allocated port>"},
					},
					Examples: []string{"crew dev start feature-auth", "crew dev start phone-speak/wrk2", "crew dev start feature-auth --no-proxy"},
				},
				{
					Name:        "stop",
					Description: "Stop dev servers. Without an argument, stops every running dev server. A bare workspace name stops all of its worktrees.",
					Usage:       "crew dev stop [<workspace>[/<worktree>]]",
					Examples:    []string{"crew dev stop", "crew dev stop feature-auth"},
				},
				{
					Name:        "restart",
					Description: "Stop and restart dev servers for a worktree",
					Usage:       "crew dev restart <workspace>[/<worktree>] [--no-proxy]",
					Flags: []FlagInfo{
						{Name: "--no-proxy", Description: "Skip the reverse proxy; address each server as localhost:<allocated port>"},
					},
					Examples: []string{"crew dev restart feature-auth", "crew dev restart feature-auth --no-proxy"},
				},
				{
					Name:         "status",
					Description:  "Show running dev servers and their URLs. Without an argument, shows all. A bare workspace name shows all of its worktrees.",
					Usage:        "crew dev status [<workspace>[/<worktree>]]",
					OutputFormat: "<workspace>/<worktree>\\t<server>\\t<port>\\t<url>",
					Examples:     []string{"crew dev status", "crew dev status feature-auth"},
				},
				{
					Name:        "logs",
					Description: "Print the log for a dev server. Logs are truncated each time the server starts, so they only cover the current run. Use -f to follow live output.",
					Usage:       "crew dev logs <workspace>[/<worktree>] <server> [-f|--follow]",
					Flags: []FlagInfo{
						{Name: "-f, --follow", Description: "Stream new output as it arrives (tail -f)"},
					},
					Examples: []string{"crew dev logs feature-auth api", "crew dev logs feature-auth web -f"},
				},
				{
					Name:        "tui",
					Description: "Open the interactive dev server view for a worktree — start, stop, restart, and tail logs",
					Usage:       "crew dev tui <workspace>[/<worktree>]",
					TUI:         true,
					Examples:    []string{"crew dev tui phone-speak/wrk1"},
				},
			},
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
					Description: "Remove a project from a workspace (removes its checkout from every worktree)",
					Usage:       "crew rm workspace <workspace> <project>",
					Examples:    []string{"crew rm workspace feature-auth my-api"},
				},
				{
					Name:        "worktree",
					Description: "Remove one worktree — its checkouts, dev session, logs and prompt. Refuses to remove the last worktree; remove the workspace instead.",
					Usage:       "crew rm worktree <workspace>/<name>",
					Examples:    []string{"crew rm worktree phone-speak/wrk3"},
				},
				{
					Name:        "binding",
					Description: "Remove a binding from a project",
					Usage:       "crew rm binding <project> <var>",
					Examples:    []string{"crew rm binding ai-tutor-api SPEAK_API_URL"},
				},
				{
					Name:        "override",
					Description: "Remove a worktree override; the binding applies again",
					Usage:       "crew rm override <workspace>/<worktree> <VAR>",
					Examples:    []string{"crew rm override phone-speak/wrk2 SPEAK_API_URL"},
				},
			},
			Examples: []string{"crew rm feature-auth"},
		},
		{
			Name:        "duplicate",
			Description: "Duplicate a worktree within its workspace — fresh checkouts of the same projects, with the source worktree's overrides copied across",
			Usage:       "crew duplicate <workspace>[/<worktree>] <new-worktree>",
			Examples:    []string{"crew duplicate phone-speak/wrk1 wrk3"},
		},
		{
			Name:         "env",
			Description:  "Print a project's resolved env for a worktree, against the dev servers currently running there. stdout is pure KEY=VALUE so it can be eval'd; the full table and any variables left alone go to stderr. Values are point-in-time — prefer `crew run` over pasting them anywhere.",
			Usage:        "crew env <workspace>[/<worktree>] <project>",
			OutputFormat: "<VAR>=<value>",
			Examples:     []string{"crew env phone-speak/wrk1 ai-tutor-api", "eval \"$(crew env phone-speak/wrk1 ai-tutor-api)\""},
		},
		{
			Name:        "run",
			Description: "Run a command inside a project's checkout with its bindings resolved into the environment. This is how evals, scripts and CLIs that crew does not start get the same URLs the dev servers got. Everything after -- is the command, untouched.",
			Usage:       "crew run <workspace>[/<worktree>] <project> -- <command...>",
			Examples: []string{
				"crew run phone-speak/wrk1 ai-tutor-api -- make eval",
				"crew run phone-speak/wrk2 ai-tutor-api -- uv run python -m tests.smoke",
			},
		},
		{
			Name:        "migrate",
			Description: "Move pre-worktree workspaces to the nested layout. <name>-wrkN becomes workspace <name>, worktree wrkN; anything else becomes <name>/main. Prints the full plan, backs up workspace and route files, asks, then moves checkouts with git worktree move and renames branches. Old paths are printed afterwards so anything holding them can be updated.",
			Usage:       "crew migrate [--dry-run]",
			Flags: []FlagInfo{
				{Name: "--dry-run", Description: "Print the plan and stop"},
			},
			Examples: []string{"crew migrate --dry-run", "crew migrate"},
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
