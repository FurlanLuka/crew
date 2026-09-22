package help

import (
	"encoding/json"
	"fmt"
	"io"
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
	// Notes hold what a description cannot: the description also renders in
	// the parent's command list, so anything longer than a line lives here
	// and shows only on the command's own page.
	Notes []string `json:"notes,omitempty"`
	TUI   bool     `json:"tui,omitempty"`
}

type FlagInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Required    bool   `json:"required,omitempty"`
	Default     string `json:"default,omitempty"`
}

var Root = CommandInfo{
	Name:        "crew",
	Description: "Workspaces of git worktrees for coding agents: dev servers on stable ports, env bindings between projects, Claude Code and editors launched in place. Every command prints rows or --json.",
	Subcommands: []CommandInfo{
		{
			Name:        "workspace",
			Description: "Interactive workspace manager — create, configure, and launch workspaces",
			TUI:         true,
			Notes:       []string{"Same actions without the TUI: crew add workspace, crew add worktree, crew duplicate, crew rm, crew launch / claude / edit / open."},
		},
		{
			Name:        "project",
			Description: "Interactive project manager — add/remove projects and configure dev servers",
			TUI:         true,
			Notes:       []string{"Same actions without the TUI: crew add project (--setup, --env-cmd), crew dev add / rm / setup, crew add binding (--scan --apply), crew rm project."},
		},
		{
			Name:        "add",
			Description: "Add a project, workspace, worktree, or binding (CLI)",
			Subcommands: []CommandInfo{
				{
					Name:        "project",
					Description: "Register a git repo in the global project pool. Projects can be added to multiple workspaces.",
					Usage:       "crew add project <name> <path> [--setup=<cmd>] [--env-cmd=<cmd>] | crew add project <name> [--setup=<cmd>] [--env-cmd=<cmd>] [--path=<dir>]",
					Flags: []FlagInfo{
						{Name: "--setup=<cmd>", Description: "Command that installs a fresh checkout, replacing lockfile detection (mise still runs first). On an existing project, updates it; empty clears it."},
						{Name: "--env-cmd=<cmd>", Description: "Command that writes a fresh checkout's env files (make get-env — sops, a vault); runs after the install, over the .env crew copied in. Must write files, not print values — its output is logged. On an existing project, updates it; empty clears it."},
						{Name: "--path=<dir>", Description: "On an existing project, where its canonical checkout now lives (the repo moved)"},
					},
					Examples: []string{
						"crew add project my-api /home/user/repos/api",
						"crew add project frontend ~/repos/web-app",
						"crew add project checkout-api ~/repos/checkout-api --setup=\"make sync\" --env-cmd=\"make get-env\"",
						"crew add project checkout-api --path=~/code/checkout-api",
					},
				},
				{
					Name:         "workspace",
					Description:  "Create a workspace, or add projects to one — any number in one call, the workspace created if it does not exist. Every name is checked before anything happens; then the members are recorded and, in every worktree of the workspace, one runner per new project starts in the background (checkout, install, smoke of its own servers) — `added` means recorded and installing. A checkout or install that fails keeps the member, recorded on the worktree for crew fix / verify. --wait stays until every runner is done and reports `failed` rows.",
					Usage:        "crew add workspace <name> [<project>[:<role>] ...] [--role=<role>] [--direct] [--wait]",
					OutputFormat: "<project>\\t<added|failed>\\t<worktree|direct>\\t<detail>",
					Flags: []FlagInfo{
						{Name: "<project>[:<role>]", Description: "A pool project, with its role in this workspace after a colon (\"store-api:Backend API\"); without one, \"works on <project>\""},
						{Name: "--role=<r>", Description: "The role for a single project — the same as <project>:<role>"},
						{Name: "--direct", Description: "Attach the canonical checkouts instead of creating worktrees. Changes are NOT isolated. Only one workspace at a time may direct-mount a given project."},
						{Name: "--wait", Description: "Stay until every runner is done; rows then say added or failed, exit 1 on any failure"},
					},
					Examples: []string{
						"crew add workspace feature-auth",
						"crew add workspace feature-auth my-api --role=\"Auth service\"",
						"crew add workspace store-front store-api:\"Backend API\" store-app:\"iOS app\" checkout-api",
						"crew add workspace quickfix my-api --role=\"Hotfix\" --direct",
					},
				},
				{
					Name:        "worktree",
					Description: "Make a new working copy of every project, in the background: the worktree is recorded, its ports reserved, and one runner per project starts (a window of tmux session crew-setup-<ws>--<name>) doing checkout → .env → install → env command → a smoke of its own servers, each watched until it listens on its port, dies, or a minute passes. The command returns at once. In a terminal it lands on the worktree page, which shows the runners; without one it prints how to watch: crew setup status <ref>. A failure is recorded on the worktree the moment it happens, while the other runners continue — crew fix <ref> --print has it before the slowest install ends. --wait stays until every runner is done, prints the summary and exits 1 if anything is recorded. .env comes from the canonical repo or a sibling worktree; --pull fast-forwards the local base branches first.",
					Usage:       "crew add worktree <workspace>/<name> [--pull] [--no-install] [--no-smoke] [--wait]",
					Flags: []FlagInfo{
						{Name: "--pull", Description: "Fast-forward each project's local base branch to origin first. Never touches a checked-out feature branch; refuses when the base has diverged or is checked out with uncommitted changes."},
						{Name: "--no-install", Description: "Check out only; skip mise and package installs (and so the smoke)"},
						{Name: "--no-smoke", Description: "Skip the smoke start"},
						{Name: "--wait", Description: "Stay until every runner is done: the table live in a terminal, then the summary; exit 1 if anything is recorded. --json then carries the health"},
					},
					Examples: []string{"crew add worktree store-front/wrk3", "crew add worktree store-front/wrk3 --wait", "crew add worktree store-front/wrk3 --no-install"},
				},
				{
					Name:        "binding",
					Description: "Declare an env variable a project needs, and how crew computes it at dev-server start. Value is a template: {{proj}} is http://localhost:<port> of that project's dev server, {{proj.host}} is localhost:<port> (for ws://, https://, or a path), {{proj.port}} the number; write {{proj/server}} when the project has more than one. {{worktree}} and {{workspace}} are the names. Resolved values are injected into the process env — env files are never rewritten. With --scan, propose bindings from the project's own .env.",
					Usage:       "crew add binding <project> --var=<VAR> (--url=<proj[/server]> | --host=<proj[/server]> | --port=<proj[/server]> | --value=<template>) | --scan [--apply]",
					Flags: []FlagInfo{
						{Name: "--var=<VAR>", Description: "Environment variable to set"},
						{Name: "--url=<p[/s]>", Description: "Shorthand for --value='{{p/s}}' — http://localhost:<port> of that dev server"},
						{Name: "--host=<p[/s]>", Description: "Shorthand for --value='{{p/s.host}}' — localhost:<port>, for any other scheme"},
						{Name: "--port=<p[/s]>", Description: "Shorthand for --value='{{p/s.port}}' — just the port number"},
						{Name: "--value=<t>", Description: "Full template, for composition (e.g. ws://{{signals.host}}/rtc)"},
						{Name: "--scan", Description: "Read the project's .env and propose bindings for values pointing at ports crew allocates"},
						{Name: "--apply", Description: "With --scan, add every unambiguous proposal"},
					},
					Examples: []string{
						"crew add binding checkout-api --var=STORE_API_URL --url=store-api",
						"crew add binding checkout-api --var=SIGNALS_URL --value='ws://{{signals.host}}/rtc'",
						"crew add binding checkout-api --var=SIGNALS_AGENT_NAME --value='{{worktree}}'",
						"crew add binding checkout-api --scan",
						"crew add binding checkout-api --scan --apply",
					},
				},
				{
					Name:        "override",
					Description: "Pin a variable for one worktree. Beats whatever the binding would resolve, and is the acknowledgement for a binding that legitimately never resolves here — it stops printing as an anomaly on every start. Key is VAR, or project.VAR to pin one project when two share a name.",
					Usage:       "crew add override <workspace>/<worktree> <VAR>=<value>",
					Examples: []string{
						"crew add override store-front/wrk2 STORE_API_URL=https://dev-api.store.com",
						"crew add override store-front/wrk2 checkout-api.API_URL=https://tutor.dev",
					},
				},
			},
		},
		{
			Name:        "config",
			Description: "View and edit crew settings (server IP, SSH host, proxy port, domain)",
			TUI:         true,
			Notes:       []string{"Same actions without the TUI: crew config show / set / refresh, crew trash empty, crew uninstall."},
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
					Notes: []string{
						"server_ip: ipconfig getifaddr en0 (Wi-Fi) or tailscale ip -4. Detected from the first non-loopback interface when unset.",
						"domain: needs wildcard DNS (*.dev.example.com) resolving to server_ip; the default <server_ip>.nip.io needs nothing.",
						"A changed server_ip, domain or proxy_port takes effect on the next crew dev start|restart --proxy — the proxy is relaunched when its settings differ.",
					},
				},
				{
					Name:        "refresh",
					Description: "Rewrite the tmux config crew manages (~/.crew/tmux.conf) to the current default. Only a file crew wrote is touched.",
					Usage:       "crew config refresh",
					Examples:    []string{"crew config refresh"},
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
					Usage:        "crew ls worktrees [<workspace>] [--size]",
					OutputFormat: "<workspace>/<worktree>\\t<path>\\t[<size>\\t][dev|installing][\\t<recorded failure>]",
					Flags: []FlagInfo{
						{Name: "--size", Description: "Add bytes on disk per worktree. Walks every file — slow on one with a full build inside"},
					},
					Examples: []string{"crew ls worktrees", "crew ls worktrees store-front", "crew ls worktrees --size"},
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
					Examples:     []string{"crew ls bindings checkout-api", "crew ls bindings checkout-api --check=store-front/wrk1"},
				},
				{
					Name:         "overrides",
					Description:  "List a worktree's overrides",
					Usage:        "crew ls overrides <workspace>/<worktree>",
					OutputFormat: "<key>\\t<value>",
					Examples:     []string{"crew ls overrides store-front/wrk2"},
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
			Name:        "verify",
			Description: "Check a worktree the way creating it does, one runner per project in the background: a project with no checkout is checked out and installed, one whose last install failed is installed again, and every project's servers are smoked — started, watched until each listens, dies, or a minute passes, stopped. Each runner writes or clears its own project's verdict; the worktree page stays locked until every record is cleared. Name projects to verify only those — the one you just fixed — while the rest keep their record. Returns at once with crew setup status <ref> as the way to watch; --wait stays to the end and exits 1 if anything is recorded. Refuses while the worktree's servers are running (it would restart them) or while a setup is already running on it.",
			Usage:       "crew verify <workspace>[/<worktree>] [<project>...] [--wait]",
			Flags: []FlagInfo{
				{Name: "<project>...", Description: "Only these projects; the others keep whatever is recorded"},
				{Name: "--wait", Description: "Stay until every runner is done; then the issues, exit 1 on any"},
			},
			Examples: []string{"crew verify store-front/wrk2", "crew verify store-front/wrk2 --wait", "crew verify store-front/wrk2 store-api"},
		},
		{
			Name:        "fix",
			Description: "Open Claude Code in the worktree with what failed in front of it: each issue with its stage (checkout, install, smoke), the error or log tail, the env anomalies, and the instruction to fix the cause and run crew verify. With nothing recorded it checks the running servers (crew dev check) or, with none running, runs verify first, so it is one command either way. Replaces the crew process. --print writes that same prompt to stdout instead — for an agent that is already here; without a terminal that is what happens anyway. --json is the recorded health as data.",
			Usage:       "crew fix <workspace>[/<worktree>] [--print]",
			Flags: []FlagInfo{
				{Name: "--print", Description: "Print the fix prompt (issues, evidence, anomalies) instead of opening Claude; no terminal needed"},
			},
			Examples: []string{"crew fix store-front/wrk2", "crew fix store-front/wrk2 --print", "crew fix store-front/wrk2 --json"},
		},
		{
			Name:        "claude",
			Description: "Run Claude Code in the worktree, in this terminal — the worktree page's 'Claude in terminal'. Permissions skipped, every project passed with --add-dir, the orientation prompt injected (projects, roles, and a crew section on driving the servers). Replaces the crew process.",
			Usage:       "crew claude <workspace>[/<worktree>]",
			Examples:    []string{"crew claude store-front/wrk1"},
		},
		{
			Name:        "edit",
			Description: "Open the worktree in the local editor (Cursor, else VS Code) with the orientation prompt written and Claude wired up — the worktree page's 'Editor + Claude'. For a remote-SSH URL instead, see crew code.",
			Usage:       "crew edit <workspace>[/<worktree>] [--editor=cursor|code]",
			Flags: []FlagInfo{
				{Name: "--editor=<cursor|code>", Description: "Which editor; detected when omitted"},
			},
			Examples: []string{"crew edit store-front/wrk1", "crew edit store-front/wrk1 --editor=code"},
		},
		{
			Name:        "open",
			Description: "Start a shell in the worktree directory — the worktree page's 'Shell here'. Replaces the crew process; exit returns to where you were.",
			Usage:       "crew open <workspace>[/<worktree>]",
			Examples:    []string{"crew open store-front/wrk1"},
		},
		{
			Name:        "code",
			Description: "Print the remote-SSH URL that opens the worktree in Cursor/VS Code on another machine. Requires ssh_host (crew config set ssh_host <host>). For multi-project worktrees, generates a .code-workspace file. To open the local editor, see crew edit.",
			Usage:       "crew code <workspace>[/<worktree>]",
			Examples:    []string{"crew code feature-auth"},
		},
		{
			Name:        "start",
			Description: "Generate and print the orientation prompt for a workspace — the project list, working directories, roles, and worktree/direct framing. Ends with a crew section: the ref, and the commands that session should drive the servers with. Every launch (crew claude, crew edit, the page) injects it; paste it into a Claude opened some other way.",
			Usage:       "crew start <workspace>[/<worktree>]",
			Examples:    []string{"crew start feature-auth"},
		},
		{
			Name:        "launch",
			Description: "Open the interactive launch view — choose Editor + Claude or Claude (both skip permissions), start dev servers, and begin working",
			Usage:       "crew launch [<workspace>[/<worktree>]]",
			TUI:         true,
			Examples:    []string{"crew launch", "crew launch feature-auth", "crew launch store-front/wrk2"},
		},
		{
			Name:        "dev",
			Description: "Manage dev servers and reverse proxy. Each project can have named dev servers that run in tmux windows behind a shared reverse proxy.",
			Subcommands: []CommandInfo{
				{
					Name:         "setup",
					Description:  "Detect a dev server for a project from package.json (a dev script, else start) and print it; --apply records it as a server named after the project. Detection cannot know the port, so --apply needs --port. crew dev add is the full form.",
					Usage:        "crew dev setup <project> [--apply --port=<port>]",
					OutputFormat: "<detected|added>\\t<name>\\t<command>",
					Flags: []FlagInfo{
						{Name: "--apply", Description: "Record the detected server; needs --port"},
						{Name: "--port=<port>", Description: "The reference port for the detected server"},
					},
					Examples: []string{"crew dev setup web", "crew dev setup web --apply --port=3000"},
				},
				{
					Name:        "add",
					Description: "Add a dev server to a project. The --port is for reference only — at runtime, crew assigns a random free port via the PORT env var.",
					Usage:       "crew dev add <project> --name=<name> --port=<port> --cmd=<command> [--dir=<subdir>]",
					Flags: []FlagInfo{
						{Name: "--name=<n>", Description: "Server name (used as subdomain)", Required: true},
						{Name: "--port=<p>", Description: "The port the server conventionally uses — reference only. Crew always allocates a free port and passes it as $PORT", Required: true},
						{Name: "--cmd=<c>", Description: "Start command (use $PORT for the dynamic port)", Required: true},
						{Name: "--dir=<d>", Description: "Subdirectory relative to project root (for monorepos)"},
					},
					Notes: []string{
						"The command runs with PORT=<allocated> in its environment; it must bind that port (next dev -p $PORT, --port $PORT, process.env.PORT). --port is the reference for .env scans and conflict checks, not what runs.",
						"Sibling URLs come from env vars the project reads at start — the ones crew add binding fills.",
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
					Description: "Start all dev servers for a worktree in tmux windows. Ports are always allocated fresh — the configured --port is reference only — and a worktree keeps its ports across restarts, so any number of worktrees can run at once. URLs are http://localhost:<port>. With --proxy the shared reverse proxy starts too and URLs become http://<server>--<workspace>--<worktree>.<domain>, reachable from other devices on the LAN. Bindings are resolved after ports are allocated and injected into each server's env; anything left alone or pointing at a port crew gave to another project is printed.",
					Usage:       "crew dev start <workspace>[/<worktree>] [--proxy]",
					Flags: []FlagInfo{
						{Name: "--proxy", Description: "Also run the shared reverse proxy and address servers by hostname"},
					},
					Examples: []string{"crew dev start feature-auth", "crew dev start store-front/wrk2", "crew dev start store-front/wrk2 --proxy", "crew dev start store-front/wrk2 --json"},
					Notes: []string{
						"--proxy: one reverse proxy on <server_ip>:<proxy_port> (crew config show) serves every running server at http://<server>--<workspace>--<worktree>.<domain>; http://<server_ip>:<proxy_port>/ lists them.",
						"A URL works here but not on another device: open http://<server_ip>:<proxy_port>/ there first.",
						"Loads: the hostname is the problem — <ip>.nip.io resolves to a private IP, which router DNS rebind protection (Fritz!Box, UniFi, dnsmasq, Pi-hole), NextDNS or iOS Private Relay refuse. Allow nip.io there, turn off Limit IP Address Tracking for that Wi-Fi, or use a domain of your own (crew config set domain).",
						"Does not load: the device cannot reach this machine — different network, guest/AP isolation, VPN, cellular.",
						"Tailscale sidesteps both: crew config set server_ip <tailscale ip>, then crew dev restart <ref> --proxy. URLs become <server>--<ws>--<wt>.100.x.y.z.nip.io and work off the LAN too.",
					},
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
					Usage:       "crew dev restart <workspace>[/<worktree>] [--proxy]",
					Flags: []FlagInfo{
						{Name: "--proxy", Description: "Also run the shared reverse proxy and address servers by hostname"},
					},
					Examples: []string{"crew dev restart feature-auth", "crew dev restart store-front/wrk2 --proxy"},
				},
				{
					Name:         "status",
					Description:  "Show running dev servers and their URLs. Without an argument, shows all. A bare workspace name shows all of its worktrees. A proxied worktree whose proxy is down gets a ! line on stderr.",
					Usage:        "crew dev status [<workspace>[/<worktree>]]",
					OutputFormat: "<workspace>/<worktree>\\t<server>\\t<port>\\t<url>",
					Examples:     []string{"crew dev status", "crew dev status feature-auth"},
				},
				{
					Name:         "check",
					Description:  "Look at a worktree's running servers the way the smoke does: a pane that exited is died; one that runs without anything accepting on its port is not listening — a failure when some binding points at it, a note when nothing does. Bare, it is one look; --wait watches each server until it listens, dies, or a minute passes — the thing to run right after a start. Exit 1 on any failure; crew fix <ref> --print then carries the evidence.",
					Usage:        "crew dev check <workspace>[/<worktree>] [--wait]",
					OutputFormat: "<project>/<server>\\t<running|died|not listening>\\t<port>\\t<took>\\t<detail>",
					Flags: []FlagInfo{
						{Name: "--wait", Description: "Keep looking until every server has a verdict (up to a minute) instead of one look now"},
					},
					Examples: []string{"crew dev check store-front/wrk2 --wait", "crew dev check store-front/wrk2 --json"},
				},
				{
					Name:         "proxy",
					Description:  "The shared reverse proxy: whether its session is up and answering, what domain and port it was launched with, and its status page URL. stop kills the proxy alone — worktrees keep running on their ports; crew dev restart <ref> --proxy brings the hostnames back.",
					Usage:        "crew dev proxy [status|stop]",
					OutputFormat: "<up|up (not listening)|down>\\t<domain>\\t<port>\\t<status url>",
					Examples:     []string{"crew dev proxy status", "crew dev proxy stop"},
				},
				{
					Name:        "logs",
					Description: "Print the log for a dev server. Logs are truncated each time the server starts, so they only cover the current run. Use -f to follow live output, --lines for just the end.",
					Usage:       "crew dev logs <workspace>[/<worktree>] <server> [-f|--follow] [--lines=<n>]",
					Flags: []FlagInfo{
						{Name: "-f, --follow", Description: "Stream new output as it arrives (tail -f)"},
						{Name: "--lines=<n>", Description: "Only the last n lines"},
					},
					Examples: []string{"crew dev logs feature-auth api", "crew dev logs feature-auth web -f", "crew dev logs feature-auth api --lines=50"},
				},
				{
					Name:        "tui",
					Description: "Open the interactive dev server view for a worktree — start, stop, restart, and tail logs",
					Usage:       "crew dev tui <workspace>[/<worktree>]",
					TUI:         true,
					Examples:    []string{"crew dev tui store-front/wrk1"},
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
					Examples:    []string{"crew rm worktree store-front/wrk3"},
				},
				{
					Name:        "binding",
					Description: "Remove a binding from a project",
					Usage:       "crew rm binding <project> <var>",
					Examples:    []string{"crew rm binding checkout-api STORE_API_URL"},
				},
				{
					Name:        "override",
					Description: "Remove a worktree override; the binding applies again",
					Usage:       "crew rm override <workspace>/<worktree> <VAR>",
					Examples:    []string{"crew rm override store-front/wrk2 STORE_API_URL"},
				},
			},
			Examples: []string{"crew rm feature-auth"},
		},
		{
			Name:        "duplicate",
			Description: "Duplicate a worktree within its workspace — fresh checkouts of the same projects, with the source worktree's overrides copied across before its runners start. Made the way crew add worktree makes one: in the background, one runner per project; --wait stays to the end.",
			Usage:       "crew duplicate <workspace>[/<worktree>] <new-worktree> [--no-install] [--no-smoke] [--wait]",
			Examples:    []string{"crew duplicate store-front/wrk1 wrk3"},
		},
		{
			Name:         "env",
			Description:  "Print a project's resolved env for a worktree, against the dev servers currently running there. stdout is pure KEY=VALUE so it can be eval'd; the full table and any variables left alone go to stderr. Values are point-in-time — prefer `crew run` over pasting them anywhere.",
			Usage:        "crew env <workspace>[/<worktree>] <project>",
			OutputFormat: "<VAR>=<value>",
			Examples:     []string{"crew env store-front/wrk1 checkout-api", "eval \"$(crew env store-front/wrk1 checkout-api)\""},
		},
		{
			Name:        "run",
			Description: "Run a command inside a project's checkout with its bindings resolved into the environment. This is how evals, scripts and CLIs that crew does not start get the same URLs the dev servers got. Everything after -- is the command, untouched.",
			Usage:       "crew run <workspace>[/<worktree>] <project> -- <command...>",
			Examples: []string{
				"crew run store-front/wrk1 checkout-api -- make eval",
				"crew run store-front/wrk2 checkout-api -- uv run python -m tests.smoke",
			},
		},
		{
			Name:        "migrate",
			Description: "Move pre-worktree workspaces to the nested layout. <name>-wrkN becomes workspace <name>, worktree wrkN; anything else becomes <name>/main. Prints the full plan, backs up workspace and route files, asks, then moves checkouts with git worktree move and renames branches. Old paths are printed afterwards so anything holding them can be updated.",
			Usage:       "crew migrate [--dry-run] [--yes]",
			Flags: []FlagInfo{
				{Name: "--dry-run", Description: "Print the plan and stop"},
				{Name: "--yes", Description: "Apply without the confirmation prompt"},
			},
			Examples: []string{"crew migrate --dry-run", "crew migrate"},
		},
		{
			Name:        "export",
			Description: "Write projects and workspace membership to a file for another machine. Without flags, a picker: tick projects, then the workspaces those projects fully cover. Projects carry their dev servers, bindings, setup and env commands and origin remote; workspaces carry which projects with which roles. Worktrees, ports and overrides stay local.",
			Usage:       "crew export [<file>] [--all | --projects=<a,b> [--workspaces=<x,y>]]",
			Flags: []FlagInfo{
				{Name: "--all", Description: "Every project and workspace, no picker"},
				{Name: "--projects=<a,b>", Description: "Only these projects"},
				{Name: "--workspaces=<x,y>", Description: "Only these workspaces; every project they use must be in --projects"},
			},
			Examples: []string{"crew export", "crew export ~/Desktop/crew.json --all", "crew export --projects=store-api,checkout-api --workspaces=store-front"},
		},
		{
			Name:         "import",
			Description:  "Bring a crew export into this machine. Bare, a wizard walks one card per item: each project card shows the path and whether it exists here, suggests one found beside a repo crew already knows, or clones the origin remote; y imports, e edits name/path/setup/env cmd, n skips, r replaces one already here; then each workspace. The same decisions as commands: --plan shows every item's status, project <name> imports one with the choice as flags, workspace <name> creates one, --all takes everything at once.",
			Usage:        "crew import <file> [--plan | --all [--clone] [--replace] [--pull] [--no-install] [--no-smoke] [--wait] | project <name> [--path=<dir>] [--clone[=<dir>]] [--replace] [--name=<new>] [--setup=<cmd>] [--env-cmd=<cmd>] | workspace <name> [--pull] [--no-install] [--no-smoke] [--wait]]",
			OutputFormat: "<project|workspace>\\t<name>\\t<status|outcome>\\t<detail>",
			Flags: []FlagInfo{
				{Name: "--plan", Description: "Inspect only: one row per item with what would happen here (suggested path, clone target, missing members)"},
				{Name: "--all", Description: "Import everything new, keep what exists, refuse if any path is missing — never guesses. With --clone, missing repos are cloned where a card would offer; with --replace, records of the same name are swapped out. Workspaces are made the way crew add worktree makes one"},
				{Name: "--pull", Description: "workspace: fast-forward the local base branches from origin before checking out (the base table is printed either way)"},
				{Name: "--no-install", Description: "workspace: skip the installs"},
				{Name: "--no-smoke", Description: "workspace: skip the smoke start"},
				{Name: "--wait", Description: "workspace: stay until its runners are done; the row then carries what was recorded"},
				{Name: "--path=<dir>", Description: "project: use this checkout instead of the exported path"},
				{Name: "--clone[=<dir>]", Description: "project: clone the origin remote when the path is not here and no sibling was found — beside a known repo (the plan's clone target) or into <dir>"},
				{Name: "--replace", Description: "project: swap out the local record of the same name"},
				{Name: "--name=<new>", Description: "project: import under another name (bindings pointing at the old name are left alone)"},
				{Name: "--setup=<cmd>", Description: "project: override the setup command"},
				{Name: "--env-cmd=<cmd>", Description: "project: override the env command"},
			},
			Examples: []string{
				"crew import ~/Desktop/crew.json",
				"crew import crew.json --plan",
				"crew import crew.json project checkout-api --clone",
				"crew import crew.json project store-api --path=~/code/store-api --replace",
				"crew import crew.json workspace store-front",
				"crew import crew.json --all --clone",
			},
		},
		{
			Name:         "trash",
			Description:  "Removed checkouts are moved to ~/.crew/trash and deleted in the background, so removal returns at once. This shows what is still clearing; 'crew trash empty' deletes it now, for when the background delete never finished.",
			Usage:        "crew trash [empty]",
			OutputFormat: "<path>\\t<size>\\t<n> entries\\t<note>  |  <path>\\tempty",
			Examples:     []string{"crew trash", "crew trash empty"},
		},
		{
			Name:         "debug",
			Description:  "Follow the debug log (~/.crew/debug.log): every tmux, git, editor, package-manager, mise and trash command crew ran, with errors. Binding values are never logged. --tail prints the last lines and returns; --json parses them.",
			Usage:        "crew debug [--tail=<n>]",
			OutputFormat: "<date> <time> [<category>] <message>",
			TUI:          true,
			Flags: []FlagInfo{
				{Name: "--tail=<n>", Description: "Print the last n lines instead of following (--json alone implies 200)"},
			},
			Examples: []string{"crew debug", "crew debug --tail=50", "crew debug --tail=200 --json"},
		},
		{
			Name:        "setup",
			Description: "Re-run every project's install steps in a worktree (or the named projects'), one runner per project in the background: mise install, then the lockfile's package manager (uv sync, pnpm install, npm ci, yarn) or the project's explicit setup command, then the project's env command when it has one, then a smoke of that project's servers. Idempotent — the fix for an install that failed when the worktree was created. Returns at once; crew setup status <ref> is how to watch, --wait stays to the end. Refuses while the worktree's servers are running (the smoke would restart them; --no-smoke) or while a setup is already running on it.",
			Usage:       "crew setup <workspace>[/<worktree>] [<project>...] [--no-smoke] [--wait]",
			Flags: []FlagInfo{
				{Name: "<project>...", Description: "Only these projects"},
				{Name: "--no-smoke", Description: "Skip the smoke start"},
				{Name: "--wait", Description: "Stay until every runner is done; then the issues, exit 1 on any"},
			},
			Examples: []string{"crew setup store-front/wrk3", "crew setup store-front/wrk3 store-api --wait"},
			Subcommands: []CommandInfo{
				{
					Name:         "status",
					Description:  "What each project's runner has done on a worktree — creation, a verify or a setup, still going or finished: one row per project with its state (starting, running, ok, failed, interrupted), its steps in order with how long each took, the running one marked, a failed one with its reason. A runner that vanished without a verdict (a killed window, a reboot) reads as interrupted and is recorded on the worktree as a failure. Exit 2 while any runner is alive, 1 once all stopped with anything recorded, 0 otherwise — an agent polls this and acts on the first failure while the rest still install. --wait stays until no runner is left (then 1 or 0).",
					Usage:        "crew setup status <workspace>[/<worktree>] [--wait]",
					OutputFormat: "✓|✗|▸ <project>  <step> <took> · <step> <took> · ▸ <running step> | <step> — <reason>",
					Flags: []FlagInfo{
						{Name: "--wait", Description: "Stay until every runner is done, the table live in a terminal"},
					},
					Examples: []string{"crew setup status store-front/wrk3", "crew setup status store-front/wrk3 --wait", "crew setup status store-front/wrk3 --json"},
				},
				{
					Name:        "logs",
					Description: "The last lines of one project's runner log: its steps as they finished and everything its install printed — live while it runs, kept afterwards. What to read when a step is taking long.",
					Usage:       "crew setup logs <workspace>[/<worktree>] <project> [--lines=<n>]",
					Flags: []FlagInfo{
						{Name: "--lines=<n>", Description: "How many lines from the end (default 50)"},
					},
					Examples: []string{"crew setup logs store-front/wrk3 store-api", "crew setup logs store-front/wrk3 store-api --lines=200"},
				},
			},
		},
		{
			Name:        "uninstall",
			Description: "Stop every dev server and remove the crew binary. ~/.crew — workspace config and every worktree checkout — is kept unless --purge is given, which removes the checkouts through git and deletes the directory.",
			Usage:       "crew uninstall [--purge] [--yes]",
			Flags: []FlagInfo{
				{Name: "--purge", Description: "Also remove every workspace's checkouts and ~/.crew. Uncommitted work in checkouts is lost."},
				{Name: "--yes", Description: "Skip the confirmation prompt"},
			},
			Examples: []string{"crew uninstall", "crew uninstall --purge"},
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
// Run prints help for the named command path. asJSON dumps the whole tree;
// main has already stripped the global --json flag, so it is passed in.
func Run(args []string, asJSON bool) {
	filtered := args
	if asJSON {
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

	printHelp(os.Stdout, cmd, filtered)
}

func findSubcommand(parent *CommandInfo, name string) *CommandInfo {
	for i := range parent.Subcommands {
		if parent.Subcommands[i].Name == name {
			return &parent.Subcommands[i]
		}
	}
	return nil
}

func printHelp(w io.Writer, cmd *CommandInfo, path []string) {
	fullName := "crew"
	if len(path) > 0 {
		fullName += " " + strings.Join(path, " ")
	}

	fmt.Fprintf(w, "%s - %s\n", fullName, cmd.Description)

	if cmd.Usage != "" {
		fmt.Fprintf(w, "\nUsage: %s\n", cmd.Usage)
	}

	if len(cmd.Subcommands) > 0 {
		fmt.Fprintln(w, "\nCommands:")
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
			fmt.Fprintf(w, "  %-*s  %s%s\n", maxLen, sc.Name, sc.Description, suffix)
		}
		hint := "crew help <command>"
		if len(path) > 0 {
			hint = "crew help " + strings.Join(path, " ") + " <command>"
		}
		fmt.Fprintf(w, "\nRun '%s' for details.\n", hint)
	}

	if len(cmd.Flags) > 0 {
		fmt.Fprintln(w, "\nFlags:")
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
			fmt.Fprintf(w, "  %-*s  %s%s\n", maxLen, f.Name, f.Description, extra)
		}
	}

	if cmd.OutputFormat != "" {
		fmt.Fprintf(w, "\nOutput: %s\n", cmd.OutputFormat)
	}

	if len(cmd.Examples) > 0 {
		fmt.Fprintln(w, "\nExamples:")
		for _, ex := range cmd.Examples {
			fmt.Fprintf(w, "  %s\n", ex)
		}
	}

	if len(cmd.Notes) > 0 {
		fmt.Fprintln(w, "\nNotes:")
		for _, n := range cmd.Notes {
			fmt.Fprintf(w, "  %s\n", n)
		}
	}
}
