---
name: crew-remote
description: >
  Remote management reference for crew workspaces, dev servers,
  and deployment URLs. Quick reference card for all CLI commands an AI agent
  needs to inspect and manage a crew installation.
user-invocable: true
---

# Crew Remote Management

Reference card for managing crew workspaces and dev servers from a remote agent.

## Quick Reference

| Command | Description |
|---|---|
| **Projects** | |
| `crew ls projects` | List all registered projects |
| `crew add project <name> <path>` | Register a project |
| `crew rm project <name>` | Remove a project |
| **Workspaces** | |
| `crew ls workspaces` | List all workspaces |
| `crew show <ws>` | Show projects in a workspace |
| `crew add workspace <name>` | Create a workspace |
| `crew add workspace <ws> <proj> --role=<r>` | Add project to workspace |
| `crew rm workspace <ws> <project>` | Remove project from workspace |
| `crew rm <ws>` | Remove entire workspace |
| **Dev Servers** | |
| `crew dev show <project>` | Show configured dev servers for a project |
| `crew dev status` | Show all running dev servers with URLs |
| `crew dev status <ws>` | Show running dev servers for one workspace |
| `crew dev setup <project>` | Interactive dev server configuration (TUI) |
| `crew dev add <project> ...` | Add a dev server to a project |
| `crew dev rm <project> <name>` | Remove a dev server from a project |
| `crew dev start <ws> [--host=<ip>]` | Start dev servers with reverse proxy |
| `crew dev stop [<ws>]` | Stop dev servers |
| `crew dev restart <ws> [--host=<ip>]` | Restart dev servers |
| **Registry** | |
| `crew registry install [<name> \| --all]` | Install agents/skills |
| `crew registry update [<name> \| --all]` | Update agents/skills |
| `crew registry rm <name>` | Remove an agent or skill |
| **Profile** | |
| `crew profile status` | Check if profile is installed |
| `crew profile install` | Install Claude profile |
| `crew profile update` | Update Claude profile |
| `crew profile rm` | Remove Claude profile |
| **Config** | |
| `crew config show` | Show all settings |
| `crew config set <key> <value>` | Set a config value |
| **Notifications** | |
| `crew notify setup [<topic>]` | Enable push notifications |
| `crew notify test` | Send test notification |
| `crew notify rm` | Disable push notifications |
| **Other** | |
| `crew start <ws>` | Generate agent prompt for a workspace |
| `crew launch [<ws>]` | Open the launch view (TUI) |
| `crew git <ws>` | Launch lazygit in tmux (ephemeral, dies on detach) |
| `crew plans start` | Start the plan viewer server |
| `crew plans stop` | Stop the plan viewer server |
| `crew help [cmd] [subcmd]` | Show help for a command |
| `crew help --json` | Full command tree as JSON |

## Concepts

### Projects

Projects are registered in a global pool with a name and path to a git repo. They can be added to multiple workspaces.

### Workspaces

A workspace groups projects together for a task. When a project is added to a workspace, crew creates a **git worktree** — an isolated branch that doesn't affect the main repo.

### Dev servers

Each project can have named dev servers (e.g., `api`, `web`). When started, crew assigns each a random internal port and runs them in tmux windows. A shared reverse proxy on port 80 routes requests by subdomain.

### Git sessions

`crew git <ws>` launches lazygit in a tmux session with one window per project. Sessions are ephemeral — they auto-destroy when you detach (`ctrl-b d`). Re-running `crew git <ws>` creates a fresh session.

## Inspecting

### List workspaces

```bash
crew ls workspaces
```
Output: `<name>\t<n> projects`

### Show projects in a workspace

```bash
crew show <workspace>
```
Output: `<name>\t<path>\t<role>`

### Show configured dev servers

```bash
crew dev show <project>
```
Output: `<server-name>\t<port>\t<command>[\t<dir>]`

Shows what dev servers are **configured** (not necessarily running).

### Show running dev servers

```bash
crew dev status              # all workspaces
crew dev status <workspace>  # one workspace
```
Output: `<workspace>\t<server-name>\t<port>\t<url>`

Shows **running** dev servers with their nip.io URLs.

## Dev Server Architecture

### URL scheme

Dev servers use a shared reverse proxy on port 80 with a flat subdomain format:
```
http://<server>--<workspace>.<domain>
```

- `<server>` — the dev server name (e.g., `api`, `web`) set via `--name`
- `<workspace>` — the workspace name
- `<domain>` — auto-detected as `<lan-ip>.nip.io`, or a custom domain via `crew config`
- The `--` separator keeps everything in a single subdomain level (wildcard SSL compatible)
- Port 80 is the default — no port needed in URLs

Example: `http://api--my-ws.192.168.1.50.nip.io`

### How it works

1. `crew dev start <ws>` finds a free port for each dev server
2. Each server runs in its own tmux window with `PORT=<free-port>` set
3. A shared reverse proxy (single tmux session `crew-dev-proxy`) listens on port 80
4. On each request, the proxy extracts `<server>` and `<workspace>` from the hostname
5. It looks up the route file (`dev-routes-<ws>.json`) to find the internal port
6. The request is forwarded to `localhost:<internal-port>`

The proxy supports both HTTP and WebSocket connections.

### Port assignment

The `--port` flag on `crew dev add` is the port your app normally listens on (for reference only). At runtime, crew assigns a random free port and passes it via the `PORT` environment variable. Your start command should use `$PORT`:

```bash
crew dev add myproject --name=api --port=3000 --cmd="npm run dev -- --port \$PORT"
```

Or if your framework reads `PORT` automatically (e.g., Next.js, Express), just use the standard command.

## Managing

### Add a dev server

```bash
crew dev add <project> --name=<n> --port=<p> --cmd="<c>" [--dir=<d>]
```

- `--name`: server name, used as subdomain (e.g., `web`, `api`)
- `--port`: the port the dev server normally listens on
- `--cmd`: start command (e.g., `npm run dev`). Use `$PORT` for the dynamic internal port
- `--dir`: subdirectory relative to project root (for monorepos)

### Start dev servers

```bash
crew dev start <workspace>
crew dev start <workspace> --host=<ip>
```

### Stop dev servers

```bash
crew dev stop                 # stop all
crew dev stop <workspace>     # stop one workspace
```

### Restart dev servers

```bash
crew dev restart <workspace> [--host=<ip>]
```

### Remove a workspace

```bash
crew rm <workspace>           # stops dev servers, removes worktrees, dir, and JSON
```

## Output Formats

All CLI list commands use **tab-separated** output for easy parsing:

| Command | Format |
|---|---|
| `crew ls workspaces` | `<name>\t<n> projects` |
| `crew ls projects` | `<name>\t<path>` |
| `crew show <ws>` | `<name>\t<path>\t<role>` |
| `crew dev show <project>` | `<server>\t<port>\t<cmd>[\t<dir>]` |
| `crew dev status [<ws>]` | `<workspace>\t<server>\t<port>\t<url>` |

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/FurlanLuka/crew/main/install.sh | sh
```

## Common Patterns

### "Show me what's running"

```bash
crew dev status
```

### "Set up dev servers for a project"

```bash
# 1. Check what's configured
crew dev show <project>

# 2. Add missing servers
crew dev add <project> --name=web --port=5173 --cmd="npm run dev"

# 3. Start them for a workspace
crew dev start <workspace>
```

### "What's the URL for my workspace?"

```bash
crew dev status <workspace>
```

### "Full setup from scratch"

```bash
# 1. Register projects
crew add project my-api /path/to/api
crew add project my-web /path/to/web

# 2. Create workspace and add projects
crew add workspace my-ws
crew add workspace my-ws my-api --role="Backend API"
crew add workspace my-ws my-web --role="Frontend"

# 3. Configure dev servers
crew dev add my-api --name=api --port=3000 --cmd="npm run dev"
crew dev add my-web --name=web --port=5173 --cmd="npm run dev"

# 4. Launch
crew launch <workspace>       # TUI — pick Editor+Agents or Claude
crew dev start my-ws          # start dev servers
```
