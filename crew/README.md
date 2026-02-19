# crew

Agent team launcher with workspace & project management.

Define a workspace of projects, each with a role and optional dev server. Then launch an entire agent team in tmux with a single command — or open all dev servers in Cursor/VS Code.

## Install

```bash
brew install FurlanLuka/tap/crew
```

## Quick start

```bash
# Create a workspace
crew workspace create my-app

# Add projects (interactive prompts for path, role, dev command, port)
crew project add my-app

# Launch everything — agents in tmux, dev servers in Cursor
crew my-app
```

## Usage

### Launch

```bash
crew [workspace]                  # Launch agents + dev servers
crew agents [workspace]           # Launch agents only (tmux)
crew servers [workspace]          # Launch dev servers only (Cursor/VS Code)
```

When no workspace is specified and only one exists, it's auto-selected. With multiple workspaces you get an interactive picker.

### Workspaces

```bash
crew workspace create <name>      # Create a workspace
crew workspace list               # List all workspaces
crew workspace delete <name>      # Delete a workspace
```

Workspaces are stored as JSON in `~/.crew/workspaces/`.

### Projects

```bash
crew project add <workspace>      # Add a project (interactive)
crew project list <workspace>     # List projects in a workspace
crew project remove <ws> <proj>   # Remove a project
```

Each project has:
- **name** — identifier
- **path** — absolute path to the project directory
- **role** — what the agent does (e.g. "owns the backend API")
- **dev command** — optional server start command (e.g. `npm run dev`)
- **port** — optional port number for the dev server

### Session management

```bash
crew kill                         # Tear down all crew sessions
```

This kills all tmux sessions, closes Cursor/VS Code workspace windows, and cleans up temporary files.

## How it works

**Agents** — `crew` creates a tmux session, builds a prompt describing the team, and launches `claude` with instructions to spawn sub-agents for each project. Each agent knows its working directory and role.

**Dev servers** — `crew` generates a `.code-workspace` file with tasks configured to auto-run on folder open, then opens it in Cursor (preferred) or VS Code.

## Environment

| Variable | Description |
|----------|-------------|
| `CLAUDE_CONFIG_DIR` | Passed through to `claude` in tmux sessions. Defaults to `~/.claude`. |

## Requirements

- `tmux` (installed automatically by Homebrew)
- `python3`
- `claude` (Claude Code CLI)
- Cursor or VS Code (optional, for dev servers)
