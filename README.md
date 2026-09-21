# crew

Run several copies of your stack side by side, each on its own branches, its own ports, and
the right URLs between its services — and drop an agent into any of them.

crew is a CLI (with a TUI on top) for coding agents. A **workspace** groups the repos a
feature touches; a **worktree** is one working copy of all of them — a git worktree per repo,
dev servers on stable ports, and env vars that point the services at *each other* instead of
at whatever happens to run on `:3000`. Every action is a command with `--json`, so any agent
with a shell can drive it; Claude Code gets the extras.

```
~/.crew/workspaces/store-front/
  wrk1/  store-api  store-app  checkout-api     ← branches crew/store-front/wrk1/*, ports 54494…
  wrk2/  store-api  store-app  checkout-api     ← branches crew/store-front/wrk2/*, ports 54501…
```

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/FurlanLuka/crew/main/install.sh | sh
# or: go install github.com/FurlanLuka/crew/crew@latest
```

Linux installs pull in `tmux` and `git` if missing. `crew update` pulls the latest release.

## Quick start

```bash
crew add project store-api ~/code/store-api               # register the repos
crew add project store-app ~/code/store-app
crew dev add store-api --name=store-api --port=3000 --cmd="npm run dev"
crew dev add store-app --name=store-app --port=3001 --cmd="npm run dev"
crew add binding store-app --scan --apply                 # which env vars point at siblings

crew add workspace store-front store-api:"Backend API" store-app:"Web app"
crew dev start store-front/main                           # servers up on stable ports
crew dev check store-front/main --wait                    # did they come up?
crew claude store-front/main                              # Claude, oriented, in the worktree

crew add worktree store-front/wrk2 --pull                 # a second copy of everything
```

Or from the TUI: `crew project`, `crew workspace`, `crew launch <ws>/<wt>`.

## Why

- **Two features at once, no juggling.** Each worktree has its own branches, ports and `.env`.
  Start both; nothing collides.
- **Services find each other.** `API_URL=http://localhost:3000` is right in one copy and wrong in
  the next. Bindings make it `{{store-api}}` and crew fills in the port each copy got.
- **You know when it didn't work.** Creating a worktree checks everything out, installs, and
  starts the servers to see which survive and bind their port. What failed is recorded with
  its evidence; `crew fix` hands it to Claude, `crew verify` re-checks.
- **Agents drive it.** Tab-separated rows or `--json` everywhere, nothing that needs a
  terminal except the TUIs, and an orientation prompt that tells the agent inside a worktree
  what it is standing in and how to run the servers.

## How it works

### Projects, workspaces, worktrees

A **project** is a repo in a global pool with its dev servers, bindings and an optional setup
command. A **workspace** is membership — which projects, with which roles. A **worktree** is
one working copy: for each project a git worktree on branch `crew/<ws>/<wt>/<project>`, a
copied `.env`, an install, and reserved ports.

`crew add workspace <ws> <p1>[:<role>] <p2> …` adds any number of projects in one call —
names checked first, checkouts, then every install at once. `crew add worktree <ws>/<name>`
makes another copy of all of them; `--pull` fast-forwards the base branches first.

### What a project needs

crew stays out of your code. Two things:

1. **The dev server binds `$PORT`.** crew allocates a port per server per worktree and runs
   the command with `PORT=<n>` set — `next dev -p $PORT`, `uvicorn --port $PORT`,
   `process.env.PORT`. The `--port` you configure is a reference for scans and conflict
   checks, not what runs. A server that ignores `$PORT` collides with its siblings and shows
   as `not listening`.
2. **Sibling URLs come from env vars**, read at start, never hard-coded. Those are what
   bindings fill.

Optional: `--setup="make sync"` when the lockfile alone does not install the checkout (mise,
then `uv sync` / `pnpm install` / `npm ci` / `yarn` are detected on their own).

### Bindings

A binding lives on the project that needs the value: *this variable, computed like this*.

| Template | Becomes |
|---|---|
| `{{store-api}}` | `http://localhost:<port>` — the project's one server |
| `{{store-api.host}}` · `{{store-api.port}}` | `localhost:<port>` · `<port>` — for `ws://…/rtc`, or just the number |
| `{{checkout-api/worker}}` | a named server, when a project has several |
| `{{worktree}}` · `{{workspace}}` | the names — `agent-{{worktree}}` |

```bash
crew add binding store-app --var=API_URL --url=store-api
crew add binding store-app --var=RTC_URL --value='ws://{{signals.host}}/rtc'
crew add binding store-app --scan --apply        # propose from its .env, add the clear ones
crew ls bindings store-app --check=store-front/wrk2
```

At `crew dev start`, per variable: a worktree **override** wins, then the **binding**, else the
variable is left as the project loads it. A template that only partly resolves is left alone
whole. Env files are read, never written. After the URLs, start prints what was left alone and
`!` blocks for anything pointing at a port that belongs to someone else — crew warns, never
blocks, but this is where a wrong URL shows up before it fails at runtime.

`crew env <ws>/<wt> <project>` shows the resolved table; `crew run <ws>/<wt> <project> -- make
eval` runs anything with exactly that env.

### Checking the servers

`crew dev start` returns as soon as the panes are up. `crew dev check <ref> --wait` watches
each server until it listens on its port, dies, or a minute passes, and says what became of
it: `running` (with how long it took), `died` (last log lines attached), or `not listening`.
Not listening is a failure when some binding points at that server (crew handed out a dead
URL) and only a note when nothing does (a queue worker registered with a port). The worktree
page does the same after a start — rows read `starting…` until each has its verdict.

### When something fails

Creating a worktree never stops halfway: every checkout (with the repo's git hooks off — a
hook written for your checkout does not get to fail crew's), every install, then the smoke
start with the same patience as `dev check --wait` — each failure recorded on the worktree
with its stage and evidence (an install's last thirty lines, a dead server's log tail, `not
listening` on a port). `crew ls worktrees` shows it; the
worktree page opens locked to `f fix with Claude` and `v verify`.

- `crew fix <ref>` opens Claude in the worktree with every issue, its evidence and the env
  anomalies in the prompt. `--print` (or no terminal) writes that prompt to stdout instead —
  for the agent that is already there. With servers running it adds what `dev check` finds.
- `crew verify <ref>` finishes what is missing, re-runs failed installs, smoke-starts, and
  clears the record on a pass. Nothing else clears it.

### Other devices

`crew dev start <ref> --proxy` also serves every server at
`http://<server>--<ws>--<wt>.<lan-ip>.nip.io` through one reverse proxy on `:80`. A URL that
opens here but not on a phone is almost always DNS refusing `nip.io` or a different network —
`crew help dev start` has the two-minute test; `crew dev proxy status` says whether the proxy
is actually answering. Tailscale users: `crew config set server_ip $(tailscale ip -4)`.

### Another machine

`crew export --all` writes the projects (with their origin remotes) and the workspace
memberships to one file — never worktrees, ports or overrides. `crew import <file>` on the
other side is a wizard, or `--plan` then `project <name> [--path | --clone | --replace]` and
`workspace <name> [--pull]` for an agent. A workspace import makes its `main` worktree
exactly the way `crew add worktree` does — base table, `--pull`, installs, smoke, failures
recorded — so what you get on the second machine is as current and as checked as on the first.

### Removal

`crew rm worktree` returns at once: the checkout moves to `~/.crew/trash` and a background
delete clears it (a full build can be 100 GB). `crew trash` shows what is still clearing.

## Agents

Any agent with a shell can drive crew. [`skills/crew/SKILL.md`](skills/crew/SKILL.md) is the
reference written for one — every command, its output columns, the flows — and `crew help
<command>` is authoritative. Nothing needs a terminal except the TUIs and two commands that
replace the process (`crew claude`, `crew open`); those print the data alternative when asked
without one.

**Inside a worktree.** Every launch (`crew claude`, `crew edit`, the page) opens Claude with an
orientation prompt: the projects and roles, worktree/direct framing, and a `## crew` section —
you are in `<ws>/<wt>`, drive the servers with `crew dev …`, read logs with `--lines`, run
tests through `crew run`, `crew fix <ref> --print` when something is recorded. `CREW_REF` is
in the environment. `crew start <ref>` prints the same prompt for any other agent.

### Claude Code plugin

```
/plugin marketplace add FurlanLuka/crew
/plugin install crew@crew
```

Needs the `crew` binary installed (above). Ships the reference skill, a `crew` agent that
plain-language asks route to (*"what's running?"*, *"start store-front/wrk2 with the
proxy"*), and four guided skills that trigger on their own or as `/crew:<name>`:

| | |
|---|---|
| `setup` | which repos, roles, dev servers, bindings — builds the workspace and checks it |
| `import` | where the export is, then each project's decision (path, clone, replace) with you |
| `status` | worktrees, running servers with their check verdict, recorded issues |
| `proxy` | a `--proxy` URL that opens here but not on the phone |

## Commands

Every list prints tab-separated rows; `--json` anywhere. `crew help <cmd>` for flags.

| | |
|---|---|
| **See** | `ls workspaces` · `ls worktrees [--size]` · `ls projects` · `ls bindings <p> [--check=<ref>]` · `ls overrides <ref>` · `show <ref>` · `env <ref> <p>` · `dev status` · `dev show <p>` · `dev check <ref>` · `ps` · `trash` · `config show` · `debug --tail=N` |
| **Projects** | `add project <name> <path> [--setup=…]` · `rm project` · `dev add <p> --name --port --cmd [--dir]` · `dev rm` · `dev setup <p> [--apply --port=…]` |
| **Bindings** | `add binding <p> --var=X --url\|--host\|--port=<proj[/server]> \| --value=…` · `add binding <p> --scan [--apply]` · `rm binding` · `add\|rm override <ref> VAR=value` · `run <ref> <p> -- <cmd>` |
| **Workspaces** | `add workspace <ws> [<p>[:<role>] …] [--direct]` · `rm workspace <ws> <p>` · `rm <ws>` · `add worktree <ws>/<name> [--pull] [--no-install] [--no-smoke]` · `duplicate <ref> <name>` · `rm worktree` · `setup <ref>` · `verify <ref>` · `fix <ref> [--print]` · `migrate [--dry-run] [--yes]` |
| **Servers** | `dev start\|stop\|restart <ref> [--proxy]` · `dev check <ref> [--wait]` · `dev logs <ref> <server> [-f \| --lines=N]` · `dev proxy status\|stop` |
| **Launch** | `claude <ref>` · `edit <ref> [--editor=cursor\|code]` · `open <ref>` · `code <ref>` · `start <ref>` · `launch [<ref>]` |
| **Elsewhere** | `export [file] [--all \| --projects=… [--workspaces=…]]` · `import <file> [--plan \| project <name> … \| workspace <name> [--pull] \| --all [--clone] [--replace] [--pull]]` |
| **Housekeeping** | `trash [empty]` · `kill [--dry-run]` · `config set <key> <value>` · `config refresh` · `update` · `uninstall [--purge] [--yes]` |

Settings (`crew config set`): `server_ip` (LAN IP for proxy URLs, auto-detected), `domain`
(custom proxy domain, needs wildcard DNS; default `<server_ip>.nip.io`), `proxy_port` (80),
`ssh_host` (for `crew code`). `~/.crew/debug.log` holds every git, tmux, install and editor
command crew ran; binding values are never logged.
