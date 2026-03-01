# crew

Agent team launcher, workspace manager & package registry for Claude Code. Manage multi-agent teams across projects and install community agents & skills — all from a polished interactive TUI.

## Commands

| Command | Description |
|---------|-------------|
| `crew` | Main menu — pick any domain |
| `crew workspace` | Manage workspaces, projects, worktrees, and launch |
| `crew project` | Global project pool — add/remove projects |
| `crew registry` | Install and manage agents & skills |
| `crew profile` | Manage Claude profile |
| `crew notify` | Push notification setup |
| `crew kill` | Kill all crew sessions |
| `crew <name>` | Launch workspace directly |
| `crew --version` | Print version |

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
# Install crew + dependencies (Node.js, tmux, happy CLI)
curl -fsSL https://raw.githubusercontent.com/FurlanLuka/crew/main/install.sh | sh

# Install Claude Code
curl -fsSL https://claude.ai/install.sh | bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc

# Authenticate GitHub (needed for registry API calls)
gh auth login

# Install all agents & skills
crew registry install --all
```

### Remote agent with Happy Coder

Run persistent Claude sessions on a remote server, controlled from your phone:

```bash
# On the server
happy auth login          # Scan QR code with Happy mobile app
happy daemon start        # Start background daemon

# Now spawn sessions from the Happy mobile app — they persist
# even when SSH disconnects
happy daemon status       # Check daemon
happy daemon list         # List active sessions
```

## Quick start

```bash
crew project              # Add your projects (name + path)
crew workspace            # Create a workspace, add projects, launch
crew <workspace-name>     # Launch workspace directly
crew kill                 # Tear down everything
```

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
| `pr-review-comments` | Comment style guide for PR reviews. Support skill for pr-reviewer. |
| `web-designer` | Design system knowledge base for web design generation. Support skill for web-designer. |

To contribute, add your agent or skill and open a PR.
