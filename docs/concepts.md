# How crew works

The model behind every command: what a project, a workspace and a worktree are, how services
find each other, how crew proves a copy works, and what happens when it doesn't. For the
commands themselves see [commands.md](commands.md); to get going see
[Getting set up](guides/getting-set-up.md).

## Projects, workspaces, worktrees

A **project** is a repo in a global pool — its git remote is its identity, the path is crew's
clone — with its dev servers, bindings and optional setup and env commands. A **workspace** is membership — which projects, each as a worktree or direct. A **worktree** is
one working copy: for each project a git worktree on branch `crew/<ws>/<wt>/<project>`, a
copied `.env`, an install, and reserved ports.

`crew add workspace <ws> <p1> <p2> …` adds any number of projects in one call —
names checked first, then one runner per project. `crew add worktree <ws>/<name>` makes
another copy of all of them; `--pull` fast-forwards the base branches first.

## What a project needs

crew stays out of your code. Two things:

1. **The dev server binds `$PORT`.** crew allocates a port per server per worktree and runs
   the command with `PORT=<n>` set — `next dev -p $PORT`, `uvicorn --port $PORT`,
   `process.env.PORT`. A server added without `--port` is a process that does not listen — a
   worker — and runs with no `PORT` and no URL. The `--port` you configure is a reference for scans and conflict
   checks, not what runs. A server that ignores `$PORT` collides with its siblings and shows
   as `not listening`.
2. **Sibling URLs come from env vars**, read at start, never hard-coded. Those are what
   bindings fill.

Optional: `--setup="make sync"` when the lockfile alone does not install the checkout (mise,
then `uv sync` / `pnpm install` / `npm ci` / `yarn` are detected on their own), and
`--env-cmd="make get-env"` when the checkout's env files come from sops or a vault — it runs
in the checkout after the install, over the `.env*` and `.local*.env` files crew copied in. It must write files, not print values: its output is logged with the
install's.

## Bindings

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

## Checking the servers

`crew dev start` returns as soon as the panes are up. `crew dev check <ref> --wait` watches
each server until it listens on its port, dies, or a minute passes, and says what became of
it: `running` (with how long it took), `died` (last log lines attached), or `not listening`.
Not listening is a failure when some binding points at that server (crew handed out a dead
URL) and only a note when nothing does (a queue worker registered with a port). The worktree
page does the same after a start — rows read `starting…` until each has its verdict.

## Proving a project

`crew check project <name>` is the same pipeline a worktree gets — checkout, mise, install,
env command, a smoke of the project's servers — on a fresh checkout of the canonical repo,
before the project joins any workspace. A pass removes the checkout and leaves the ✓ table
under `crew setup status check/<name>`. A failure keeps it as `check/<name>`: `crew ls
worktrees` lists it, `crew fix check/<name> --print` has the evidence, `crew verify
check/<name>` re-runs it in place, `crew check project <name>` again replaces it from
nothing, `crew rm worktree check/<name>` removes it.

## Making a worktree

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

## When something fails

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
- While runners are alive, `dev start`, `verify`, `setup`, `duplicate` and `rm workspace
  <ws> <p>` of that worktree refuse — a dev server on top of an install writing the same
  checkout is corruption, not a warning, and a member cannot leave while its runner still
  records on it. It is the one refusal besides a verify under running servers.

## Other devices

`crew dev start <ref> --proxy` also serves every server at
`http://<server>--<ws>--<wt>.<lan-ip>.nip.io` through one reverse proxy on `:80`. A URL that
opens here but not on a phone is almost always DNS refusing `nip.io` or a different network —
`crew help dev start` has the two-minute test; `crew dev proxy status` says whether the proxy
is actually answering. Tailscale users: `crew config set server_ip $(tailscale ip -4)`.

## Another machine

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

## Voice OS

Voice OS (`crew voice`) is a voice and web cockpit on top of crew. It holds one Claude Code
session per worktree, runs them through the Claude Agent SDK on your own Claude Code login, and
puts them in one page you can talk to. [The guide](guides/voice-os.md) is how to use it; this is
the model underneath.

- **Sessions.** A worktree's session runs in that worktree, opened with the same orientation
  prompt `crew claude` gets, and resumes where it left off after a restart. Besides the
  worktrees there is always a **setup** session: it runs in your home directory with the crew
  CLI and is for crew itself — projects, workspaces, worktrees ("setup, make a worktree in
  store-front for the search fix"). Dev servers and code belong to each worktree's own session.
- **Kernel and narrator.** Every spoken sentence goes to the **kernel** (a small, fast model
  with tools), which decides what it is: words for a session, an answer to what a session is
  waiting on, a switch of view, a note. Anything about the work is forwarded in your words,
  never acted on by the kernel itself. Sessions write their own short spoken lines; when a
  reply comes without one, the **narrator** decides what to say and whether the session now
  waits on you. Both run on your Anthropic API key; speech in and out runs on Soniox.
- **Auto mode.** Sessions run in Claude Code's auto permission mode: routine steps go ahead,
  and Claude Code's own safety check blocks what looks risky. A blocked action is shown and
  said with its reason; "allow it" approves exactly that one retried call and then auto mode
  is back. Plans (`ExitPlanMode`) and questions (`AskUserQuestion`) always wait for you.
- **Pins and names.** Pinned is a view of the sessions you pinned, from any machine, in pin
  order; a pinned session opens inside it, with the other pins as its tabs. A name you give a
  session replaces its crew ref everywhere on the page and in what you can say. Both are
  Voice OS preferences, not crew state: they have no crew command, and crew never sees them.
- **Other machines.** Voice OS can drive the sessions of another machine's worktrees — a VM,
  a second computer. That machine is a **remote**: `crew voice remote` there starts a daemon
  that runs only the sessions (no voice, no kernel) and outlives any connection. Your Mac is
  the **main**: `crew voice machines add <ssh host>` (or **+ Add machine** on the page), and it
  connects with `ssh <host> … crew voice _attach`, so the host only needs to be reachable with
  your keys — LAN, VPN or an SSH alias, its choice. Its sessions show under the machine
  (`store-vm:store-front/main`), its dev servers are its own crew's, and a dropped link stops
  nothing there: the main reconnects, catches up from a snapshot and says one line about what
  happened. A machine is a main or a remote, never both. [The
  guide](guides/voice-os.md#other-machines) has the steps.

**Where its state lives.** `~/.crew/voiceos/`: `token` (the page's sign-in, owner-only),
`sessions.json` (which Claude session each worktree resumes), `pinned.json`, `names.json`,
`view.json` (the screen a restart comes back to), `topics.json`, `machines.json` (written by
`crew voice machines`), `notes/<workspace>.md`, `journal/` (every turn, for "what did checkout
do yesterday"), `media/` (images sessions showed, swept after 30 days) and `logs/` (the log and
your debug notes). A remote keeps its own under `~/.crew/voiceos/remote/`. The binary is
`~/.crew/bin/voiceos`, and the API keys are in `~/.config/crew-voiceos/` (owner-only, never in
the environment: an exported `ANTHROPIC_API_KEY` would switch every Claude Code session to
per-token billing).

## Removal

`crew rm worktree` returns at once: the checkout moves to `~/.crew/trash` and a background
delete clears it (a full build can be 100 GB); its `crew/<ws>/<wt>/<project>` branch is
deleted from the repo (commits not on the base stay in the reflog). `crew trash` shows what
is still clearing.
`crew rm project <name>` takes the clone crew made from a URL with it (to the trash;
`--keep-clone` leaves it; a checkout of yours is never moved) — refused while a workspace
still lists the project.

Every crew command sweeps leftovers at most once an hour — failed checks older than a week,
runner files, dev logs and route files of worktrees that no longer exist, stale locks, the
trash. `crew clean [--dry-run]` runs it now and adds `git worktree prune` on every repo.

## Agents

Any agent with a shell can drive crew. [`skills/crew/SKILL.md`](../skills/crew/SKILL.md) is the
reference written for one — every command, its output columns, the flows — and `crew help
<command>` is authoritative. Nothing needs a terminal except the TUIs and two commands that
replace the process (`crew claude`, `crew open`); those print the data alternative when asked
without one.

**Inside a worktree.** Every launch (`crew claude`, `crew edit`, the page) opens Claude with an
orientation prompt: the projects and their paths, worktree/direct framing, and a `## crew` section —
you are in `<ws>/<wt>`, drive the servers with `crew dev …`, read logs with `--lines`, run
tests through `crew run`, `crew fix <ref> --print` when something is recorded. `CREW_REF` is
in the environment. `crew start <ref>` prints the same prompt for any other agent.

## Claude Code plugin

```
/plugin marketplace add FurlanLuka/crew
/plugin install crew@crew
```

Needs the `crew` binary installed (above). Ships the reference skill, a `crew` agent that
plain-language asks route to (*"what's running?"*, *"start store-front/wrk2 with the
proxy"*), and four guided skills that trigger on their own or as `/crew:<name>`:

| | |
|---|---|
| `setup` | which repos, dev servers, bindings — builds the workspace and checks it |
| `import` | where the export is, then each project's decision (path, clone, replace) with you |
| `status` | worktrees, running servers with their check verdict, recorded issues |
| `proxy` | a `--proxy` URL that opens here but not on the phone |

## Settings and the debug log

Settings (`crew config set`): `server_ip` (LAN IP for proxy URLs, auto-detected), `domain`
(custom proxy domain, needs wildcard DNS; default `<server_ip>.nip.io`), `proxy_port` (80),
`proxy_https_port` (443, `-1` off — the proxy's HTTPS, from crew's own CA; `crew dev proxy trust`
shows how to trust it on each device),
`ssh_host` (for `crew code`). `~/.crew/debug.log` holds every git, tmux, install and editor
command crew ran; binding values are never logged. `~/.crew/update-check.json` remembers the
last background check for a newer release (at most once a day; `crew update` always checks
fresh).

Voice OS has no settings of its own in `crew config`: its state is in `~/.crew/voiceos/` and
its API keys in `~/.config/crew-voiceos/` (see [Voice OS](#voice-os)); `crew voice keys` shows
which keys are set, and `crew voice logs` tails its log.
