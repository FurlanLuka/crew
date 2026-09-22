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
crew add project store-app git@github.com:example/store-app.git   # clone into ~/.crew/projects…
crew add project store-api --path=~/code/store-api        # …or adopt a checkout you already have
crew dev add store-api --name=store-api --port=3000 --cmd="npm run dev"
crew dev add store-app --name=store-app --port=3001 --cmd="npm run dev"
crew add binding store-app --scan --apply                 # which env vars point at siblings
crew check project store-app --wait                       # a fresh checkout: install, env, servers up?

crew add workspace store-front store-api:"Backend API" store-app:"Web app"
crew setup status store-front/main --wait                 # one runner per project: checkout, install, smoke
crew dev start store-front/main                           # servers up on stable ports
crew dev check store-front/main --wait                    # did they come up?
crew claude store-front/main                              # Claude, oriented, in the worktree

crew add worktree store-front/wrk2 --pull                 # a second copy of everything
```

Or from the TUI: `crew project` (`a` walks a new project through source → install → servers →
bindings → check, explaining each step in place), `crew workspace`, `crew launch <ws>/<wt>`.

## Why

- **Two features at once, no juggling.** Each worktree has its own branches, ports and `.env`.
  Start both; nothing collides.
- **Services find each other.** `API_URL=http://localhost:3000` is right in one copy and wrong in
  the next. Bindings make it `{{store-api}}` and crew fills in the port each copy got.
- **You know when it didn't work — early.** Creating a worktree runs one runner per project
  in the background: checkout, install, start its servers to see if they bind their port.
  A failure is recorded with its evidence the moment it happens, while the other installs
  still run; `crew setup status` shows the table, `crew fix` hands it to Claude, `crew
  verify <project>` re-checks just that one.
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
names checked first, then one runner per project. `crew add worktree <ws>/<name>` makes
another copy of all of them; `--pull` fast-forwards the base branches first.

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
then `uv sync` / `pnpm install` / `npm ci` / `yarn` are detected on their own), and
`--env-cmd="make get-env"` when the checkout's env files come from sops or a vault — it runs
in the checkout after the install, over the `.env*` and `.local*.env` files crew copied in. It must write files, not print values: its output is logged with the
install's.

### Bindings

A binding lives on the project that needs the value: *this variable, computed like this*.
A value with no template in it is a literal — the project-wide default for every worktree,
which a worktree override (`crew add override`) still beats. Secrets never go in bindings;
they are exported.

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

A monorepo is one project with several dev servers, and its web app rarely wants the same
siblings as its worker: bind for one server with `crew add binding mono/web --var=API_URL
--url=store-api`. A binding on the bare project reaches every server; one on `mono/web`
only that window, and wins there over the project-wide one on the same var. `crew env
<ws>/<wt> mono/web` shows what that server gets; `crew add binding mono/web --scan` reads
the env files under the server's `--dir`.

At `crew dev start`, per variable: a worktree **override** wins, then the **binding**, else the
variable is left as the project loads it. A template that only partly resolves is left alone
whole. Env files are read, never written. After the URLs, start prints what was left alone and
`!` blocks for anything pointing at a port that belongs to someone else — crew warns, never
blocks, but this is where a wrong URL shows up before it fails at runtime.

`crew env <ws>/<wt> <project>` shows the resolved table (the project-wide set on stdout; a
var bound for one server only is named there and shown by `<project>/<server>`); `crew run
<ws>/<wt> <project>[/<server>] -- make eval` runs anything with exactly that env.

### Checking the servers

`crew dev start` returns as soon as the panes are up. `crew dev check <ref> --wait` watches
each server until it listens on its port, dies, or a minute passes, and says what became of
it: `running` (with how long it took), `died` (last log lines attached), or `not listening`.
Not listening is a failure when some binding points at that server (crew handed out a dead
URL) and only a note when nothing does (a queue worker registered with a port). The worktree
page does the same after a start — rows read `starting…` until each has its verdict.

### Proving a project

`crew check project <name>` is the same pipeline a worktree gets — checkout, mise, install,
env command, a smoke of the project's servers — on a fresh checkout of the canonical repo,
before the project joins any workspace. A pass removes the checkout and leaves the ✓ table
under `crew setup status check/<name>`. A failure keeps it as `check/<name>`: `crew ls
worktrees` lists it, `crew fix check/<name> --print` has the evidence, `crew verify
check/<name>` re-runs it in place, `crew check project <name>` again replaces it from
nothing, `crew rm worktree check/<name>` removes it.

### Making a worktree

`crew add worktree` returns at once. It records the worktree, reserves its ports, and starts
one **runner per project** — a window of tmux session `crew-setup-<ws>--<wt>` — each doing
checkout (with the repo's git hooks off — a hook written for your checkout does not get to
fail crew's) → `.env` → install → a smoke of that project's own servers, with the same
patience as `dev check --wait`. Wall clock is the slowest project, not the sum.

```
$ crew setup status store-front/wrk2
  ✓ store-api     checkout 1s · npm ci 11s · smoke store-api 2s
  ✗ store-app     checkout 1s · pnpm install — exit 1
  ▸ checkout-api  checkout 1s · ▸ uv sync
```

Every runner writes its verdict the moment it has one, so `store-app`'s failure is on the
worktree — and in `crew fix --print` — while `checkout-api` still installs. `crew setup
status` exits 2 while anything runs, 1 once stopped with a failure, 0 otherwise; `--wait`
stays to the end. `crew setup logs <ref> <project>` is what an install is printing. In a
terminal, creation lands on the worktree page, which shows the same table live. A runner that
vanishes (a killed window, a reboot) is recorded as interrupted, never as verified.

Each server is smoked on its own: siblings' URLs resolve (ports were reserved first) but
nothing answers on them, so a server that exits when its upstream is unreachable reads `died`
with the connection error in its evidence.

### When something fails

Creation never stops halfway: each failure is recorded on the worktree with its stage and
evidence (an install's last thirty lines, a dead server's log tail, `not listening` on a
port). `crew ls worktrees` shows it; the worktree page stays locked to `f fix with Claude`
and `v verify` while anything is recorded or still installing.

- `crew fix <ref>` opens Claude in the worktree with every issue, its evidence and the env
  anomalies in the prompt. `--print` (or no terminal) writes that prompt to stdout instead —
  for the agent that is already there. With servers running it adds what `dev check` finds.
- `crew verify <ref> [<project>…]` finishes what is missing, re-runs failed installs,
  smoke-starts, and clears the record on a pass — per project, so `crew verify <ref>
  store-app` re-checks the one you fixed and leaves the rest alone. Nothing else clears it.
- While runners are alive, `dev start`, `verify`, `setup` and `duplicate` of that worktree
  refuse — a dev server on top of an install writing the same checkout is corruption, not a
  warning. It is the one refusal besides a verify under running servers.

### Other devices

`crew dev start <ref> --proxy` also serves every server at
`http://<server>--<ws>--<wt>.<lan-ip>.nip.io` through one reverse proxy on `:80`. A URL that
opens here but not on a phone is almost always DNS refusing `nip.io` or a different network —
`crew help dev start` has the two-minute test; `crew dev proxy status` says whether the proxy
is actually answering. Tailscale users: `crew config set server_ip $(tailscale ip -4)`.

### Another machine

A project is its git remote; the path is where crew keeps the clone. `crew export --all`
writes the projects by remote (with servers, bindings, setup, env command — no paths) and
the workspace memberships to one file — never worktrees, ports or overrides. `crew import
<file>` on the other side clones every project it does not have into `~/.crew/projects`:
a wizard (`y` clone, `p` adopt a checkout you already have, `r` replace), or `--plan` then
`project <name> [--path | --replace]` and `workspace <name> [--pull] [--wait]` for an
agent, or `--all`. A repo you already have on disk gets a second clone unless you point
at it; a checkout with no remote exports as config only. A workspace import makes its `main`
worktree exactly the way `crew add worktree` does — base table, `--pull`, one runner per
project, failures recorded — so what you get on the second machine is as current and as
checked as on the first.

### Removal

`crew rm worktree` returns at once: the checkout moves to `~/.crew/trash` and a background
delete clears it (a full build can be 100 GB). `crew trash` shows what is still clearing.
`crew rm project <name> --purge` also trashes a clone crew made from a URL — refused while a
workspace still lists the project.

Every crew command sweeps leftovers at most once an hour — failed checks older than a week,
runner files, dev logs and route files of worktrees that no longer exist, stale locks, the
trash. `crew clean [--dry-run]` runs it now and adds `git worktree prune` on every repo.

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
| **Projects** | `add project <name> <url> \| --path=<dir> [--setup=…] [--env-cmd=…]` · `rm project [--purge]` · `check project <name> [--pull] [--no-smoke] [--wait]` · `dev add <p> --name --port --cmd [--dir]` · `dev rm` · `dev setup <p> [--apply --port=…]` |
| **Bindings** | `add binding <p>[/<server>] --var=X --url\|--host\|--port=<proj[/server]> \| --value=…` · `add binding <p>[/<server>] --scan [--apply]` · `rm binding <p>[/<server>] X` · `add\|rm override <ref> VAR=value` · `env <ref> <p>[/<server>]` · `run <ref> <p>[/<server>] -- <cmd>` |
| **Workspaces** | `add workspace <ws> [<p>[:<role>] …] [--direct] [--wait]` · `rm workspace <ws> <p>` · `rm <ws>` · `add worktree <ws>/<name> [--pull] [--no-install] [--no-smoke] [--wait]` · `duplicate <ref> <name>` · `rm worktree` · `setup <ref> [<p>…] [--wait]` · `setup status <ref> [--wait]` · `setup logs <ref> <p>` · `verify <ref> [<p>…] [--wait]` · `fix <ref> [--print]` · `migrate [--dry-run] [--yes]` |
| **Servers** | `dev start\|stop\|restart <ref> [--proxy]` · `dev check <ref> [--wait]` · `dev logs <ref> <server> [-f \| --lines=N]` · `dev proxy status\|stop` |
| **Launch** | `claude <ref>` · `edit <ref> [--editor=cursor\|code]` · `open <ref>` · `code <ref>` · `start <ref>` · `launch [<ref>]` |
| **Elsewhere** | `export [file] [--all \| --projects=… [--workspaces=…]]` · `import <file> [--plan \| project <name> [--path \| --replace] \| workspace <name> [--pull] [--wait] \| --all [--replace] [--pull] [--wait]]` |
| **Housekeeping** | `clean [--dry-run]` · `trash [empty]` · `kill [--dry-run]` · `config set <key> <value>` · `config refresh` · `update` · `uninstall [--purge] [--yes]` |

Settings (`crew config set`): `server_ip` (LAN IP for proxy URLs, auto-detected), `domain`
(custom proxy domain, needs wildcard DNS; default `<server_ip>.nip.io`), `proxy_port` (80),
`ssh_host` (for `crew code`). `~/.crew/debug.log` holds every git, tmux, install and editor
command crew ran; binding values are never logged.
