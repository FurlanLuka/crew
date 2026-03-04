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
| `crew ls workspaces` | List all workspaces |
| `crew show <ws>` | Show projects in a workspace |
| `crew dev show <project>` | Show configured dev servers for a project |
| `crew dev status` | Show all running dev servers with URLs |
| `crew dev status <ws>` | Show running dev servers for one workspace |
| `crew dev add <project> ...` | Add a dev server to a project |
| `crew dev rm <project> <name>` | Remove a dev server from a project |
| `crew dev start <ws> [--host=<ip>]` | Start dev servers with reverse proxy |
| `crew dev stop [<ws>]` | Stop dev servers |
| `crew dev restart <ws> [--host=<ip>]` | Restart dev servers |
| `crew start <ws>` | Generate agent prompt for a workspace |
| `crew happier <ws>` | Launch Happier session in tmux |
| `crew stop <ws>` | Stop a workspace session |
| `crew rm <ws>` | Remove a workspace entirely |
| `crew launch [<workspace>]` | Open the launch view (TUI) |
| `crew plans start` | Start the plan viewer server |
| `crew plans stop` | Stop the plan viewer server |
| `crew help [cmd] [subcmd]` | Show help for a command |
| `crew help --json` | Full command tree as JSON |

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
Output: `<project>\t<server-name>\t<port>\t<command>[\t<dir>]`

Shows what dev servers are **configured** (not necessarily running).

### Show running dev servers

```bash
crew dev status              # all workspaces
crew dev status <workspace>  # one workspace
```
Output: `<workspace>\t<port>\t<url>`

Shows **running** dev servers with their nip.io URLs.

## URL Resolution

Dev servers use nip.io for DNS:
```
http://<workspace>.<lan-ip>.nip.io:<port>
```

- The workspace name is used as the subdomain
- The LAN IP is auto-detected (the server's non-loopback IPv4)
- Each workspace gets its own subdomain on the same external port

To find the URL for a workspace:
```bash
crew dev status <workspace>
```

## Plan Viewer

Built-in web dashboard for browsing Claude plan files (`CLAUDE_CONFIG_DIR/plans/*.md`).

```bash
crew plans start   # start the plan viewer (runs in tmux session crew-plans)
crew plans stop    # stop the plan viewer
```

URL: `http://plans.<lan-ip>.nip.io:3080` (port 3080 by default, standalone — not proxied through the dev proxy).

The plan viewer is a built-in Go HTTP server with an embedded SPA. No external dependencies required.

## Managing

### Add a dev server

```bash
crew dev add <project> --name=<n> --port=<p> --cmd="<c>" [--dir=<d>]
```

- `--name`: server name (e.g., `web`, `api`)
- `--port`: external port (e.g., `5173`, `3000`)
- `--cmd`: start command (e.g., `npm run dev`)
- `--dir`: subdirectory relative to project root (for monorepos)

### Start dev servers

```bash
crew dev start <workspace>
crew dev start <workspace> --host=<ip>
```

### Stop dev servers

```bash
crew dev stop                 # stop all
crew dev stop <workspace>     # stop workspace
```

### Restart dev servers

```bash
crew dev restart <workspace> [--host=<ip>]
```

### Launch a session

**IMPORTANT:** `crew happier` must run **outside** of Claude Code — it spawns a tmux session that won't work if launched from within a Claude Code agent. Detach it or instruct the user to run it in a separate terminal.

```bash
crew launch                   # open workspace picker (TUI)
crew launch <workspace>       # open launch view for a workspace (TUI)
crew start <workspace>        # generate agent prompt
nohup crew happier <workspace> >/dev/null 2>&1 &  # launch Happier (detached)
```

### Stop / remove a workspace

```bash
crew stop <workspace>         # stop session (tmux + dev servers)
crew rm <workspace>           # remove workspace entirely (worktrees, dir, JSON)
```

## Output Formats

All commands use **tab-separated** output for easy parsing:

| Command | Format |
|---|---|
| `crew ls workspaces` | `<name>\t<n> projects` |
| `crew show <ws>` | `<name>\t<path>\t<role>` |
| `crew dev show <project>` | `<project>\t<server>\t<port>\t<cmd>[\t<dir>]` |
| `crew dev status [<ws>]` | `<workspace>\t<port>\t<url>` |

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
