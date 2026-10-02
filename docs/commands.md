<!-- Generated from crew's help (crew/internal/help). Do not edit: change help.go, then run
     UPDATE_DOCS=1 go test ./internal/help -run TestCommandsDocIsCurrent (from crew/). -->

# Commands

Workspaces of git worktrees for coding agents: dev servers on stable ports, env bindings between projects, Claude Code and editors launched in place. Every command prints rows or --json. Bare crew starts crew's server when needed and opens its page — Set up (projects, workspaces, worktrees, machines, settings) and Voice OS — in the browser; with no terminal, over SSH or with --no-open it prints the link.

Lists print tab-separated rows; `--json` gives the same data as JSON. `crew help <command>` prints the same page in the terminal.

## `crew workspace`

The workspaces table (what crew ls workspaces prints) and a pointer to where they are configured now: crew's page in the browser (run crew). The terminal UI that lived here is gone.

```
crew workspace
```

Output: `<name>\t<n> projects\t<worktree>,<worktree>`

Everything the page does is a command: crew add workspace <ws> <p>…, crew rm workspace <ws> <p>, crew add worktree, crew rename worktree, crew duplicate, crew rm worktree, crew rm <ws>; crew launch opens Claude or an editor on a worktree.

## `crew project`

The projects table (what crew ls projects prints) and a pointer to where they are configured now: crew's page in the browser (run crew). The terminal UI that lived here is gone.

```
crew project
```

Output: `<name>\t<path>\t<remote|->`

Everything the page does is a command: crew add project <url> | <name> --path (--setup, --env-cmd), crew add project --scan, crew dev setup / add (--rename) / rm, crew add binding (--scan --apply, --dry-run), crew check project (--status), crew fix check/<name>, crew rm project.

## `crew add`

Add a project, workspace, worktree, or binding (CLI)

### `crew add project`

Register a project in the global pool by its git URL (git@…, https://…, ssh://…, file://… — a full URL, not owner/repo): the repo is cloned into ~/.crew/projects/<name>, and its remote is what names the project from then on — in ls projects, in an export, on another machine. --path=<dir> instead adopts a checkout you already have (the repo's own origin is its identity; without one it cannot be exported for cloning). A bare path is refused. Refuses a URL when the name is taken or that directory exists. Projects can be added to multiple workspaces. crew check project <name> then proves the config reproduces from nothing.

```
crew add project <name> <url> [--setup=<cmd>] [--env-cmd=<cmd>] | crew add project <url> [--setup=<cmd>] [--env-cmd=<cmd>] | crew add project <name> --path=<dir> [--setup=<cmd>] [--env-cmd=<cmd>] | crew add project <name> [--setup=<cmd>] [--env-cmd=<cmd>] [--path=<dir>] | crew add project --scan
```

Output: `--scan: <name>\t<path>\t<remote|->\t<known|new>`

- `<url>` — Alone, the URL names the project: the last segment of the repo (git@github.com:example/store-api.git → store-api)
- `--scan` — List the checkouts this machine already has — ~/code, ~/projects, ~/dev, ~/src, ~/Developer, ~/work, ~/repos, three levels deep, never Documents, Desktop or Downloads; hidden folders, node_modules and git worktrees skipped — each with its remote and whether the pool knows it (by path or by the same repo). Lists only; adding is crew add project <name> --path=<dir>
- `--setup=<cmd>` — Command that installs a fresh checkout, replacing lockfile detection (mise still runs first). On an existing project, updates it; empty clears it.
- `--env-cmd=<cmd>` — Command that writes a fresh checkout's env files (make get-env — sops, a vault); runs after the install, over the .env crew copied in. Must write files, not print values — its output is logged. On an existing project, updates it; empty clears it.
- `--path=<dir>` — A checkout you already have, adopted as the canonical instead of a clone; on an existing project, where its canonical checkout now lives (the repo moved)

```bash
crew add project my-api git@github.com:example/my-api.git
crew add project git@github.com:example/store-api.git
crew add project --scan --json
crew add project signals git@github.com:example/signals.git --env-cmd="make get-env"
crew add project checkout-api --path=~/repos/checkout-api --setup="make sync"
crew add project checkout-api --path=~/code/checkout-api
```

### `crew add workspace`

Create a workspace, or add projects to one — any number in one call, the workspace created if it does not exist (and taken back if a name fails the pre-flight). Every name is checked before anything happens; then the members are recorded and, in every worktree of the workspace, one runner per new project starts in the background (checkout, install, smoke of its own servers) — `added` means recorded and installing. A checkout or install that fails keeps the member, recorded on the worktree for crew fix / verify. --wait stays until every runner is done and reports `failed` rows.

```
crew add workspace <name> [<project> ...] [--direct] [--wait]
```

Output: `<project>\t<added|failed>\t<worktree|direct>\t<detail>`

- `<project>` — A pool project (crew ls projects); the pre-4.0 colon form with a role after the name is refused — roles are gone
- `--direct` — Attach the canonical checkouts instead of creating worktrees. Changes are NOT isolated. Only one workspace at a time may direct-mount a given project.
- `--wait` — Stay until every runner is done; rows then say added or failed, exit 1 on any failure

```bash
crew add workspace feature-auth
crew add workspace feature-auth my-api
crew add workspace store-front store-api store-app checkout-api
crew add workspace quickfix my-api --direct
```

### `crew add worktree`

Make a new working copy of every project, in the background: the worktree is recorded, its ports reserved, and one runner per project starts (a window of tmux session crew-setup-<ws>--<name>) doing checkout → .env → install → env command → a smoke of its own servers, each watched until it listens on its port, dies, or a minute passes. The command returns at once. In a terminal it lands on the worktree page, which shows the runners; without one it prints how to watch: crew setup status <ref>. A failure is recorded on the worktree the moment it happens, while the other runners continue — crew fix <ref> --print has it before the slowest install ends. --wait stays until every runner is done, prints the summary and exits 1 if anything is recorded. .env comes from the canonical repo or a sibling worktree; --pull fast-forwards the local base branches first.

```
crew add worktree <workspace>/<name> [--pull] [--no-install] [--no-smoke] [--wait]
```

- `--pull` — Fast-forward each project's local base branch to origin first. Never touches a checked-out feature branch; refuses when the base has diverged or is checked out with uncommitted changes.
- `--no-install` — Check out only; skip mise and package installs (and so the smoke)
- `--no-smoke` — Skip the smoke start
- `--wait` — Stay until every runner is done: the table live in a terminal, then the summary; exit 1 if anything is recorded. --json then carries the health

```bash
crew add worktree store-front/wrk3
crew add worktree store-front/wrk3 --wait
crew add worktree store-front/wrk3 --no-install
```

### `crew add binding`

Declare an env variable a project needs, and how crew computes it at dev-server start. Value is a template: {{proj}} is http://localhost:<port> of that project's dev server, {{proj.host}} is localhost:<port> (for ws://, https://, or a path), {{proj.port}} the number; write {{proj/server}} when the project has more than one. {{worktree}} and {{workspace}} are the names. Resolved values are injected into the process env — env files are never rewritten. Name the owner as <project> for every dev server of the project, or <project>/<server> for that server alone — a monorepo's web app and its worker want different siblings; a scoped binding wins over the project-wide one for its server. With --scan, propose bindings from the project's own .env — under the server's dir when an owner server is named.

```
crew add binding <project>[/<server>] --var=<VAR> (--url=<proj[/server]> | --host=<proj[/server]> | --port=<proj[/server]> | --value=<template>) [--dry-run] | --scan [--apply]
```

- `--var=<VAR>` — Environment variable to set
- `--url=<p[/s]>` — Shorthand for --value='{{p/s}}' — http://localhost:<port> of that dev server
- `--host=<p[/s]>` — Shorthand for --value='{{p/s.host}}' — localhost:<port>, for any other scheme
- `--port=<p[/s]>` — Shorthand for --value='{{p/s.port}}' — just the port number
- `--value=<t>` — Full template, for composition (e.g. ws://{{signals.host}}/rtc)
- `--scan` — Read the project's .env (the server's dir, for <project>/<server>) and propose bindings for values pointing at ports crew allocates
- `--apply` — With --scan, add every unambiguous proposal
- `--dry-run` — Save nothing: check the binding the way the add would and print its value in every worktree of the project (ref, value or why it is left alone, running or stopped); exit 1 with the reason when it would be refused. --json: {var, server, value, error?, previews: [{ref, value, resolved, running, detail}]}

```bash
crew add binding checkout-api --var=STORE_API_URL --url=store-api
crew add binding admin/homepage --var=STORE_API_URL --url=store-api
crew add binding checkout-api --var=SIGNALS_URL --value='ws://{{signals.host}}/rtc'
crew add binding checkout-api --var=SIGNALS_AGENT_NAME --value='{{worktree}}'
crew add binding checkout-api --scan
crew add binding checkout-api --scan --apply
crew add binding checkout-api --var=STORE_API_URL --url=store-api --dry-run --json
```

### `crew add override`

Pin a variable for one worktree. Beats whatever the binding would resolve, and is the acknowledgement for a binding that legitimately never resolves here — it stops printing as an anomaly on every start. Key is VAR, or project.VAR to pin one project when two share a name.

```
crew add override <workspace>/<worktree> <VAR>=<value>
```

```bash
crew add override store-front/wrk2 STORE_API_URL=https://dev-api.store.com
crew add override store-front/wrk2 checkout-api.API_URL=https://tutor.dev
```

## `crew config`

View and edit crew settings (server IP, SSH host, proxy port, domain). Bare, it is config show; the page's Settings edits the same keys.

```
crew config [show|set|refresh]
```

### `crew config show`

Show all settings as tab-separated key/value pairs

```
crew config show
```

Output: `<key>\t<value>`

### `crew config set`

Set a config value. Valid keys: server_ip (LAN IP for dev proxy), ssh_host (for remote editor), proxy_port (reverse proxy port, default 80), proxy_https_port (the proxy's HTTPS port, default 443, -1 turns HTTPS off), domain (custom domain, default <ip>.nip.io)

```
crew config set <key> <value>
```

server_ip: ipconfig getifaddr en0 (Wi-Fi) or tailscale ip -4. Detected from the first non-loopback interface when unset.

domain: needs wildcard DNS (*.dev.example.com) resolving to server_ip; the default <server_ip>.nip.io needs nothing.

A changed server_ip, domain or proxy_port takes effect on the next crew dev start|restart --proxy — the proxy is relaunched when its settings differ.

```bash
crew config set server_ip 192.168.1.50
crew config set ssh_host my-dev-vm
crew config set proxy_port 8080
crew config set domain dev.example.com
```

### `crew config refresh`

Rewrite the tmux config crew manages (~/.crew/tmux.conf) to the current default. Only a file crew wrote is touched.

```
crew config refresh
```

```bash
crew config refresh
```

## `crew ps`

List what crew is running: tmux sessions, and processes that leaked out of them. Loose processes are only those whose parent has exited while still working inside the workspace tree — anything still attached to a live process (a running Claude session, an editor terminal) is reported as left alone.

```
crew ps [--json]
```

Output: `<kind>\t<pid>\t<session|cwd>\t<command>`

```bash
crew ps
crew ps --json
```

## `crew kill`

Stop every crew session and reclaim the processes that leaked out of them, without rebooting. Prints the commands to restore what it stopped. Processes with a live parent are never killed, and crew's server (tmux crew-server) is listed as kept, never stopped — crew server stop is its stop.

```
crew kill [--dry-run]
```

```bash
crew kill
crew kill --dry-run
```

## `crew ls`

List workspaces, worktrees, projects, bindings, overrides or a workspace's base branches (tab-separated output for scripting; --json for data)

### `crew ls workspaces`

List all workspaces with project counts and worktree names. --json adds each member with its mode and the binding wires between the members (ok: the target is in the workspace too).

```
crew ls workspaces
```

Output: `<name>\t<n> projects\t<worktree>,<worktree>`

### `crew ls worktrees`

List every working copy — one row per worktree, across all workspaces or one, and a kept check (crew check project) as check/<project> after them. This is the 'what do I have checked out' view.

```
crew ls worktrees [<workspace>] [--size]
```

Output: `<workspace>/<worktree>\t<path>\t[<size>\t][dev|installing][\t<recorded failure>]`

- `--size` — Add bytes on disk per worktree. Walks every file — slow on one with a full build inside

```bash
crew ls worktrees
crew ls worktrees store-front
crew ls worktrees check
crew ls worktrees --size
```

### `crew ls projects`

List all registered projects: the path crew keeps the checkout at, and the git remote that names it (- when the checkout has none — such a project exports as config only).

```
crew ls projects
```

Output: `<name>\t<path>\t<remote|->`

### `crew ls bindings`

List a project's bindings as declared: the var, the server it is scoped to (- when it applies to every server), the template. With --check, resolve each against a real worktree and show the value it would get there, or why it would be left alone.

```
crew ls bindings <project> [--check=<workspace>[/<worktree>]] [--preview]
```

Output: `<var>\t<server|->\t<template>[\t<resolved value>][\t→ <preview>]`

- `--check=<ref>` — Resolve against this worktree
- `--preview` — Every binding's value in every worktree of the project — running, or what the stopped ones get back on their next start; the cell is the first resolved value, else why it is left alone. --json: rows with previews: [{ref, value, resolved, running, detail}]

```bash
crew ls bindings checkout-api
crew ls bindings checkout-api --check=store-front/wrk1
crew ls bindings checkout-api --preview --json
```

### `crew ls overrides`

List a worktree's overrides

```
crew ls overrides <workspace>/<worktree>
```

Output: `<key>\t<value>`

```bash
crew ls overrides store-front/wrk2
```

### `crew ls bases`

The base branches a new worktree of the workspace branches from — the table crew add worktree opens with: each project's base, how many commits it is behind origin (fetched now; -1 when unknown), and the branch the canonical checkout is on. crew add worktree <ws>/<name> --pull fast-forwards them first.

```
crew ls bases <workspace>
```

Output: `<project>  <base>  <n behind origin/<base>|up to date>[   (checkout is on <branch>)]`

--json: [{project, base, current, behind, ahead, error?}]

```bash
crew ls bases store-front
crew ls bases store-front --json
```

## `crew show`

Show all projects in a workspace with their paths in that worktree and their mode

```
crew show <workspace>[/<worktree>]
```

Output: `<name>\t<path>\t<worktree|direct>`

```bash
crew show feature-auth
```

## `crew verify`

Check a worktree the way creating it does, one runner per project in the background: a project with no checkout is checked out and installed, one whose last install failed is installed again, and every project's servers are smoked — started, watched until each listens, dies, or a minute passes, stopped. Each runner writes or clears its own project's verdict. Name projects to verify only those — the one you just fixed — while the rest keep their record. Returns at once with crew setup status <ref> as the way to watch; --wait stays to the end and exits 1 if anything is recorded. Refuses while the worktree's servers are running (it would restart them) or while a setup is already running on it.

```
crew verify <workspace>[/<worktree>] [<project>...] [--wait]
```

- `<project>...` — Only these projects; the others keep whatever is recorded
- `--wait` — Stay until every runner is done; then the issues, exit 1 on any

```bash
crew verify store-front/wrk2
crew verify store-front/wrk2 --wait
crew verify store-front/wrk2 store-api
```

## `crew fix`

Open Claude Code in the worktree with what failed in front of it: each issue with its stage (checkout, install, smoke), the error or log tail, the env anomalies, and the instruction to fix the cause and run crew verify. With nothing recorded it checks the running servers (crew dev check) or, with none running, runs verify first, so it is one command either way. Replaces the crew process. --print writes that same prompt to stdout instead — for an agent that is already here; without a terminal that is what happens anyway. --json is the recorded health as data.

```
crew fix <workspace>[/<worktree>] [--print]
```

- `--print` — Print the fix prompt (issues, evidence, anomalies) instead of opening Claude; no terminal needed

```bash
crew fix store-front/wrk2
crew fix store-front/wrk2 --print
crew fix store-front/wrk2 --json
```

## `crew claude`

Run Claude Code in the worktree, in this terminal — the worktree page's 'Claude in terminal'. Permissions skipped, every project passed with --add-dir, the orientation prompt injected (the projects, their paths, and a crew section on driving the servers). Replaces the crew process.

```
crew claude <workspace>[/<worktree>]
```

```bash
crew claude store-front/wrk1
```

## `crew edit`

Open the worktree in the local editor (Cursor, else VS Code) with the orientation prompt written and Claude wired up — the worktree page's 'Editor + Claude'. For a remote-SSH URL instead, see crew code.

```
crew edit <workspace>[/<worktree>] [--editor=cursor|code]
```

- `--editor=<cursor|code>` — Which editor; detected when omitted

```bash
crew edit store-front/wrk1
crew edit store-front/wrk1 --editor=code
```

## `crew open`

Start a shell in the worktree directory — the worktree page's 'Shell here'. Replaces the crew process; exit returns to where you were.

```
crew open <workspace>[/<worktree>]
```

```bash
crew open store-front/wrk1
```

## `crew code`

Print the remote-SSH URL that opens the worktree in Cursor/VS Code on another machine. Requires ssh_host (crew config set ssh_host <host>). For multi-project worktrees, generates a .code-workspace file. To open the local editor, see crew edit.

```
crew code <workspace>[/<worktree>]
```

```bash
crew code feature-auth
```

## `crew start`

Generate and print the orientation prompt for a workspace — the project list, working directories, and worktree/direct framing. Ends with a crew section: the ref, and the commands that session should drive the servers with. Every launch (crew claude, crew edit, the page) injects it; paste it into a Claude opened some other way.

```
crew start <workspace>[/<worktree>]
```

```bash
crew start feature-auth
```

## `crew launch`

*Interactive (TUI).*

The terminal's one interactive view: pick a worktree (bare), then launch on it — Editor + Claude or Claude in this terminal (both skip permissions), remote editor, shell. Its servers show read-only, with l for their logs; starting, stopping, verifying and fixing are crew's page (run crew) or the commands. crew <ref> opens the same page.

```
crew launch [<workspace>[/<worktree>]]
```

Without a terminal: crew claude <ref> and crew edit <ref> are the launch rows as commands; crew ls worktrees lists what there is to pick.

The page's last line names where to manage the worktree: crew's page (its link without the sign-in token) and crew dev start <ref>.

```bash
crew launch
crew launch feature-auth
crew launch store-front/wrk2
```

## `crew dev`

Manage dev servers and reverse proxy. Each project can have named dev servers that run in tmux windows behind a shared reverse proxy.

### `crew dev setup`

Detect a dev server for a project from package.json (a dev script, else start) and print it; --apply records it as a server named after the project. Detection cannot know the port, so --apply needs --port. crew dev add is the full form.

```
crew dev setup <project> [--apply --port=<port>]
```

Output: `<detected|added>\t<name>\t<command>`

- `--apply` — Record the detected server; needs --port
- `--port=<port>` — The reference port for the detected server

```bash
crew dev setup web
crew dev setup web --apply --port=3000
```

### `crew dev add`

Add a dev server to a project. The --port is for reference only — at runtime, crew assigns a random free port via the PORT env var. Without --port the process does not listen (a worker, a queue consumer): crew runs it with no PORT, hands out no URL, and a smoke only checks it stays alive.

```
crew dev add <project> --name=<name> [--port=<port>] --cmd=<command> [--dir=<subdir>] | crew dev add <project> --name=<new> --rename=<old> [--port=<port>] [--cmd=<command>] [--dir=<subdir>]
```

- `--name=<n>` — Server name (used as subdomain) (required)
- `--port=<p>` — The port the server conventionally uses — reference only. Crew always allocates a free port and passes it as $PORT. Leave it out (or --port=0, which with --rename clears the old port) for a process that does not listen
- `--cmd=<c>` — Start command (use $PORT for the dynamic port) (required)
- `--dir=<d>` — Subdirectory relative to project root (for monorepos)
- `--rename=<old>` — Rename that server to --name in place: the bindings scoped to it follow it (an rm and an add would drop them), and every binding in the pool whose value names it ({{<project>/<old>}}, .host, .port) is rewritten to the new name and listed; the old server's port, command and dir stand unless given

The command runs with PORT=<allocated> in its environment; it must bind that port (next dev -p $PORT, --port $PORT, process.env.PORT). --port is the reference for .env scans and conflict checks, not what runs.

Sibling URLs come from env vars the project reads at start — the ones crew add binding fills.

```bash
crew dev add my-api --name=api --port=3000 --cmd="npm run dev"
crew dev add my-app --name=web --port=5173 --cmd="npm run dev" --dir=packages/web
crew dev add my-api --name=worker --cmd="npm run worker"
crew dev add my-api --name=api --rename=server
```

### `crew dev rm`

Remove a dev server configuration from a project. Bindings scoped to that server go with it, and are named.

```
crew dev rm <project> <server-name>
```

```bash
crew dev rm my-api api
```

### `crew dev show`

Show configured dev servers for a project (not necessarily running)

```
crew dev show <project>
```

Output: `<server-name>\t<port>\t<command>[\t<dir>]`

```bash
crew dev show my-api
```

### `crew dev start`

Start all dev servers for a worktree in tmux windows. Ports are always allocated fresh — the configured --port is reference only — and a worktree keeps its ports across restarts, so any number of worktrees can run at once. URLs are http://localhost:<port>. With --proxy the shared reverse proxy starts too and URLs become http://<server>--<workspace>--<worktree>.<domain>, reachable from other devices on the LAN. Bindings are resolved after ports are allocated and injected into each server's env; anything left alone or pointing at a port crew gave to another project is printed.

```
crew dev start <workspace>[/<worktree>] [--proxy]
```

- `--proxy` — Also run the shared reverse proxy and address servers by hostname

--proxy: one reverse proxy on <server_ip>:<proxy_port> (crew config show) serves every running server at http://<server>--<workspace>--<worktree>.<domain>; http://<server_ip>:<proxy_port>/ lists them.

A URL works here but not on another device: open http://<server_ip>:<proxy_port>/ there first.

Loads: the hostname is the problem — <ip>.nip.io resolves to a private IP, which router DNS rebind protection (Fritz!Box, UniFi, dnsmasq, Pi-hole), NextDNS or iOS Private Relay refuse. Allow nip.io there, turn off Limit IP Address Tracking for that Wi-Fi, or use a domain of your own (crew config set domain).

Does not load: the device cannot reach this machine — different network, guest/AP isolation, VPN, cellular.

Tailscale sidesteps both: crew config set server_ip <tailscale ip>, then crew dev restart <ref> --proxy. URLs become <server>--<ws>--<wt>.100.x.y.z.nip.io and work off the LAN too.

```bash
crew dev start feature-auth
crew dev start store-front/wrk2
crew dev start store-front/wrk2 --proxy
crew dev start store-front/wrk2 --json
```

### `crew dev stop`

Stop dev servers. Without an argument, stops every running dev server (crew's server is not one — crew server stop). A bare workspace name stops all of its worktrees.

```
crew dev stop [<workspace>[/<worktree>]]
```

```bash
crew dev stop
crew dev stop feature-auth
```

### `crew dev restart`

Stop and restart dev servers for a worktree

```
crew dev restart <workspace>[/<worktree>] [--proxy]
```

- `--proxy` — Also run the shared reverse proxy and address servers by hostname

```bash
crew dev restart feature-auth
crew dev restart store-front/wrk2 --proxy
```

### `crew dev status`

Show running dev servers and their URLs. Without an argument, shows all. A bare workspace name shows all of its worktrees. A proxied worktree whose proxy is down gets a ! line on stderr.

```
crew dev status [<workspace>[/<worktree>]]
```

Output: `<workspace>/<worktree>\t<server>\t<port>\t<url>`

```bash
crew dev status
crew dev status feature-auth
```

### `crew dev check`

Look at a worktree's running servers the way the smoke does: a pane that exited is died; one that runs without anything accepting on its port is not listening — a failure when some binding points at it, a note when nothing does. Bare, it is one look; --wait watches each server until it listens, dies, or a minute passes — the thing to run right after a start. Exit 1 on any failure; crew fix <ref> --print then carries the evidence. To prove a project's config from a fresh checkout instead, crew check project.

```
crew dev check <workspace>[/<worktree>] [--wait]
```

Output: `<project>/<server>\t<running|died|not listening>\t<port>\t<took>\t<detail>`

- `--wait` — Keep looking until every server has a verdict (up to a minute) instead of one look now

```bash
crew dev check store-front/wrk2 --wait
crew dev check store-front/wrk2 --json
```

### `crew dev proxy`

The shared reverse proxy: whether its session is up and answering, what domain and port it was launched with, its status page URL, and whether HTTPS answers. The proxy also serves every hostname over HTTPS (default port 443) with a certificate from crew's own CA, one CA per domain, which can only vouch for that domain. trust prints the CA, its SHA-256 and the steps to trust it on a Mac, iPhone or Android — needed once per device, for example for the microphone in Voice OS; --install trusts it on this Mac. stop kills the proxy alone — worktrees keep running on their ports; crew dev restart <ref> --proxy brings the hostnames back.

```
crew dev proxy [status|trust [--install]|stop]
```

Output: `<up|up (not listening)|down>\t<domain>\t<port>\t<status url>\thttps <up|not listening|off>\t<https port>`

- `--install` — trust: add the CA to this Mac's login keychain (asks for the password)

```bash
crew dev proxy status
crew dev proxy trust
crew dev proxy trust --install
crew dev proxy stop
```

### `crew dev logs`

Print the log for a dev server. Logs are truncated each time the server starts, so they only cover the current run. Use -f to follow live output, --lines for just the end. --json: {ref, server, lines: []} — the lines as clean text (terminal escape sequences, carriage-return redraws and pure-control lines removed); not with -f.

```
crew dev logs <workspace>[/<worktree>] <server> [-f|--follow] [--lines=<n>]
```

- `-f, --follow` — Stream new output as it arrives (tail -f)
- `--lines=<n>` — Only the last n lines

```bash
crew dev logs feature-auth api
crew dev logs feature-auth web -f
crew dev logs feature-auth api --lines=50
```

### `crew dev tui`

*Interactive (TUI).*

The launch page for a worktree — the same as crew launch <ref>: launch rows, its servers read-only, l for their logs

```
crew dev tui <workspace>[/<worktree>]
```

Starting and stopping are crew dev start / stop / restart, or crew's page (run crew).

```bash
crew dev tui store-front/wrk1
```

## `crew rm`

Remove workspaces, projects, or workspace projects. Without subcommand, removes an entire workspace (stops dev servers, removes worktrees, directory, and JSON).

```
crew rm <workspace>
```

```bash
crew rm feature-auth
```

### `crew rm project`

Remove a project from the global pool, and with it the clone crew made under ~/.crew/projects (to the trash — never a path of yours, which is left alone and said so). Refused while any workspace lists the project or a check of it is kept — the workspace names it, and every worktree is a git worktree off that clone: crew rm workspace <ws> <name> first.

```
crew rm project <name> [--keep-clone]
```

- `--keep-clone` — Remove the pool entry but leave crew's clone where it is

```bash
crew rm project my-api
crew rm project signals --keep-clone
```

### `crew rm workspace`

Remove a project from a workspace (removes its checkout from every worktree). --dry-run removes nothing and lists each checkout it would take with what is in it: uncommitted files, commits not on the base, size.

```
crew rm workspace <workspace> <project> [--dry-run]
```

Output: `--dry-run: <ref>\t<project>\t<path>\t<n> uncommitted\t<n> commits not on the base\t<size>`

- `--dry-run` — Remove nothing; print the cost. --json: {checkouts: [{ref, project, path, direct, missing, uncommitted, commits, size_bytes}], last}

```bash
crew rm workspace feature-auth my-api
crew rm workspace feature-auth my-api --dry-run --json
```

### `crew rm worktree`

Remove one worktree — its checkouts (to the trash), their crew/<ws>/<wt>/<project> branches, dev session, logs and prompt. Commits not on the base stay in the repo's reflog. Refuses to remove the last worktree; remove the workspace instead. check/<project> removes a kept check.

```
crew rm worktree <workspace>/<name> [--dry-run]
```

- `--dry-run` — Remove nothing; list every checkout it would take with its uncommitted files, commits not on the base and size; last says it is the workspace's last worktree (which goes only with crew rm <workspace>). --json as rm workspace --dry-run

```bash
crew rm worktree store-front/wrk3
crew rm worktree check/signals
crew rm worktree store-front/wrk3 --dry-run
```

### `crew rm binding`

Remove a binding from a project — the project-wide one, or with <project>/<server> the one scoped to that server. A var bound only per server is refused by the bare form, naming the servers.

```
crew rm binding <project>[/<server>] <var>
```

```bash
crew rm binding checkout-api STORE_API_URL
crew rm binding admin/homepage STORE_API_URL
```

### `crew rm override`

Remove a worktree override; the binding applies again

```
crew rm override <workspace>/<worktree> <VAR>
```

```bash
crew rm override store-front/wrk2 STORE_API_URL
```

## `crew rename`

Rename things. One noun so far: a worktree.

```
crew rename worktree <workspace>/<worktree> <new-name>
```

### `crew rename worktree`

Rename a worktree: its directory, every checkout's crew/<ws>/<wt>/<project> branch (in place when checked out, in the repo otherwise — a checkout on its own branch is kept and said so), its setup table, runner logs and dev logs move to the new name; overrides, reserved ports and any recorded failure travel with the record; the prompt is regenerated and the .code-workspace on the next launch. Synchronous, and re-runnable under the same new name if it was interrupted. Refused while its dev servers or a setup runner are alive (crew owns those paths), on a pre-2.0 workspace, on a check target, and when the new name or a branch it would take already exists. Shells, editors and agents opened on the old paths keep them — reopen with crew claude / edit. A branch that was pushed keeps its old upstream name; proxy hostnames change with the slug.

```
crew rename worktree <workspace>/<worktree> <new-name>
```

Output: `Renamed <workspace>/<worktree> → <workspace>/<new-name>`

--json: {from, to, warnings: []}

```bash
crew rename worktree store-front/wrk2 payments
crew rename worktree store-front/wrk2 payments --json
```

## `crew duplicate`

Duplicate a worktree within its workspace — fresh checkouts of the same projects, with the source worktree's overrides copied across before its runners start. Made the way crew add worktree makes one: in the background, one runner per project; --wait stays to the end.

```
crew duplicate <workspace>[/<worktree>] <new-worktree> [--no-install] [--no-smoke] [--wait]
```

```bash
crew duplicate store-front/wrk1 wrk3
```

## `crew env`

Print a project's resolved env for a worktree, against the dev servers currently running there. stdout is pure KEY=VALUE so it can be eval'd; the full table and any variables left alone go to stderr. <project> is the project-wide set; <project>/<server> is what that one dev server gets (its scoped bindings included) — the table under a bare <project> says which vars are bound per server. Values are point-in-time — prefer `crew run` over pasting them anywhere.

```
crew env <workspace>[/<worktree>] <project>[/<server>]
```

Output: `<VAR>=<value>`

```bash
crew env store-front/wrk1 checkout-api
crew env store-front/wrk1 admin/homepage
eval "$(crew env store-front/wrk1 checkout-api)"
```

## `crew run`

Run a command inside a project's checkout with its bindings resolved into the environment — the project-wide set, or one dev server's with <project>/<server>. This is how evals, scripts and CLIs that crew does not start get the same URLs the dev servers got. Everything after -- is the command, untouched.

```
crew run <workspace>[/<worktree>] <project>[/<server>] -- <command...>
```

```bash
crew run store-front/wrk1 checkout-api -- make eval
crew run store-front/wrk2 checkout-api -- uv run python -m tests.smoke
```

## `crew migrate`

Move pre-worktree workspaces to the nested layout. <name>-wrkN becomes workspace <name>, worktree wrkN; anything else becomes <name>/main. Prints the full plan, backs up workspace and route files, asks, then moves checkouts with git worktree move and renames branches. Old paths are printed afterwards so anything holding them can be updated.

```
crew migrate [--dry-run] [--yes]
```

- `--dry-run` — Print the plan and stop; with --json the moves as [{workspace, ref}] on stdout and the plan on stderr
- `--yes` — Apply without the confirmation prompt; with --json {migrated: <n>} on stdout and the plan and narration on stderr

```bash
crew migrate --dry-run
crew migrate
```

## `crew export`

Write projects and workspace membership to a file for another machine — everything unless --projects narrows it; - as the file writes the bundle to stdout (narration to stderr), which is how crew's page downloads it. Projects carry their dev servers, bindings, setup and env commands and origin remote; workspaces carry which projects, in which mode. Worktrees, ports and overrides stay local. A project is written by its git remote — no path — so the other machine clones it; one whose checkout has no remote still exports (config only) and is named as such.

```
crew export [<file>|-] [--all | --projects=<a,b> [--workspaces=<x,y>]]
```

- `<file>|-` — Where the bundle goes (default crew-export.json); - is stdout
- `--all` — Every project and workspace (the default when nothing is named)
- `--projects=<a,b>` — Only these projects
- `--workspaces=<x,y>` — Only these workspaces; every project they use must be in --projects

```bash
crew export
crew export ~/Desktop/crew.json --all
crew export --projects=store-api,checkout-api --workspaces=store-front
crew export - > crew.json
```

## `crew import`

Bring a crew export into this machine. A project is its git remote: one already here under the same remote is left alone (r replaces its config), one not here is cloned into ~/.crew/projects/<name>. Bare (or --plan), every item's status; project <name> imports one with the choice as flags (--path adopts a checkout you already have, --replace swaps one already here, --name renames — the bindings it leaves pointing at the old name are named); workspace <name> creates one; --all takes everything at once. crew's page walks the same plan item by item. - as the file reads the bundle from stdin. A repo you already have checked out under your code folders shows as found, with its path: --path it, or it is cloned a second time.

```
crew import <file>|- [--plan | --all [--replace] [--pull] [--no-install] [--no-smoke] [--wait] | project <name> [--path=<dir>] [--replace] [--name=<new>] [--setup=<cmd>] [--env-cmd=<cmd>] | workspace <name> [--pull] [--no-install] [--no-smoke] [--wait]]
```

Output: `<project|workspace>\t<name>\t<status|outcome>\t<detail>`

- `<file>|-` — The bundle; - reads it from stdin
- `--plan` — The default — inspect only: one row per item with what would happen here — exists, other remote, clone (and where), found (a checkout of that remote already on this machine — --path=<it> uses it; a bare import and --all still clone), blocked (the clone dir is taken), missing (no remote); needs (a workspace's absent members)
- `--all` — Clone every project not here, keep the ones that are (--replace swaps them); refuses up front — before a single clone — on any blocked or missing row, and under --replace on another remote for a project whose worktrees hang off the local checkout. A project that fails on the way is its row and exit 1. Workspaces are made the way crew add worktree makes one
- `--pull` — workspace: fast-forward the local base branches from origin before checking out (the base table is printed either way)
- `--no-install` — workspace: skip the installs
- `--no-smoke` — workspace: skip the smoke start
- `--wait` — workspace: stay until its runners are done; the row then carries what was recorded
- `--path=<dir>` — project: adopt this checkout as the canonical instead of cloning — the only way for a project with no remote
- `--replace` — project: swap out the local record of the same name — same remote, or no remote in the bundle (a config-only export): its config, checkout kept; another remote: a fresh clone (refused while a workspace still has the project)
- `--name=<new>` — project: import under another name (bindings pointing at the old name are left alone)
- `--setup=<cmd>` — project: override the setup command
- `--env-cmd=<cmd>` — project: override the env command

```bash
crew import ~/Desktop/crew.json
crew import crew.json --plan
crew import crew.json project checkout-api
crew import crew.json project store-api --path=~/code/store-api --replace
crew import crew.json workspace store-front
crew import crew.json --all --pull
crew import - --plan --json < crew.json
```

## `crew check`

Prove a project reproduces from nothing, before it joins a workspace.

```
crew check project <name> [--status]
```

### `crew check project`

A fresh checkout of the project's canonical repo run through the setup runner — mise, install, env command, a smoke of its own servers — as the target check/<project>: one runner in the background, crew setup status check/<project> to watch. A pass removes the checkout, its branch and the record, and keeps the result files so that status still shows the ✓ table. A failure keeps the target: crew ls worktrees lists check/<project> with what failed, crew fix check/<project> --print carries the evidence and the checkout, crew verify check/<project> re-runs it in place (a pass removes it), crew check project <name> again replaces it from nothing, crew rm worktree check/<project> removes it. Refuses while a check of the project is running. Returns once the runner starts, printing its table and the way to watch; --wait stays until the verdict, exit 1 on a failure. --status is the check at rest: none, running, passed (and whether it smoked) or failed with its record. What crew dev check does for running servers, this does for a project's config.

```
crew check project <name> [--pull] [--no-smoke] [--wait] | crew check project <name> --status
```

Output: `--status: <project>\t<none|running|passed|failed>[\t<verdict>][\t<when>][\t<recorded failure>]`

- `--status` — Start nothing; where the project's check stands. --json: {project, state, verdict, at, smoked, health, projects: [runner rows]}
- `--pull` — Fast-forward the canonical repo's base branch first, as crew add worktree --pull does
- `--no-smoke` — Skip the smoke start
- `--wait` — Stay until the runner is done; then the issues, exit 1 on any

```bash
crew check project signals --wait
crew check project signals --no-smoke
crew check project signals --status --json
crew setup status check/signals
```

## `crew clean`

Clear what crew leaves behind and nobody comes back for — the sweep every crew command runs at most once an hour, now, plus a git worktree prune on every pool repo: failed checks older than seven days; runner files, dev logs and route files of worktrees and checks that no longer exist (a slug whose dev or setup session is still alive is left alone, and so is the route of crew's running server); lock files with no record behind them, older than an hour; the trash. Every path is under ~/.crew or it is refused. --dry-run lists without removing.

```
crew clean [--dry-run]
```

Output: `<kind>\t<path>\t<removed|would remove|pruned|would prune|failed: <reason>>  |  nothing to clean`

- `--dry-run` — List what the sweep would remove and remove nothing

```bash
crew clean --dry-run
crew clean
crew clean --json
```

## `crew doctor`

What crew needs on this machine and whether it is there: tmux (dev servers, setup runners and checks run in it) and git are required, Claude Code is optional (Voice OS and crew claude run it). Exits 1 when a required tool is missing. --install shows the install commands (Homebrew or xcode-select on macOS, apt-get, dnf or pacman on Linux) and runs them after asking; Claude Code is asked for separately. Without a terminal, --install needs --yes and installs Claude Code only with --with-claude. The first crew command that needs tmux or git offers this once.

```
crew doctor [--install [--yes] [--with-claude]]
```

Output: `<name>\t<ok|missing>\t<required|optional>\t<why>\t<install>`

- `--install` — Install what is missing, asking first at a terminal
- `--yes` — With --install: no questions (the required tools only)
- `--with-claude` — With --install --yes: install Claude Code too

```bash
crew doctor
crew doctor --json
crew doctor --install
crew doctor --install --yes
```

## `crew trash`

Removed checkouts are moved to ~/.crew/trash and deleted in the background, so removal returns at once. This shows what is still clearing; 'crew trash empty' deletes it now, for when the background delete never finished.

```
crew trash [empty]
```

Output: `<path>\t<size>\t<n> entries\t<note>  |  <path>\tempty`

```bash
crew trash
crew trash empty
```

## `crew debug`

Follow the debug log (~/.crew/debug.log): every tmux, git, editor, package-manager, mise and trash command crew ran, with errors. Binding values are never logged. --tail prints the last lines and returns; --json parses them.

```
crew debug [--tail=<n>]
```

Output: `<date> <time> [<category>] <message>`

- `--tail=<n>` — Print the last n lines instead of following (--json alone implies 200)

```bash
crew debug
crew debug --tail=50
crew debug --tail=200 --json
```

## `crew setup`

Re-run every project's install steps in a worktree (or the named projects'), one runner per project in the background: mise install, then the lockfile's package manager (uv sync, pnpm install, yarn, bun install, npm ci) or the project's explicit setup command, then the project's env command when it has one, then a smoke of that project's servers. Idempotent — the fix for an install that failed when the worktree was created. Returns at once; crew setup status <ref> is how to watch, --wait stays to the end. Refuses while the worktree's servers are running (the smoke would restart them; --no-smoke) or while a setup is already running on it.

```
crew setup <workspace>[/<worktree>] [<project>...] [--no-smoke] [--wait]
```

- `<project>...` — Only these projects
- `--no-smoke` — Skip the smoke start
- `--wait` — Stay until every runner is done; then the issues, exit 1 on any

```bash
crew setup store-front/wrk3
crew setup store-front/wrk3 store-api --wait
```

### `crew setup status`

What each project's runner has done on a worktree — creation, a verify or a setup, still going or finished: one row per project with its state (starting, running, ok, failed, interrupted), its steps in order with how long each took, the running one marked, a failed one with its reason. A runner that vanished without a verdict (a killed window, a reboot) reads as interrupted and is recorded on the worktree as a failure. Exit 2 while any runner is alive, 1 once all stopped with anything recorded, 0 otherwise — an agent polls this and acts on the first failure while the rest still install. --wait stays until no runner is left (then 1 or 0).

```
crew setup status <workspace>[/<worktree>] [--wait]
```

Output: `✓|✗|▸ <project>  <step> <took> · <step> <took> · ▸ <running step> | <step> — <reason>`

- `--wait` — Stay until every runner is done, the table live in a terminal

```bash
crew setup status store-front/wrk3
crew setup status store-front/wrk3 --wait
crew setup status store-front/wrk3 --json
```

### `crew setup logs`

The last lines of one project's runner log: its steps as they finished and everything its install printed — live while it runs, kept afterwards. What to read when a step is taking long. --json: {ref, project, lines: []}, cleaned as dev logs --json cleans them.

```
crew setup logs <workspace>[/<worktree>] <project> [--lines=<n>]
```

- `--lines=<n>` — How many lines from the end (default 50)

```bash
crew setup logs store-front/wrk3 store-api
crew setup logs store-front/wrk3 store-api --lines=200
```

## `crew uninstall`

Stop every dev server and crew's server, and remove the crew binary. ~/.crew — workspace config and every worktree checkout — is kept unless --purge is given, which removes the checkouts through git and deletes the directory.

```
crew uninstall [--purge] [--yes]
```

- `--purge` — Also remove every workspace's checkouts and ~/.crew. Uncommitted work in checkouts is lost.
- `--yes` — Skip the confirmation prompt

```bash
crew uninstall
crew uninstall --purge
```

## `crew server`

crew's server: one process serving crew's page — Home, Set up (every project, workspace, worktree, machine and setting, with a Setup with Claude chat per machine) and Voice OS, the voice and web cockpit for the Claude Code sessions of every worktree. Bare crew starts it and opens the page; bare crew server is its status. It runs in tmux session crew-server on a remembered port with a route on the dev proxy; crew dev stop and crew kill leave it alone, and a server started before the rename (crew-dev-os) is still recognised and stopped. The first start downloads Voice OS from the release matching this crew (crew update refreshes it once installed, never restarting a running one). Voice needs an Anthropic key (kernel and narrator) and a Soniox key (speech): the page asks for them, crew server keys set takes one on stdin, and crew server start at a terminal asks for any that is missing; a running server picks a new key up from your next words. Keys live in ~/.config/crew-voiceos, readable by you alone, never in the shell environment.

```
crew server [start|stop|restart|status|logs|debug-notes|notes|keys|remote|machines|discord|dev] [--no-open]
```

Output: `<up|up (not answering)|down>\t<port>\t<localhost url>\t<proxy url>`

crew voice … is the same command under its old name, kept for good (Voice OS and older machines call it); bare crew voice still starts the server. At a terminal it notes the new name on stderr.

Every start first checks what it needs — tmux, and for crew server start Claude Code on PATH too — and names what is missing with its fix. Bare crew needs tmux only and never asks for keys.

```bash
crew
crew server
crew server status --json
crew server keys
pbpaste | crew server keys set anthropic
crew server stop
```

### `crew server start`

Start the server when it is not answering — checking tmux and Claude Code first, downloading Voice OS on the first run, asking at a terminal for a missing key — and print its sign-in links: the localhost one has microphone access, and so does the HTTPS proxy one on any device that trusts crew's CA (crew dev proxy trust). Opens the localhost link in the browser at a terminal on this machine's screen.

```
crew server start [--no-open]
```

Output: `<up|up (not answering)|down>\t<port>\t<localhost url>\t<proxy url>`

- `--no-open` — Print the links only (never opened under --json, without a terminal, over SSH, or on Linux with no display)

```bash
crew server start
crew server start --no-open --json
```

### `crew server stop`

Stop the server and every Claude session it runs; their conversations resume on the next start.

```
crew server stop
```

```bash
crew server stop
```

### `crew server restart`

Stop and start the server in a helper of its own (detached), so a restart asked from a Claude session the server runs still finishes; then the links, as start prints them.

```
crew server restart [--no-open]
```

- `--no-open` — Print the links only

```bash
crew server restart
```

### `crew server status`

Whether the server runs and answers, its port and its sign-in links. What bare crew server prints.

```
crew server status
```

Output: `<up|up (not answering)|down>\t<port>\t<localhost url>\t<proxy url>`

--json: {running, healthy, port, pid, localhost_url, url, secure, binary, warning?}

```bash
crew server status
crew server status --json
```

### `crew server keys`

Voice OS's API keys: bare (or status) lists each with whether it is set and where — never its value; set reads one from stdin (hidden at a terminal), checks it with the service, and saves it owner-only — a rejected key is not saved. A running server picks it up from your next words.

```
crew server keys [status] | crew server keys set <anthropic|soniox>
```

Output: `<name>\t<missing|set (<file|env>)>\t<path>`

```bash
crew server keys
crew server keys --json
pbpaste | crew server keys set soniox
```

#### `crew server keys status`

Each key: set or missing, and its file.

```
crew server keys status
```

#### `crew server keys set`

Read a key from stdin, check it, save it. --json: {saved, path}.

```
crew server keys set <anthropic|soniox>
```

```bash
pbpaste | crew server keys set anthropic
```

### `crew server logs`

Voice OS's log, filtered, from every machine at once. On the main (Voice OS runs here, or machines.json lists machines) it reads the main's own log and asks every remote over SSH in parallel (BatchMode, 20 s each), merging the lines by time; a machine that does not answer is named on stderr and in unreachable, and the rest still print (exit 1 only when no machine answered). On a remote it asks the main through the remote daemon's link and prints what the main would; when the main is not connected it shows this machine's own log with a warning. Reads the rotated files too (voiceos.log, .1 … .5) and never the debug notes beside them. Unknown flags are an error.

```
crew server logs [--since=] [--until=] [--cat=<c,…>] [--level=<debug|info|warn|error>] [--grep=] [--lines=<n>] [--machine=<id|name|main,…>] [--exclude=<…>] [--json]
```

Output: `<ts>\t<machine>\t<level>\t<cat>\t<msg>\t<other fields as JSON>`

- `--since=<when>` — From this time: a span back (10m, 2h, 3d), a clock time today (10:02; one still ahead is yesterday's) or an ISO time (local without a zone). Converted to UTC where you typed it, so every machine reads the same moment
- `--until=<when>` — Up to this time, same forms; before --since is an error
- `--cat=<c,…>` — Only these categories, e.g. gateway, kernel, router, worker, speech, remote; an unknown one matches nothing
- `--level=<level>` — This level and above: warn is warn and error
- `--grep=<text>` — Lines whose message or a field's value holds this text, any case (never the keys)
- `--lines=<n>` — The newest n across every machine, printed oldest first (at most 1000) (default 80)
- `--machine=<id|name|main,…>` — Only these machines; main is the main's own log — --machine=main is the fast look, no SSH
- `--exclude=<id|name|main,…>` — Every machine but these

--json: {"lines":[{ts,machine,level,cat,msg,fields}],"unreachable":[{machine,name,reason}]}. Warnings go to stderr ("! asking 2 machines…", "! vm2 (build box) unreachable: …", "! vm1 runs an older crew; run crew update there").

```bash
crew server logs --since=10m --level=warn
crew server logs --since=10:02 --until=10:05 --cat=router,kernel
crew server logs --machine=main --grep=signals --lines=200
crew server logs --machine=vm1 --json
```

### `crew server debug-notes`

The debug notes said to Voice OS ("debug note: …"), newest last. n is the note's position in debug-notes.jsonl, so a filtered list keeps the numbers show takes. They live on the main; a remote asks the main through its link and fails with the reason when the main is not connected.

```
crew server debug-notes [--since=] [--until=] [--grep=] [--lines=<n>] [--json]
```

Output: `<n>\t<at>\t<view>\t<text>`

- `--since=<when>` — As on logs
- `--until=<when>` — As on logs
- `--grep=<text>` — Notes whose text, what was said or view holds this, any case
- `--lines=<n>` — The newest n (at most 1000) (default 20)

--json: {"notes":[{n,at,view,text}]}.

```bash
crew server debug-notes
crew server debug-notes --since=2h --grep=speech
```

#### `crew server debug-notes show`

One debug note whole — what was said, the kernel's words, what was heard on that screen, the sessions, what was waiting, what was said last — then the main's log lines within its time ± --around. Says so when that stretch of the log has rotated out.

```
crew server debug-notes show <n> [--around=30s] [--json]
```

Output: `debug note <n>\t<at>\t<view>, the note's parts, then log <from> … <to>: and the log rows`

- `--around=<span>` — How much log on each side of the note (default 30s)

--json: {"note":{n,at,text,said,view,heardHere,sessions,asks,spoken,devOffer},"lines":[…as logs]}.

```bash
crew server debug-notes show 3
crew server debug-notes show 3 --around=2m --json
```

### `crew server notes`

Your own notes said to Voice OS ("note for store front: …"), one list per workspace. Bare, the general notes; a workspace is named as Voice OS names it (any case, spaces become dashes); --all lists every workspace's. They live on the main; a remote asks the main through its link and fails with the reason when the main is not connected.

```
crew server notes [<workspace>|--all] [--since=] [--grep=] [--lines=<n>] [--json]
```

Output: `<workspace>\t<date time>\t<text>`

- `--all` — Every workspace with notes, one after another
- `--since=<when>` — As on logs
- `--grep=<text>` — Notes holding this text, any case
- `--lines=<n>` — The newest n, per workspace with --all (at most 1000) (default 20)

--json: {"notes":[{workspace,at,text}]}. A note's time is the main's local clock.

```bash
crew server notes store-front
crew server notes
crew server notes --all --since=3d
```

### `crew server remote`

Make this machine a remote: another machine's Voice OS (the main) drives the Claude sessions of its worktrees over SSH, and it runs no voice or kernel of its own. Bare, it checks tmux and Claude Code, installs Voice OS if needed, and starts the daemon (a tmux session that outlives any SSH link, listening on a socket only you can open); status reports it, stop ends it and every session it runs. A machine is a main or a remote, never both: each refuses while the other runs. After crew update the daemon moves to the new release on the next connect, at once (sessions at work are cut off and resume on the new release); a main on a newer release runs crew update here itself when this machine is behind. The main reaches it with ssh <host> … crew voice _attach (the alias, which every remote knows) — a hidden command that prints nothing on stdout but the link.

```
crew server remote [status|stop]
```

Output: `<up|down>\t<version>\t<busy|idle>\t<socket>`

```bash
crew server remote
crew server remote status --json
crew server remote stop
```

### `crew server machines`

The other machines this Voice OS drives (~/.crew/voiceos/machines.json; Set up's Add machine and "rename vm1 to build box" write the same list). add takes an SSH host — an alias from ~/.ssh/config or user@host, reached with your keys and never a password prompt — and prints the machine's id (from the host); --name is what you call it aloud. A running Voice OS picks a change up within a second. ls shows each machine's status as the running Voice OS last saw it (connecting, syncing, connected, unreachable, error), or stopped when Voice OS is not running. rm stops driving that machine; its sessions keep running there.

```
crew server machines [ls] | add <ssh host> [--name=<name>] | rm <id> | rename <id> <name>
```

Output: `<id>\t<name>\t<host>\t<status>`

- `--name=<name>` — add only: what the machine is called (default: its id)

```bash
crew server machines add dev@vm1.example.com --name="Build box"
crew server machines
crew server machines rename vm1 GPU box
crew server machines rm vm1
```

#### `crew server machines ls`

Each machine with what the running server last saw of it. --json: [{id, host, name, status, detail?}].

```
crew server machines ls
```

#### `crew server machines add`

Add a machine by SSH host; prints its id.

```
crew server machines add <ssh host> [--name=<name>]
```

- `--name=<name>` — What the machine is called (default: its id)

#### `crew server machines rm`

Stop driving a machine; its sessions keep running there.

```
crew server machines rm <id>
```

#### `crew server machines rename`

Call a machine something else.

```
crew server machines rename <id> <name>
```

### `crew server discord`

Voice OS in a Discord voice channel: while Voice OS runs, a bot of your own joins one channel of one server and takes only your voice there (the server owner's, or --user's). Sessions on any machine can post there with send. Optional — crew server start never asks for it.

```
crew server discord setup [--guild=<id>] [--channel=<name|id>] [--text-channel=<name|id|voice>] [--user=<id>] | status | channels | send [--text=<message>] [--file=<path>]… | off
```

#### `crew server discord setup`

Checks the bot token with Discord (rejected → nothing saved), saves it to ~/.config/crew-voiceos/discord.key (owner-only), then decides the server (the only one the bot is in, else --guild), whose voice it takes (the server owner, else --user), and the channel (one named Voice OS, else the only voice channel, else --channel by name or id), checks the bot may View Channel, Connect and Speak there, and writes ~/.crew/voiceos/discord.json, which a running Voice OS watches. Each decision prints as one line; a choice it cannot make lists the options (<id>\t<name>) and exits 1. With no token and nothing saved it prints the four setup steps and exits 1.

```
crew server discord setup [--guild=<id>] [--channel=<name|id>] [--text-channel=<name|id|voice>] [--user=<id>]
```

Output: `server: <name> (<id>) / you: <who> (<id>) / channel: <name> (<id>) / messages: the voice channel's chat | #<name> (<id>) / ready: Voice OS joins it while it runs`

- `--guild=<id>` — The server, when the bot is in several
- `--channel=<name|id>` — The voice channel, when there are several and none is named Voice OS
- `--user=<id>` — Whose voice Voice OS takes (default the server owner)
- `--text-channel=<name|id|voice>` — Where crew server discord send posts: a text channel (checks the bot may View Channel, Send Messages and Attach Files); voice goes back to the voice channel's own chat (default kept from the last setup; at first the voice channel's chat)

The token is read from stdin (hidden at a terminal), never from an argument; it is never printed or logged. A rerun with nothing pasted reuses the saved token, so --guild or --channel after an error needs no paste.

Only the one user's voice is heard: Voice OS ignores everyone else in the channel.

--json: the discord.json object {guild,channel,channel_name,guild_name,owner,text_channel?,text_channel_name?}; the lines go to stderr.

```bash
pbpaste | crew server discord setup
crew server discord setup --guild=155 --channel="Voice OS"
```

#### `crew server discord status`

The setup (server, channel, owner, whether the token is saved) and what Voice OS last reported from ~/.crew/voiceos/discord-status.json: connected, whether the owner is in the channel, its error.

```
crew server discord status [--json]
```

Output: `<field>\t<value>`

--json: {"set_up":bool,"token":bool,"config":{guild,channel,channel_name,guild_name,owner}|null,"live":{connected,owner_in_channel,error,at}|null}. live null: Voice OS has not reported.

```bash
crew server discord status
crew server discord status --json
```

#### `crew server discord channels`

The channels of the server a message can go to — text and announcement channels, and the voice channels' own chats — for picking --text-channel.

```
crew server discord channels [--json]
```

Output: `<id>\t<name>\t<text|voice>[, voice channel][, messages go here]`

--json: [{"id","name","kind":"text"|"voice","is_voice":bool,"is_current":bool}].

```bash
crew server discord channels
```

#### `crew server discord send`

Posts a message to the developer's Discord: where messages go (the voice channel's chat, or the text channel picked with --text-channel), with the bot token. Works from the main and from any remote: a remote stages it and the main fetches and posts it. For a session to use when the developer asks it to send something there.

```
crew server discord send [--text=<message>] [--file=<path>]…
```

Output: `sent to <#channel | the voice channel's chat>: <link>`

- `--text=<message>` — The message; without it, text piped on stdin
- `--file=<path>` — A file to attach (repeat for more): at most 10, each at most 10 MB

Text over 2000 characters goes as message.md. Every limit is checked before anything is sent: a message posts whole or not at all, and mentions in it never ping anyone.

--json: {"channel","channel_name","message","link","files":n,"text_attached":bool,"is_voice_chat":bool}; the line goes to stderr.

```bash
crew server discord send --text="The retry fix is in" --file=screenshot.png
git log -5 --oneline | crew server discord send
```

#### `crew server discord off`

Voice OS leaves Discord: removes discord.json and the saved token.

```
crew server discord off
```

Output: `removed\t<path>`

```bash
crew server discord off
```

### `crew server dev`

One dev build of crew and Voice OS on every machine, to try a branch with your remotes before it is released. Any machine — the main or a remote — pushes its own checkout.

```
crew server dev push [--dry-run] | status
```

#### `crew server dev push`

Builds crew and Voice OS from the crew checkout you are in, once per OS and CPU your machines run, stamped dev-<commit> (-dirty-<hash of the changes> with uncommitted ones), and hands the push to the main, where it runs detached (tmux crew-voice-push) so restarting Voice OS or the Claude session that asked never ends it. It copies both binaries to every machine and checks them, installing nothing if any copy fails; then installs and restarts each machine: the other remotes, then the main, the machine you pushed from last. A machine out of reach is skipped and named.

```
crew server dev push [--dry-run]
```

Output: `<machine>\t<goos>_<goarch>|skipped: <why> / Pushing <version> to every machine; …`

- `--dry-run` — List the machines and their targets; build and push nothing

Needs go and bun on the machine you push from. Returns once the push starts; crew server dev status follows it.

crew update on a machine goes back to the latest release.

```bash
crew server dev push --dry-run
crew server dev push
```

#### `crew server dev status`

The last push, read on the main (a remote asks it): its version, source, phase, and each machine — copied, restarted, skipped or failed with why.

```
crew server dev status [--json]
```

Output: `<version> from <source>: <phase> / <machine>\t<goos>_<goarch>\t<state>`

--json: {version,source,started_at,phase,running,error,machines:[{id,name,host,target,skipped,staged,installed,error}]}, or null before any push.

```bash
crew server dev status
crew server dev status --json
```

## `crew update`

Update crew to the latest release (and an installed Voice OS with it, never restarting a running server — crew server restart does that). --check only asks whether there is one.

```
crew update [--check]
```

Output: `--check: crew v<current> — v<latest> is available (crew update) | up to date (latest v<latest>) | crew (dev build[ <sha>]) — crew update installs the latest release (v<latest>)`

- `--check` — Install nothing; --json: {current, latest, available, dev, error?, line} (line: the text form) — offline is available false with the error, not a failure; a dev build is never available and says dev true (crew update replaces it with the latest release), one ahead of the latest is up to date (crew update never downgrades). Bare crew update --json: {from, to, updated}, narration on stderr

```bash
crew update
crew update --check --json
```

## `crew help`

Show help for any command. Use --json for machine-readable output of the full command tree.

```
crew help [<command>] [<subcommand>] [--json]
```

```bash
crew help
crew help dev add
crew help --json
```
