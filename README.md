# crew

CLI + TUI workspace manager for Claude Code. Manages multi-agent workspaces, dev servers with reverse proxy, agent/skill registry, and session launching.

## Features

| Feature | Command | Description |
|---------|---------|-------------|
| `projects` | `crew project` | Global project pool — register repos, list, remove |
| `projects.servers` | `crew dev add <project>` | Configure dev servers per project (name, port, command, dir) |
| `projects.servers.setup` | `crew dev setup <project>` | Interactive dev server configuration wizard with npm script auto-detection |
| `workspaces` | `crew workspace` | Group projects into isolated workspaces with automatic git worktrees |
| `workspaces.launch.editor` | `crew launch <ws>` | Open workspace in Cursor/VS Code with agent team prompt auto-generated |
| `workspaces.launch.claude` | `crew launch <ws>` | Launch Claude Code session with `--add-dir` for each project |
| `workspaces.launch.claude-skip` | `crew launch <ws>` | Launch Claude with `--dangerously-skip-permissions` |
| `workspaces.open` | `crew open <ws>` | Open shell in workspace directory |
| `workspaces.git` | `crew git <ws>` | Launch lazygit in tmux with one window per project (ephemeral session) |
| `workspaces.code` | `crew code <ws>` | Generate Remote SSH URLs for Cursor/VS Code |
| `workspaces.show` | `crew show <ws>` | Display workspace projects with paths and roles |
| `workspaces.remove` | `crew rm <ws>` | Remove a workspace and clean up worktrees |
| `workspaces.shortcut` | `crew <ws>` | Launch workspace directly by name |
| `dev.start` | `crew dev start <ws>` | Start dev servers for a workspace with automatic free port assignment |
| `dev.stop` | `crew dev stop [<ws>]` | Stop dev servers for a workspace or all workspaces |
| `dev.restart` | `crew dev restart <ws>` | Restart dev servers with fresh port assignment |
| `dev.status` | `crew dev status [<ws>]` | Show running servers with clickable URLs |
| `dev.logs` | TUI | Live dev server logs with per-server tabs and proxy tab |
| `dev.proxy` | automatic | Shared reverse proxy — routes by subdomain, supports HTTP + WebSocket |
| `dev.proxy.routing` | automatic | `<server>.<workspace>.<lan-ip>.nip.io` URL format, hot-reloaded routes |
| `registry` | `crew registry` | Browse, install, update, and remove agents & skills |
| `registry.install` | `crew registry install <name>` | Install individual items or bulk install with `--all` |
| `registry.verify` | automatic | SHA256 content verification, GitHub API with token support and local fallback |
| `profile` | `crew profile` | View, install, update, and remove Claude profile (CLAUDE.md) |
| `notify` | `crew notify` | Push notifications via ntfy.sh — get alerted when Claude needs attention |
| `plans` | `crew plans [start\|stop]` | View Claude plans with built-in web viewer |
| `config` | `crew config` | Settings — server IP, SSH host, proxy port |

## Setup — macOS

```bash
# Install crew
curl -fsSL https://raw.githubusercontent.com/FurlanLuka/crew/main/install.sh | sh

# Or build from source
go install github.com/FurlanLuka/crew/crew@latest

# Install all agents & skills
crew registry install --all

# Add projects, create workspace, launch
crew project
crew workspace
```

## Setup — Linux / Remote Server

```bash
# Install crew + dependencies (Node.js, tmux, lazygit, delta)
curl -fsSL https://raw.githubusercontent.com/FurlanLuka/crew/main/install.sh | sh

# Install GitHub CLI (needed for registry API calls)
(type -p wget >/dev/null || sudo apt-get install -y wget) && \
sudo mkdir -p /etc/apt/keyrings && \
wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null && \
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
sudo apt-get update && sudo apt-get install -y gh

# Install Claude Code
curl -fsSL https://claude.ai/install.sh | bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc

# Authenticate GitHub
gh auth login

# Install all agents & skills
crew registry install --all
```

## Quick start

```bash
crew project              # Add your projects (name + path)
crew workspace            # Create a workspace, add projects, launch
crew <workspace-name>     # Launch workspace directly
```

## Architecture

### Projects and workspaces

**Projects** are git repositories registered in a global pool (`crew project`). Each has a name and a path.

**Workspaces** group projects together for a task. When a project is added to a workspace, crew creates a **git worktree** — an isolated branch in its own directory. Changes stay isolated from the main repo until explicitly merged.

```
~/.crew/workspaces/
  my-workspace/
    api/          ← git worktree (branch: crew/my-workspace/api)
    web-app/      ← git worktree (branch: crew/my-workspace/web-app)
```

### Dev server proxy

Each project can have named dev servers (e.g., `api`, `web`). When started, crew:

1. Assigns each server a random free port
2. Runs each in a tmux window with `PORT=<free-port>` set
3. Starts a shared reverse proxy on **port 80**
4. Routes requests by subdomain to the correct internal port

```
                    ┌─────────────────────────────────────┐
                    │         Reverse Proxy (:80)         │
                    │                                     │
  HTTP request      │  api.my-ws.192.168.1.50.nip.io     │
 ──────────────────►│  → extract server=api, ws=my-ws    │
                    │  → lookup dev-routes-my-ws.json     │
                    │  → forward to localhost:54321       │
                    │                                     │
                    └─────────────────────────────────────┘
                          │                    │
                    ┌─────┴─────┐        ┌─────┴─────┐
                    │ api:54321 │        │ web:54322 │
                    │ (tmux)    │        │ (tmux)    │
                    └───────────┘        └───────────┘
```

**URL format:** `http://<server>.<workspace>.<lan-ip>.nip.io`

- `<server>` — dev server name (set with `--name`)
- `<workspace>` — workspace name
- `<lan-ip>` — auto-detected LAN IP (override with `--host`)
- [nip.io](https://nip.io) is a free wildcard DNS service — any request to `<anything>.<ip>.nip.io` resolves to `<ip>`. This lets you use real hostnames with subdomains instead of `localhost:<port>`, which means the reverse proxy can route by hostname without any DNS configuration

The proxy supports HTTP and WebSocket connections. Route files (`dev-routes-*.json`) are hot-reloaded on each request.

### Sessions

**Launch modes** (`crew launch <ws>`):
- **Editor + Agents** — opens workspace in Cursor/VS Code, generates agent team prompt
- **Claude** — launches Claude Code directly with `--add-dir` for each project

**Git sessions** (`crew git <ws>`) open lazygit in tmux with one window per project. Sessions are ephemeral — they auto-destroy on detach via `destroy-unattached`.

### Settings

Configured via `crew config` (TUI) or `~/.claude-personal/config.json`:

| Setting | Description | Default |
|---------|-------------|---------|
| `server_ip` | LAN IP for nip.io URLs | auto-detected |
| `ssh_host` | SSH host alias for remote editor | — |
| `proxy_port` | Reverse proxy listen port | 80 |

## Registry

Community agents and skills live in [`registry/`](registry/).

```bash
crew registry             # Browse and install agents & skills (TUI)
crew registry install --all          # Install everything (CLI)
crew registry install <name>         # Install a specific agent or skill
```

Push notifications via [ntfy.sh](https://ntfy.sh) — get alerted when Claude needs attention:

```bash
crew notify               # One-time setup (no account needed)
```

### Agents

| Agent | Description |
|-------|-------------|
| `crew` | Workspace management, dev servers, session launching. |
| `architect` | Software architecture and system design agent. |
| `daily-chores` | Read-only daily dashboard. Gathers GitHub PRs, Linear tasks, and project updates. |
| `nodejs-code-reviewer` | Reviews Node.js/backend TypeScript code for quality, security, and standards. |
| `pr-reviewer` | Reviews GitHub pull requests using the gh CLI. |
| `reactjs-code-reviewer` | Reviews React code for quality, security, and standards. |
| `web-designer` | Award-winning web designer. Generates unique designs through iterative conversation. |

### Skills

| Skill | Description |
|-------|-------------|
| `js-ts-clean-code` | JS/TS clean code guidelines (readability, formatting, naming, imports, structure, patterns). |
| `nodejs-clean-code` | Node.js/backend-specific guidelines (error handling, async). Extends `js-ts-clean-code`. |
| `reactjs-clean-code` | React-specific guidelines (components, state, hooks, composition). Extends `js-ts-clean-code`. |
| `reactjs-new-project` | Recommended React project architecture and setup conventions. |
| `crew-remote` | Remote management reference for crew workspaces and dev servers. |
| `crew-launch` | Interactive workspace launcher with dev server setup. |
| `pr-review-comments` | Comment style guide for PR reviews. Support skill for pr-reviewer. |
| `web-designer` | Design system knowledge base for web design generation. Support skill for web-designer. |

To contribute, add your agent or skill and open a PR.
