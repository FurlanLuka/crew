# crew

CLI + TUI workspace manager for coding agents. Workspaces hold projects; worktrees are
isolated working copies of them, each with its own dev servers, stable ports, and env
bindings that point projects at each other. Built agent-first: every action is a command,
every command has `--json`, nothing needs the TUI — any agent with a shell can drive it.
Claude Code gets the extras (`crew claude`, `crew edit`, the plugin).

## Features

Everything is a command; the TUIs (`crew workspace`, `crew project`, `crew config`, `crew
launch`) sit on top of them. List commands print tab-separated rows; `--json` works anywhere.

| Read state | |
|---|---|
| `crew ls workspaces` · `ls worktrees [--size]` · `ls projects` · `ls bindings` · `ls overrides` | What exists — worktrees is "what do I have checked out" (`--json` carries each worktree's recorded issues), `--size` adds bytes on disk |
| `crew show <ws>/<wt>` · `crew dev status` · `crew dev show <project>` | Paths and roles; running servers with ports and URLs; a project's configured servers |
| `crew env <ws>/<wt> <project>` · `crew ps` · `crew trash` · `crew config show` | Resolved env; crew's processes; what is still clearing from the trash; settings |
| `crew dev check <ws>/<wt>` · `crew dev proxy status` · `crew debug --tail=N` | Which running server died or never listened; the proxy; crew's own log |

| Projects and dev servers | |
|---|---|
| `crew add project <name> <path> [--setup=<cmd>]` | Register a repo; re-run with `--setup` or `--path` to change one |
| `crew dev add <project> --name --port --cmd [--dir]` · `dev rm` · `dev setup [--apply --port]` | Named dev servers; the port is reference only, crew allocates real ones; `setup` detects a `package.json` script |

| Bindings | |
|---|---|
| `crew add binding <project> --var=X --url=proj \| --host=proj \| --port=proj \| --value=…` | Declare which env vars crew computes: `{{proj}}`, `{{proj.host}}`, `{{proj.port}}`, `{{proj/server}}`, `{{worktree}}`, `{{workspace}}` |
| `crew add binding <project> --scan [--apply]` | Propose bindings from the project's own `.env` |
| `crew add override <ws>/<wt> VAR=value` · `rm override` | Pin a variable for one worktree |
| `crew run <ws>/<wt> <project> -- <cmd>` | Run anything with the same env the dev servers got |

| Workspaces and worktrees | |
|---|---|
| `crew add workspace <name> [<project>[:<role>] …] [--direct]` · `rm workspace <ws> <project>` · `rm <ws>` | Membership — any number of projects in one call, installs in parallel |
| `crew add worktree <ws>/<name> [--pull] [--no-install] [--no-smoke]` · `duplicate` · `setup` | A working copy: base-branch table, checkouts, `.env`, installs, smoke start |
| `crew verify <ws>/<wt>` · `crew fix <ws>/<wt> [--print]` | What failed is recorded on the worktree; `verify` finishes and re-checks, `fix` opens Claude with the evidence — or prints it for the agent already there |
| `crew rm worktree <ws>/<name>` | Returns at once; the checkout is cleared in the background (`crew trash`) |
| `crew migrate [--dry-run] [--yes]` | Move pre-2.0 workspaces to the nested layout |

| Dev servers | |
|---|---|
| `crew dev start\|stop\|restart <ws>/<wt> [--proxy]` · `dev logs <server> [-f \| --lines=N]` | Stable per-worktree ports, bindings exported, anomalies printed; `--proxy` adds LAN hostnames |
| `crew dev check <ws>/<wt>` · `crew dev proxy status\|stop` | A few seconds after a start: died / not listening per server; the shared proxy |

| Launching | |
|---|---|
| `crew claude <ws>/<wt>` · `crew edit <ws>/<wt>` · `crew open <ws>/<wt>` | Claude in the terminal; local editor with the prompt and Claude wired; a shell in the worktree |
| `crew code <ws>/<wt>` · `crew start <ws>/<wt>` · `crew launch <ws>/<wt>` | Remote-SSH URL; the orientation prompt; the worktree page (TUI) |

| Another machine, housekeeping | |
|---|---|
| `crew export [file] [--all \| --projects=… [--workspaces=…]]` · `crew import <file> [--plan \| project <name> … \| workspace <name> \| --all [--clone] [--replace]]` | Projects (with origin remotes) and workspace membership in one file; a card-by-card wizard on the other side, or the same decisions as flags |
| `crew trash [empty]` · `crew kill` · `crew config set\|refresh` · `crew update` · `crew uninstall [--purge] [--yes]` | Finish clearing removed checkouts; reclaim leaked processes; settings; updates; removal |

`crew help <command>` is the reference for every flag; `crew help --json` dumps the tree.

## Install

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/FurlanLuka/crew/main/install.sh | sh

# Or build from source
go install github.com/FurlanLuka/crew/crew@latest
```

Linux installs pull in `tmux` and `git` if missing. For `crew claude`, Claude Code itself:
`curl -fsSL https://claude.ai/install.sh | bash`.

## Quick start

```bash
crew add project store-api ~/Documents/store-api          # register repos
crew add project store-app ~/Documents/store-app
crew dev add store-api --name=store-api --port=3000 --cmd="npm start"
crew add binding store-app --scan --apply                 # bindings from its .env
crew add workspace store-front store-api:"Backend API" store-app:"Web app"
crew dev start store-front/main                           # servers on stable ports
sleep 6; crew dev check store-front/main                  # did they come up?
crew claude store-front/main                              # Claude in the worktree
crew add worktree store-front/wrk2 --pull                 # a second working copy
crew export ~/Desktop/crew.json --all                     # take it to another machine
```

Or drive it from the TUI: `crew project`, `crew workspace`, `crew launch <ws>/<wt>`.

## Agents

Any agent that can run a shell can drive crew: tab-separated rows or `--json` on every
command, `crew help <cmd>` and `crew help --json` as the reference, nothing that needs a tty
except the TUIs and the two process-replacing commands. `skills/crew/SKILL.md` is the
agent-facing reference — every command, output columns, the flows — and is plain Markdown
any agent can be pointed at.

### Claude Code plugin

The `crew` skill and agent ship in this repo, so Claude Code can drive crew for you:

```
/plugin marketplace add FurlanLuka/crew
/plugin install crew@crew
```

The plugin drives the `crew` binary — install that first (the `install.sh` line above); the
plugin does not ship it. What you get:

- **Skill `crew`** — the whole CLI as an agent reads it: every command, output columns, the
  flows. Loads when crew, a workspace, a worktree or dev servers come up; `/crew:crew` loads
  it by hand.
- **Agent `crew`** — runs the commands and reads what they print. Plain-language asks route
  here: *"what do I have running?"*, *"start store-front/wrk2 with the proxy"*, *"why is
  store-api talking to the wrong checkout-api?"*, *"set this up on my other Mac"*.
- **`/crew:setup [name]`** — guided workspace setup: which repos, roles, dev servers,
  bindings, then builds it and checks the servers come up.
- **`/crew:import [file]`** — guided import of a crew export: asks where the file is, walks
  the plan and decides each project (path, clone, replace) with you.
- **`/crew:status [ref]`** — worktrees, running servers, recorded issues, readable.
- **`/crew:proxy [ref]`** — a `--proxy` URL opens here but not on the phone: walks the
  other-device test from `crew help dev start`.

Commands that take over the terminal — the TUIs, `crew claude`, `crew open` — are handed to
you as the exact line to run. Everything else has a non-interactive form:

- `crew import <file> --plan`, then `project <name> [--path=… | --clone[=…]] [--replace]` and
  `workspace <name>` — the wizard's decisions as flags.
- `crew fix <ref> --print` — the fix prompt to stdout; bare `fix` does the same without a tty.
- `crew dev setup <project> --apply --port=3000`, `crew migrate --yes`, `crew uninstall --yes`.
- `crew dev logs <ref> <server> --lines=50`, `crew debug --tail=50 --json` — print and return.

### An agent inside a worktree

Every launch — `crew claude`, `crew edit`, the worktree page — opens Claude with the
orientation prompt: the projects, their roles, worktree/direct framing, and a `## crew` section
telling that session it is inside crew worktree `<ws>/<wt>` and to drive the servers through
`crew dev …`, read logs with `crew dev logs … --lines`, run tests through `crew run`, and
reach for `crew fix <ref> --print` when something is recorded. `CREW_REF` is set in that
session's environment. `crew start <ref>` prints the same prompt for any other agent — pipe
it into whatever you run in the worktree, and export `CREW_REF=<ws>/<wt>` yourself.

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
  store-front/
    wrk1/
      store-api/        ← branch crew/store-front/wrk1/store-api
      checkout-api/
    wrk2/
      store-api/        ← branch crew/store-front/wrk2/store-api
      checkout-api/
```

`crew add workspace <ws> <p1>[:<role>] <p2> …` adds any number of projects in one call: every
name is checked first, then each existing worktree gets its checkouts, then every install runs
at once. A checkout or install that fails keeps the member and is recorded on that worktree
for `crew fix` / `crew verify`.

### Dev servers and ports

Each project can have named dev servers. `crew dev start store-front/wrk2`:

1. Allocates a free port per server — and remembers it, so the worktree keeps its ports across
   restarts. The configured `--port` is reference only.
2. Resolves every project's bindings against those ports and exports them into the server's
   environment (see below).
3. Runs each server in a tmux window with `PORT` set. URLs are `http://localhost:<port>`.
4. Prints anything it could not resolve, and any env value pointing at a port that belongs to
   something else — the wrong-service bug caught at start instead of at runtime.

`crew dev start` returns as soon as the panes are up. A few seconds later, `crew dev check
<ref>` says what became of each server: `running`, `died` (with the last log lines), or `not
listening` — nothing accepts on its port. Not listening is a failure when some binding points
at that server (crew handed out a dead URL) and only a note when nothing does (a queue worker
registered with a port). The worktree page runs the same check after a start and marks the
rows; `f fix with Claude` is offered on a failure without locking the page.

### What a project needs

crew stays out of the code. Two things make a project fit:

1. **The dev server binds `$PORT`.** crew allocates a port per server per worktree and runs the
   command with `PORT=<n>` in its environment (`crew dev add … --cmd="npm run dev"`; the
   `--port` you configure is a reference for `--scan` and conflict checks, not what runs).
   `next dev -p $PORT`, `uvicorn app:app --port $PORT`, `process.env.PORT` — whatever the
   stack's spelling is. A server that ignores it collides with its sibling worktrees and
   shows as `not listening` in `crew dev check`.
2. **Sibling URLs come from env vars.** `API_URL`, `WS_URL`, `DATABASE_URL` — read at start,
   never hard-coded. Those are the variables bindings fill (`crew add binding … --scan`
   finds them from the project's `.env`). Values crew resolves are exported ahead of `PORT`
   in the server's environment; anything else in `.env` is left as the project loads it.

Optional: a `setup` command (`crew add project … --setup="make sync"`) when the lockfile alone
does not install the checkout, and a `dev`/`start` script in `package.json` so `crew dev
setup` can propose the server.

### Bindings

**The problem.** Projects reach each other over `localhost`, and crew allocates the ports, so
no static value in a `.env` can be right — `API_URL=http://localhost:3000` is right in one
worktree and wrong in the next. A binding says *which* variable crew computes and *how*.

**The model.** A binding lives on the project that needs the value: `{var, template}`. The
template is text with tokens:

| Token | Becomes | Use |
|---|---|---|
| `{{store-api}}` | `http://localhost:<port>` | the project's one server, as a URL |
| `{{store-api.host}}` | `localhost:<port>` | for `ws://`, `https://`, or a path: `ws://{{signals.host}}/rtc` |
| `{{store-api.port}}` | `<port>` | just the number |
| `{{checkout-api/worker}}` | a named server | when the project has several; `.host` / `.port` after it |
| `{{worktree}}`, `{{workspace}}` | the names | `agent-{{worktree}}`, `db_{{workspace}}_{{worktree}}` |

A value without tokens is used as-is. A template that only partly resolves is left alone
whole — never a half-expanded URL. Names are `a-z 0-9 -`; `worktree`, `workspace`, `url`,
`host` and `port` are token words and cannot name a project.

**Declaring them.**

```bash
crew add binding store-app --var=API_URL --url=store-api              # {{store-api}}
crew add binding store-app --var=RTC_URL --value='ws://{{signals.host}}/rtc'
crew add binding checkout-api --var=WORKER_PORT --port=checkout-api/worker
crew add binding store-app --scan            # read its .env files, propose bindings
crew add binding store-app --scan --apply    # …and add the unambiguous ones
crew ls bindings store-app --check=store-front/wrk2   # what each resolves to there
```

`--scan` reads the project's `.env*` files across every checkout and proposes a binding for
each value that points at a port some project has configured. A port two projects share is
ambiguous — pick that one by hand.

**Precedence** per variable, at `crew dev start`: worktree **override** > **binding** > left
alone. An override (`crew add override <ws>/<wt> VAR=value`) pins a value for one worktree — a
staging URL, a credential — and is also the acknowledgement for a binding that legitimately
never resolves there. Env files are read (for the scan and the conflict check), never written.

**What you see at start.** After the URLs, `crew dev start` prints a resolution count, anything
left alone, then `!` blocks: an env value pointing at a port crew gave to *another* project, or
at a sibling's configured port while that sibling runs elsewhere. Servers still start — crew
warns, never blocks — but this is the one place a wrong URL is visible before it fails at
runtime. `crew env <ws>/<wt> <project>` shows the full table; `crew run <ws>/<wt> <project> --
<cmd>` runs a test or script with exactly that env, so evals see the same URLs the servers got.

### The proxy

With `--proxy`, a shared reverse proxy on port 80 also serves every server as
`http://<server>--<workspace>--<worktree>.<domain>` for other devices on the LAN, with
`<domain>` defaulting to `<lan-ip>.nip.io`. `crew dev proxy status` says whether crew's proxy
is up and answering on its port (another program holding the port shows as `up (not
listening)`); `crew dev proxy stop` stops it alone. A URL that opens here but not on a phone
is almost always DNS refusing `nip.io` or a network the phone is not on — `crew help dev
start` has the two-minute test. A changed `server_ip`, `domain` or `proxy_port` relaunches the
proxy on the next `--proxy` start.

### Launching

Enter a worktree (`crew launch store-front/wrk1`, or from `crew workspace`) for one page:
servers with live status (`●`, `✗ died`, `! not listening`), **Editor + Claude** (Cursor/VS
Code with the orientation prompt and Claude wired up), **Claude in terminal** (`--add-dir` per
project, permissions skipped), and open actions.

### Health

Creating a worktree runs every step it can — every checkout and `.env`, every install, then
the servers for six seconds to see which survive and bind their ports — and records every
failure on the worktree with its stage (`checkout`, `install`, `smoke`) and, for a server,
whether it `died` or was `not listening`. Creation ends on the worktree page, **locked** to
`f fix with Claude` and `v verify` while anything is recorded (logs and a shell stay open).
`crew fix` opens Claude in the worktree with each issue, its evidence and the env anomalies in
the prompt — `--print` (or no terminal) writes that prompt to stdout instead, for the agent
that is already there; with servers running it adds what `dev check` finds. `crew verify`
finishes what is missing, re-checks, and unlocks the page on a pass. Only a check clears it —
a plain `dev start` never does; from the CLI it just prints the issues first. Removing a
project from a workspace removes what was recorded about it.

### Moving to another machine

`crew export` writes projects (pool entries + origin remote) and workspace membership to one
file — never worktrees, ports or overrides. `crew import <file>` on the other side is a wizard;
`--plan` shows every item's status (`exists`, `path exists`, `suggested` — a sibling found
beside a repo crew knows, `clone`, `missing`), `project <name> [--path=…] [--clone[=…]]
[--replace] [--name=…]` and `workspace <name>` apply one item each, `--all [--clone]
[--replace]` does the whole bundle. A found sibling beats cloning; `--all` never guesses.

### Removal and disk

`crew rm worktree` moves the checkout into `~/.crew/trash` and returns at once; a background
delete clears it, and every crew run retries what was left. `crew trash` shows what is still
clearing, `crew trash empty` finishes it now. `crew ls worktrees --size` shows where the
space went — build output inside a checkout is what grows.

### Settings

Configured via `crew config` (TUI), `crew config set`, or `~/.crew/config.json`:

| Setting | Description | Default |
|---------|-------------|---------|
| `server_ip` | LAN IP for `--proxy` URLs (`ipconfig getifaddr en0`, or `tailscale ip -4`) | auto-detected |
| `domain` | Custom domain for proxy URLs; needs wildcard DNS to `server_ip` | `<server_ip>.nip.io` |
| `ssh_host` | SSH host alias for remote editor | — |
| `proxy_port` | Reverse proxy listen port | 80 |

`crew config refresh` rewrites the tmux config crew manages. `crew debug --tail=N` prints the
end of `~/.crew/debug.log` — every git, tmux, install and editor command crew ran; binding
values are never logged.
