# crew

Agent team launcher, workspace manager & package registry for Claude Code.

Define a workspace of projects, each with a role. Then launch an entire agent team in Cursor or tmux with a single command. Manage agents, skills, profiles, and notifications — all from one CLI.

## Install

```bash
brew install FurlanLuka/tap/crew
```

## Quick start

```bash
# Create a workspace
crew workspace create my-app

# Add projects (interactive prompts for path, role)
crew project add my-app

# Launch — agents + terminals in Cursor
crew my-app
```

## Usage

### Launch

```bash
crew [workspace]                  # Launch in Cursor
crew [workspace] -a               # Launch agents only (tmux)
```

When no workspace is specified, you get an interactive picker.

### Workspaces

```bash
crew workspace                    # Interactive picker (create/list/remove)
crew workspace create <name>      # Create a workspace
crew workspace list               # List all workspaces
crew workspace remove <name>      # Remove a workspace (picker if no name)
```

Workspaces are stored as JSON in `~/.crew/workspaces/`.

### Projects

```bash
crew project                      # Interactive picker (add/list/remove)
crew project add <workspace>      # Add a project (interactive)
crew project list <workspace>     # List projects in a workspace
crew project remove <ws> <proj>   # Remove a project
```

Each project has:
- **name** — identifier
- **path** — absolute path to the project directory
- **role** — what the agent does (e.g. "owns the backend API")

### Registry

Install and manage agents and skills from a shared registry.

```bash
crew agents                       # Interactive picker
crew agents list                  # List installed agents
crew agents install [name]        # Install agent (picker if no name)
crew agents install [name] -p     # Install to current project
crew agents remove [name]         # Remove an agent (picker if no name)
crew agents update [name]         # Update agent(s)
crew agents run [name]            # Run an installed agent
crew run [name]                   # Shortcut for agents run

crew skills                       # Interactive picker
crew skills list                  # List installed skills
crew skills install [name]        # Install skill (picker if no name)
crew skills install [name] -p     # Install to current project
crew skills remove [name]         # Remove a skill (picker if no name)
crew skills update [name]         # Update skill(s)

crew update                       # Update all agents+skills+profile
```

### Profile

```bash
crew profile                      # Interactive picker (install/show/update/remove)
crew profile install              # Install global CLAUDE.md from registry
crew profile show                 # Show current global CLAUDE.md
crew profile update               # Update profile from registry
crew profile remove               # Remove global CLAUDE.md
```

### Notifications

Push notifications via [ntfy.sh](https://ntfy.sh) when Claude needs attention.

```bash
crew notify                       # Interactive picker (setup/status/test/remove)
crew notify setup                 # Set up push notifications
crew notify status                # Show notification config
crew notify test                  # Send a test notification
crew notify remove                # Remove notification hook
```

### Session management

```bash
crew kill                         # Tear down all crew sessions
```

This kills all tmux sessions, closes Cursor/VS Code workspace windows, and cleans up temporary files.

## How it works

**Agents** — `crew` builds a prompt describing the team and launches `claude` with instructions to spawn sub-agents for each project. In Cursor, agents run as auto-start tasks alongside an empty terminal per project. Without an editor, agents run in tmux.

**Registry** — agents and skills are fetched from a GitHub registry. Agents are markdown files installed to `$CLAUDE_CONFIG_DIR/agents/`. Skills are directory bundles installed to `$CLAUDE_CONFIG_DIR/skills/`.

## Environment

| Variable | Description |
|----------|-------------|
| `CLAUDE_CONFIG_DIR` | Claude Code config directory. Defaults to `~/.claude`. |

## Requirements

- `gum` (installed automatically by Homebrew, used for interactive pickers)
- `tmux` (installed automatically by Homebrew)
- `python3`
- `claude` (Claude Code CLI)
- Cursor or VS Code (optional, for workspace + terminals)
