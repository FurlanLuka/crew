# crew

CLI + TUI workspace manager for Claude Code. Workspaces hold projects; worktrees are isolated working copies of them, each with its own dev servers, stable ports, and env bindings that point projects at each other.

## Features

Everything is a command; the TUIs (`crew workspace`, `crew project`, `crew config`, `crew
launch`) sit on top of them. List commands print tab-separated rows; `--json` works anywhere.

| Read state | |
|---|---|
| `crew ls workspaces` · `ls worktrees [--size]` · `ls projects` · `ls bindings` · `ls overrides` | What exists — worktrees is "what do I have checked out", `--size` adds bytes on disk |
| `crew show <ws>/<wt>` · `crew dev status` · `crew dev show <project>` | Paths and roles; running servers with ports and URLs; a project's configured servers |
| `crew env <ws>/<wt> <project>` · `crew ps` · `crew trash` · `crew config show` | Resolved env; crew's processes; what is still clearing from the trash; settings |

| Projects and dev servers | |
|---|---|
| `crew add project <name> <path> [--setup=<cmd>]` | Register a repo; re-run with `--setup` or `--path` to change one |
| `crew dev add <project> --name --port --cmd [--dir]` · `dev rm` · `dev setup` | Named dev servers; the port is reference only, crew allocates real ones |

| Bindings | |
|---|---|
| `crew add binding <project> --var=X --url=proj \| --host=proj \| --port=proj \| --value=…` | Declare which env vars crew computes: `{{proj}}`, `{{proj.host}}`, `{{proj.port}}`, `{{proj/server}}`, `{{worktree}}`, `{{workspace}}` |
| `crew add binding <project> --scan [--apply]` | Propose bindings from the project's own `.env` |
| `crew add override <ws>/<wt> VAR=value` · `rm override` | Pin a variable for one worktree |
| `crew run <ws>/<wt> <project> -- <cmd>` | Run anything with the same env the dev servers got |

| Workspaces and worktrees | |
|---|---|
| `crew add workspace <name> [<project> --role=r [--direct]]` · `rm workspace <ws> <project>` · `rm <ws>` | Membership |
| `crew add worktree <ws>/<name> [--pull] [--no-install] [--no-smoke]` · `duplicate` · `setup` | A working copy: base-branch table, checkouts, `.env`, installs, smoke start |
| `crew rm worktree <ws>/<name>` | Returns at once; the checkout is cleared in the background (`crew trash`) |
| `crew migrate [--dry-run]` | Move pre-2.0 workspaces to the nested layout |

| Dev servers | |
|---|---|
| `crew dev start\|stop\|restart <ws>/<wt> [--proxy]` · `dev logs <server> [-f]` | Stable per-worktree ports, bindings exported, anomalies printed; `--proxy` adds LAN hostnames |

| Launching | |
|---|---|
| `crew claude <ws>/<wt>` · `crew edit <ws>/<wt>` · `crew open <ws>/<wt>` | Claude in the terminal; local editor with the prompt and Claude wired; a shell in the worktree |
| `crew code <ws>/<wt>` · `crew start <ws>/<wt>` · `crew launch <ws>/<wt>` | Remote-SSH URL; the orientation prompt; the worktree page (TUI) |

| Another machine, housekeeping | |
|---|---|
| `crew export [file] [--all \| --projects=… [--workspaces=…]]` · `crew import <file> [--all]` | Projects (with origin remotes) and workspace membership in one file; a card-by-card wizard on the other side |
| `crew trash [empty]` · `crew kill` · `crew config set\|refresh` · `crew update` · `crew uninstall [--purge]` | Finish clearing removed checkouts; reclaim leaked processes; settings; updates; removal |

## Install

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/FurlanLuka/crew/main/install.sh | sh

# Or build from source
go install github.com/FurlanLuka/crew/crew@latest
```

Linux installs pull in `tmux` and `git` if missing. Claude Code itself:
`curl -fsSL https://claude.ai/install.sh | bash`.

## Quick start

```bash
crew add project speak-api ~/Documents/speak-api          # register repos
crew dev add speak-api --name=speak-api --port=3000 --cmd="npm start"
crew add workspace phone-speak speak-api --role=api        # workspace + first project
crew add binding ai-tutor-api --scan --apply               # bindings from its .env
crew dev start phone-speak/main                            # servers on stable ports
crew claude phone-speak/main                               # Claude in the worktree
crew add worktree phone-speak/wrk2 --pull                  # a second working copy
crew export ~/Desktop/crew.json --all                      # take it to another machine
```

Or drive it from the TUI: `crew project`, `crew workspace`, `crew <ws>/<wt>`.

## Claude Code plugin

The `crew` skill and agent ship in this repo, so Claude Code can drive crew for you:

```
/plugin marketplace add FurlanLuka/crew
/plugin install crew@crew
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
   environment. `SPEAK_API_URL={{speak-api}}` becomes `http://localhost:54494`;
`LIVEKIT_URL=ws://{{livekit.host}}/rtc` becomes `ws://localhost:54497/rtc`.
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

### Removal and disk

`crew rm worktree` moves the checkout into `~/.crew/trash` and returns at once; a background
delete clears it, and every crew run retries what was left. `crew trash` shows what is still
clearing, `crew trash empty` finishes it now. `crew ls worktrees --size` shows where the
space went — build output inside a checkout is what grows.

### Settings

Configured via `crew config` (TUI), `crew config set`, or `~/.crew/config.json`:

| Setting | Description | Default |
|---------|-------------|---------|
| `server_ip` | LAN IP for `--proxy` URLs | auto-detected |
| `domain` | Custom domain for proxy URLs (e.g., `luka.ngrok.pro`) | `<server_ip>.nip.io` |
| `ssh_host` | SSH host alias for remote editor | — |
| `proxy_port` | Reverse proxy listen port | 80 |

`crew config refresh` rewrites the tmux config crew manages.
