# crew

CLI + TUI workspace manager for Claude Code. Workspaces hold projects; worktrees are isolated working copies of them, each with its own dev servers, stable ports, and env bindings that point projects at each other.

## Features

| Command | Description |
|---------|-------------|
| `crew project` | Global project pool — register repos, configure dev servers and bindings |
| `crew workspace` | Workspaces and their worktrees; enter a worktree for servers, launch and open |
| `crew add worktree <ws>/<name>` | A second working copy of a workspace — fresh git worktree per project |
| `crew launch <ws>/<wt>` | The worktree page: servers with status and URLs, Editor + Claude, Claude, open |
| `crew dev start <ws>/<wt> [--proxy]` | Start dev servers on stable per-worktree ports; `--proxy` adds LAN hostnames |
| `crew dev status\|stop\|restart\|logs` | Manage running servers |
| `crew add binding <project> --scan` | Declare which env vars crew computes from the ports it allocates |
| `crew env <ws>/<wt> <project>` | A project's resolved env for that worktree, `KEY=VALUE` |
| `crew run <ws>/<wt> <project> -- <cmd>` | Run a script or eval with the same env the dev servers got |
| `crew show <ws>/<wt>` | Projects with paths and roles |
| `crew code <ws>/<wt>` | Remote SSH URLs for Cursor/VS Code |
| `crew migrate` | Move pre-worktree workspaces to the nested layout |
| `crew config` | Settings — server IP, SSH host, proxy port, uninstall |

## Setup — macOS

```bash
# Install crew
curl -fsSL https://raw.githubusercontent.com/FurlanLuka/crew/main/install.sh | sh

# Or build from source
go install github.com/FurlanLuka/crew/crew@latest

# Add projects, create workspace, launch
crew project
crew workspace
```

## Setup — Linux / Remote Server

```bash
# Install crew + dependencies (tmux, git)
curl -fsSL https://raw.githubusercontent.com/FurlanLuka/crew/main/install.sh | sh

# Install Claude Code
curl -fsSL https://claude.ai/install.sh | bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc

```

## Quick start

```bash
crew project              # Add your projects (name + path)
crew workspace            # Create a workspace, add projects, enter a worktree
crew <workspace>/<wt>     # Open a worktree directly
```

## Architecture

### Projects, workspaces, worktrees

**Projects** are git repositories registered in a global pool (`crew project`). Each has a
name, a path, its dev servers, and its **bindings** — the env vars it needs from other
projects, as templates over the ports crew allocates.

**Workspaces** are membership: which projects, with which roles. **Worktrees** are the working
copies — one git worktree per project, on branch `crew/<ws>/<wt>/<project>`, isolated from the
main repo until merged. A workspace can have any number.

```
~/.crew/workspaces/
  phone-speak/
    wrk1/
      speak-api/        ← branch crew/phone-speak/wrk1/speak-api
      ai-tutor-api/
    wrk2/
      speak-api/        ← branch crew/phone-speak/wrk2/speak-api
      ai-tutor-api/
```

### Dev servers, ports, bindings

Each project can have named dev servers. `crew dev start phone-speak/wrk2`:

1. Allocates a free port per server — and remembers it, so the worktree keeps its ports across
   restarts. The configured `--port` is reference only.
2. Resolves every project's bindings against those ports and exports them into the server's
   environment. `SPEAK_API_URL={{url:speak-api}}` becomes `http://localhost:54494`.
3. Runs each server in a tmux window with `PORT` set. URLs are `http://localhost:<port>`.
4. Prints anything it could not resolve, and any env value pointing at a port that belongs to
   something else — the wrong-service bug caught at start instead of at runtime.

Env files are read, never written. Overrides pin a variable for one worktree.

With `--proxy`, a shared reverse proxy on port 80 also serves every server as
`http://<server>--<workspace>--<worktree>.<domain>` for other devices on the LAN, with
`<domain>` defaulting to `<lan-ip>.nip.io`.

### Launching

Enter a worktree (`crew launch phone-speak/wrk1`, or from `crew workspace`) for one page:
servers with status and URLs, **Editor + Claude** (Cursor/VS Code with the orientation prompt
and Claude wired up), **Claude in terminal** (`--add-dir` per project, permissions skipped), and
open actions.

### Settings

Configured via `crew config` (TUI) or `~/.crew/config.json`:

| Setting | Description | Default |
|---------|-------------|---------|
| `server_ip` | LAN IP for `--proxy` URLs | auto-detected |
| `domain` | Custom domain for proxy URLs (e.g., `luka.ngrok.pro`) | `<server_ip>.nip.io` |
| `ssh_host` | SSH host alias for remote editor | — |
| `proxy_port` | Reverse proxy listen port | 80 |
