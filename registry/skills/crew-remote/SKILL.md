---
name: crew-remote
description: >
  Remote management reference for crew workspaces, worktrees, dev servers,
  and deployment URLs. Quick reference card for all CLI commands an AI agent
  needs to inspect and manage a crew installation.
user-invocable: true
---

# Crew Remote Management

Reference card for managing crew workspaces, worktrees, and dev servers from a remote agent.

## Quick Reference

| Command | Description |
|---|---|
| `crew ls workspaces` | List all workspaces |
| `crew ls worktrees <ws>` | List worktree names for a workspace |
| `crew show <ws>` | Show projects in a workspace |
| `crew dev show <ws>` | Show configured dev servers |
| `crew dev status` | Show all running dev servers with URLs |
| `crew dev status <ws>` | Show running dev servers for one workspace |
| `crew dev add <ws> <proj> ...` | Add a dev server to a project |
| `crew dev rm <ws> <proj> <name>` | Remove a dev server from a project |
| `crew dev start <ws> [flags]` | Start dev servers with reverse proxy |
| `crew dev stop [<ws>] [flags]` | Stop dev servers |
| `crew dev restart <ws> [flags]` | Restart dev servers |
| `crew start <ws> [flags]` | Generate agent prompt for a workspace |
| `crew happy <ws> [flags]` | Launch Happy Coder session in tmux |
| `crew launch [<workspace>]` | Open the launch view (TUI) |
| `crew help [cmd] [subcmd]` | Show help for a command |
| `crew help --json` | Full command tree as JSON |

## Inspecting

### List workspaces

```bash
crew ls workspaces
```
Output: `<name>\t<n> projects\t<n> worktrees`

### Show projects in a workspace

```bash
crew show <workspace>
```
Output: `<name>\t<path>\t<role>`

### List worktrees

```bash
crew ls worktrees <workspace>
```
Output: one worktree name per line.

### Show configured dev servers

```bash
crew dev show <workspace>
```
Output: `<project>\t<server-name>\t<port>\t<command>[\t<dir>]`

Shows what dev servers are **configured** (not necessarily running).

### Show running dev servers

```bash
crew dev status              # all workspaces
crew dev status <workspace>  # one workspace
```
Output: `<workspace>\t<worktree>\t<port>\t<url>`

Shows **running** dev servers with their nip.io URLs.

## URL Resolution

Dev servers use nip.io for DNS:
```
http://<worktree>.<lan-ip>.nip.io:<port>
```

- `main` is the worktree name when no worktree is specified
- The LAN IP is auto-detected (the server's non-loopback IPv4)
- Each worktree gets its own subdomain on the same external port

To find the URL for a specific worktree:
```bash
crew dev status <workspace>
```
Then look for the matching worktree name in the output.

## Managing

### Add a dev server

```bash
crew dev add <workspace> <project> --name=<n> --port=<p> --cmd="<c>" [--dir=<d>]
```

- `--name`: server name (e.g., `web`, `api`)
- `--port`: external port (e.g., `5173`, `3000`)
- `--cmd`: start command (e.g., `npm run dev`)
- `--dir`: subdirectory relative to project root (for monorepos)

### Start dev servers

```bash
crew dev start <workspace>
crew dev start <workspace> --worktree=<name>
crew dev start <workspace> --host=<ip>
```

### Stop dev servers

```bash
crew dev stop                              # stop all
crew dev stop <workspace>                  # stop workspace
crew dev stop <workspace> --worktree=<name>  # stop one worktree
```

### Restart dev servers

```bash
crew dev restart <workspace> [--worktree=<name>] [--host=<ip>]
```

### Launch a session

**IMPORTANT:** `crew happy` must run **outside** of Claude Code — it spawns a tmux session that won't work if launched from within a Claude Code agent. Detach it or instruct the user to run it in a separate terminal.

```bash
crew launch                                # open workspace picker (TUI)
crew launch <workspace>                    # open launch view for a workspace (TUI)
crew start <workspace> --worktree=<name>   # generate agent prompt
nohup crew happy <workspace> --worktree=<name> >/dev/null 2>&1 &  # launch Happy Coder (detached)
```

Both `start` and `happy` accept `--from=<branch>` to base a new worktree on a specific branch.

## Output Formats

All commands use **tab-separated** output for easy parsing:

| Command | Format |
|---|---|
| `crew ls workspaces` | `<name>\t<n> projects\t<n> worktrees` |
| `crew ls worktrees <ws>` | `<name>` (one per line) |
| `crew show <ws>` | `<name>\t<path>\t<role>` |
| `crew dev show <ws>` | `<project>\t<server>\t<port>\t<cmd>[\t<dir>]` |
| `crew dev status [<ws>]` | `<workspace>\t<worktree>\t<port>\t<url>` |

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/FurlanLuka/crew/main/install.sh | sh
```

## Common Patterns

### "Show me what's running"

```bash
crew dev status
```

### "Set up dev servers for a workspace"

```bash
# 1. Check what's configured
crew dev show <workspace>

# 2. Add missing servers
crew dev add <workspace> <project> --name=web --port=5173 --cmd="npm run dev"

# 3. Start them
crew dev start <workspace>
```

### "What's the URL for worktree feature-x?"

```bash
crew dev status <workspace>
# Find the line with "feature-x" in the worktree column
```

### "Spin up a new worktree with dev servers"

```bash
# 1. Start dev servers for the new worktree
crew dev start <workspace> --worktree=feature-x

# 2. Check the URLs
crew dev status <workspace>
```
