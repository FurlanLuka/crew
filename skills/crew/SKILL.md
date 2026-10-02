---
name: crew
description: >
  Complete CLI reference for crew — projects, workspaces, worktrees, dev servers on stable
  per-worktree ports, env bindings, launching Claude and editors, crew's server (the web
  page: Set up and Voice OS, its keys, remote machines), moving to another machine, disk
  housekeeping. Use whenever the user mentions crew, a workspace, a worktree, dev servers,
  bindings, Voice OS, crew's page, or wants Claude or an editor opened on a checkout.
user-invocable: true
---

# crew

crew is a plain CLI; this reference is for any agent with a shell. Everything crew does is a
command. List commands print tab-separated rows; `--json` works on
any command, in any position. `crew help <cmd> [<sub>]` is authoritative; `crew help --json`
dumps the whole tree. Never guess state — run the command.

Every action has a non-interactive form. **Configuration lives on crew's page in the
browser**: bare `crew` starts crew's server when needed and opens it — Home, then **Set up**
(projects, workspaces, worktrees, machines, settings, import, a Setup with Claude chat per
machine) or **Voice OS**. Every form on that page runs one of the commands below and shows
it, so anything the user did there you can do here. The terminal keeps one interactive view,
for launching: `crew launch` / `crew <ref>` / `crew dev tui` (pick a worktree, then Claude or
an editor on it) — the **user's to run**, not yours, like the commands that replace the
process (`crew claude`, `crew open`; bare `crew fix` prints when there is no terminal) and
bare `crew debug` (follows the log). `crew workspace` and `crew project` print the tables
and point at the page; bare `crew config` is `config show`. Everything below is scriptable,
and `--json` works everywhere; under `--json` progress goes to stderr and stdout is the
document.

**If you are inside a crew worktree** (`$CREW_REF` is set, or the session opened with a
"## crew" section in its first message): that ref is yours. Servers, env, logs and checks go
through crew — never start a server by hand, never `-f`.

## 1. Model

- **Project** — a repo in the global pool, identified by its git remote: name, the path of
  crew's clone (or an adopted checkout), dev servers, **bindings**, optional setup and env
  commands, all shared by every workspace it appears in.
- **Workspace** — membership: which projects, each as a worktree or direct. Config only.
- **Worktree** — one working copy of a workspace's projects: a git worktree per project under
  `~/.crew/workspaces/<ws>/<wt>/<project>`, branch `crew/<ws>/<wt>/<project>`. Owns its
  reserved **ports** (kept across restarts) and its **overrides**.
- **Ref** — how you name a worktree: `<ws>/<wt>`, or bare `<ws>` when it has one worktree.
  `ws--wt` is the slug crew uses in hostnames, log dirs and tmux sessions; never type it.
- **Binding** — `{var, template[, server]}` on a project: which env var crew computes and
  how, so a project finds its siblings on the ports crew allocated — for every server of the
  project, or for one of them. Resolved against the worktree's
  ports at `crew dev start` and exported into each server's env. Env files are read, never
  written. §4 has the grammar; `docs/concepts.md` ("Bindings") has the why.

## 2. Read state

```
crew                                                       start crew's server if needed, open its page (the user's)
crew [--no-open]                                           prints the link instead: crew is running: <url>
crew workspace                                             the workspaces table + "configure in the browser: run crew"
crew project                                               the projects table + the same line
crew ls workspaces                                         <name>\t<n> projects\t<worktree>,<worktree>   --json adds projects[{name, mode}], wires[{var, from, to, ok}]
crew ls worktrees [<workspace>] [--size]                   <workspace>/<worktree>\t<path>\t[<size>\t][dev|installing][\t<recorded failure>]   --json adds issues[], installing
crew ls projects                                           <name>\t<path>\t<remote|->
crew ls bindings <project> [--check=<workspace>[/<worktree>]] [--preview]   <var>\t<server|->\t<template>[\t<resolved value>][\t→ <preview>]
crew ls bases <workspace>                                  <project>  <base>  <n behind origin/<base>|up to date>[   (checkout is on <branch>)]
crew ls overrides <workspace>/<worktree>                   <key>\t<value>
crew show <workspace>[/<worktree>]                         <name>\t<path>\t<worktree|direct>
crew dev status [<workspace>[/<worktree>]]                 <workspace>/<worktree>\t<server>\t<port>\t<url>
crew dev show <project>                                    <server-name>\t<port>\t<command>[\t<dir>]
crew env <workspace>[/<worktree>] <project>[/<server>]     <VAR>=<value>
crew ps [--json]                                           <kind>\t<pid>\t<session|cwd>\t<command>
crew trash [empty]                                         <path>\t<size>\t<n> entries\t<note>  |  <path>\tempty
crew config [show|set|refresh]                             bare: show
crew config show                                           <key>\t<value>
crew dev proxy [status|trust [--install]|stop]            <up|up (not listening)|down>\t<domain>\t<port>\t<status url>\thttps <up|not listening|off>\t<https port>
crew debug [--tail=<n>]                                    <date> <time> [<category>] <message>
crew server [start|stop|restart|status|logs|debug-notes|notes|keys|remote|machines|discord|dev] [--no-open]   <up|up (not answering)|down>\t<port>\t<localhost url>\t<proxy url>
crew server start [--no-open]      crew server stop      crew server restart [--no-open]      crew server status
crew server keys [status] | crew server keys set <anthropic|soniox>   <name>\t<missing|set (<file|env>)>\t<path>
crew server keys status
crew server logs [--since=] [--until=] [--cat=<c,…>] [--level=<debug|info|warn|error>] [--grep=] [--lines=<n>] [--machine=<id|name|main,…>] [--exclude=<…>] [--json]
                                                         <ts>\t<machine>\t<level>\t<cat>\t<msg>\t<other fields as JSON>
crew server debug-notes [--since=] [--until=] [--grep=] [--lines=<n>] [--json]   <n>\t<at>\t<view>\t<text>
crew server debug-notes show <n> [--around=30s] [--json]   debug note <n>\t<at>\t<view>, the note's parts, then log <from> … <to>: and the log rows
crew server notes [<workspace>|--all] [--since=] [--grep=] [--lines=<n>] [--json]   <workspace>\t<date time>\t<text>
crew server remote [status|stop]                            <up|down>\t<version>\t<busy|idle>\t<socket>
crew server machines [ls] | add <ssh host> [--name=<name>] | rm <id> | rename <id> <name>   <id>\t<name>\t<host>\t<status>
crew server machines ls      crew server machines add <ssh host> [--name=<name>]      crew server machines rm <id>      crew server machines rename <id> <name>
crew server discord setup [--guild=<id>] [--channel=<name|id>] [--text-channel=<name|id|voice>] [--user=<id>] | status | channels | send [--text=<message>] [--file=<path>]… | off
crew server discord setup [--guild=<id>] [--channel=<name|id>] [--text-channel=<name|id|voice>] [--user=<id>]
                                                         server: <name> (<id>) / you: <who> (<id>) / channel: <name> (<id>) / messages: the voice channel's chat | #<name> (<id>) / ready: Voice OS joins it while it runs
crew server discord status [--json]                         <field>\t<value>
crew server discord channels [--json]                       <id>\t<name>\t<text|voice>[, voice channel][, messages go here]
crew server discord send [--text=<message>] [--file=<path>]…   sent to <#channel | the voice channel's chat>: <link>
crew server discord off                                     removed\t<path>
crew server dev push [--dry-run] | status
crew server dev push [--dry-run]                            <machine>\t<goos>_<goarch>|skipped: <why> / Pushing <version> to every machine; …
crew server dev status [--json]                             <version> from <source>: <phase> / <machine>\t<goos>_<goarch>\t<state>
```

- `ls worktrees` is "what do I have checked out". `--size` walks every file — slow on a
  worktree with a full build inside; say so before running it on a big one.
- `env` prints resolved `KEY=VALUE` on stdout (eval-able); the table and anything left alone
  go to stderr. Values are point-in-time — resolve at run time with `crew run` instead of
  pasting them anywhere.
- `dev status` with no ref covers every worktree; a bare workspace means all its worktrees. A
  `!` line on stderr means a proxied worktree's proxy is down.
- Logs print and return: `dev logs <ref> <server> [--lines=N]`, `debug --tail=N`. Never `-f`
  or bare `debug` — they follow forever and you would hang. `dev logs` and `setup logs` take
  `--json`: `{ref, server|project, lines: []}`, the lines clean of terminal escape sequences.
- `debug --tail=N` is the last N lines of crew's own log (every git/tmux/install command it
  ran, with errors); `--json` parses them into `{at, category, message}`. Bare `debug` follows.

## 3. Projects and dev servers

```
crew add project <name> <url> [--setup=<cmd>] [--env-cmd=<cmd>]                  clones into ~/.crew/projects/<name>
crew add project <url> [--setup=<cmd>] [--env-cmd=<cmd>]                         the same, named by the repo (…/store-api.git → store-api)
crew add project --scan                                                          --scan: <name>\t<path>\t<remote|->\t<known|new>
crew add project <name> --path=<dir> [--setup=<cmd>] [--env-cmd=<cmd>]           adopts a checkout you already have
crew add project <name> [--setup=<cmd>] [--env-cmd=<cmd>] [--path=<dir>]         re-run on an existing project updates it
crew rm project <name> [--keep-clone]                          the clone crew made goes to the trash; an adopted path is left alone
crew check project <name> [--pull] [--no-smoke] [--wait]        one runner; crew setup status check/<name> watches it
crew check project <name> [--status]
crew check project <name> --status                               --status: <project>\t<none|running|passed|failed>[\t<verdict>][\t<when>][\t<recorded failure>]
crew dev add <project> --name=<name> [--port=<port>] --cmd=<command> [--dir=<subdir>]     no --port: a process that does not listen — no $PORT, no URL, smoke = stays alive
crew dev add <project> --name=<new> --rename=<old> [--port=<port>] [--cmd=<command>] [--dir=<subdir>]   rename in place; scoped bindings follow; --port=0 clears the port (does not listen)
crew dev rm <project> <server-name>
crew dev setup <project> [--apply --port=<port>]               <detected|added>\t<name>\t<command>
```

- Project names: `a-z 0-9 -`, and not `worktree`, `workspace`, `url`, `host`, `port` — they
  are token words.
- **A project is its git remote.** The default is a **git URL** (`git@…`, `https://…`,
  `ssh://…`, `file://…` — the full URL, never `owner/repo`): cloned into
  `~/.crew/projects/<name>`, and the remote is what names the project in `ls projects`,
  in an export, on another machine. A bare path is refused — a checkout you already have
  is adopted with **`--path=<dir>`** (its own `origin` is its identity; one with no
  remote exports as config only). `crew rm project <name>` takes the clone crew made with
  it (to the trash; `--keep-clone` leaves it; a path of yours is never moved) and is
  refused while a workspace still lists the project or a check of it is kept — `crew rm
  workspace <ws> <name>` first. `gh repo list <owner> --json name,url` is where URLs come from
  when the user has `gh`.
- **`crew check project <name>`** proves the config reproduces from nothing: a fresh
  checkout of the canonical repo through the setup runner (mise → install → `env: <cmd>` →
  a smoke of its own servers) as the target `check/<name>`. Pass → the checkout, branch and
  record are removed; `crew setup status check/<name>` still shows the ✓ table. Fail → kept:
  `crew ls worktrees` lists `check/<name>` with what failed, `crew fix check/<name> --print`
  has the evidence, `crew setup logs check/<name> <name>` the install output; fix the
  project's config (`--setup`, `--env-cmd`, `dev add`) and `crew check project <name>
  --wait` again (replaces it from nothing; `crew verify check/<name>` re-runs in place and
  a pass removes it too). `crew rm worktree check/<name>` removes a kept one by hand. Run
  it after configuring a project and before `add workspace`; a failure there is the same
  failure every worktree would hit.
- `--setup` is the install command for a fresh checkout when the lockfile alone is not the
  answer (`make sync` for a repo that also pulls model weights). Without it crew detects
  `uv sync`, `pnpm install`, `yarn`, `bun install` (`bun.lock`/`bun.lockb`) or `npm ci` from the lockfile; `mise install` runs first
  either way.
- `--env-cmd` is the command that **writes** a fresh checkout's env files — `make get-env`,
  `npm run get-env`, whatever pulls from sops or a vault. Runs in the checkout after the
  install (so a get-env that is a package script or an installed tool works) as its own
  step `env: <cmd>` in `crew setup status`. The copied `.env` is the baseline it
  overwrites; a file it does not regenerate stays as copied. Ask for it when a README
  mentions secrets, sops, 1Password or a `get-env` target; most projects have none. **It
  must write files, not print values** — its output is the runner log and, on failure, its
  last lines go on the worktree and into `crew fix`'s prompt; credentials stay in the
  tool's own config, never in the command (it is exported). `verify` does not re-fetch
  (it re-installs only what failed); `crew setup <ref> <project>` is the refresh. Not run
  on a direct-mode member or with `--no-install`.
- `--path` on an existing project: the repo moved. Worktrees already made keep working.
- **`add project --scan`** lists the checkouts already on this machine — under `~/code`,
  `~/projects`, `~/dev`, `~/src`, `~/Developer`, `~/work`, `~/repos`, three levels deep;
  never `Documents`, `Desktop` or `Downloads` (macOS would ask the user), hidden folders,
  `node_modules` or git worktrees — with each one's remote and `known` when the pool has it
  (same path, or the same repo by another URL). It lists, it never adds: pick with the user,
  then `crew add project <name> --path=<dir>`. `--json`: `[{name, path, remote, known}]`.
- `crew check project <name> --status` is the check at rest without starting one: `none`,
  `running`, `passed` (verdict `passed`, or `install only` when it ran `--no-smoke`) or
  `failed` with its record. `--json`: `{project, state, verdict, at, smoked, health,
  projects}`. `crew setup status check/<name>` still shows a passed check's ✓ table too.
- `dev setup` detects one server from `package.json` (`dev`, else `start`) and prints it;
  `--apply --port=<p>` records it. It cannot know the port; nothing detected is an error
  naming the `dev add` line to run instead. `dev add` is the full form.
- A server without `--port` is a process that does not listen (a worker, a queue consumer):
  crew runs it in its window with no `PORT`, hands out no URL, and a smoke only checks it
  stays alive; a binding aimed at it is unresolved (`has no port`).
- `dev add --name=<new> --rename=<old>` renames a server in place — the bindings scoped to
  it follow (an `rm` + `add` would drop them), and every binding in the pool whose value
  names it (`{{<project>/<old>}}`, `.host`, `.port`, the old `{{url:…}}` spelling) is
  rewritten to the new name, named on a second line (`Rewrote … in: <project> <VAR>[
  (<server>)], …`); the old port, command and dir stand unless given. A taken new name is
  refused.
- `dev add` on an existing server name replaces it. The port is **reference only**: crew
  allocates a free port per worktree and passes it as `$PORT`; the configured one is what
  `.env` files and bindings are matched against.
- **The contract a project must meet:** its dev server binds `$PORT` (`next dev -p $PORT`,
  `--port $PORT`, `process.env.PORT`), and it reads sibling URLs from env vars — the ones
  bindings fill. A server that ignores `$PORT` shows as `not listening` in `crew dev check`
  and collides across worktrees; tell the user which command to change, do not work around
  it with overrides.

## 4. Bindings and overrides

Projects reach each other over localhost, and crew allocates the ports, so no static value
in a `.env` can be right. A binding says which variable, and a template says how:

```
{{store-api}}                  http://localhost:<port>        the project's one server (URL)
{{store-api.host}}             localhost:<port>               for ws://, https://, a path: ws://{{store-api.host}}/rtc
{{store-api.port}}             <port>
{{checkout-api/worker}}        a named server, when the project has several; .host / .port after it
{{worktree}}  {{workspace}}    the names — agent-{{worktree}}, db_{{workspace}}_{{worktree}}
```

A value without tokens is used as-is — a **literal binding** (`--value=on`) is the
project-wide default for every worktree, the "project-level override"; a worktree override
still wins on top of it, and `duplicate` copies the source's overrides. Never put a secret
in a binding: bindings are exported. `{{url:x}}` / `{{port:x}}` is the pre-2.1 spelling —
still valid, never written by crew.

```
crew add binding <project>[/<server>] --var=<VAR> (--url=<proj[/server]> | --host=<proj[/server]> | --port=<proj[/server]> | --value=<template>) [--dry-run] | --scan [--apply]
crew rm binding <project>[/<server>] <var>
crew ls bindings <project> [--check=<workspace>[/<worktree>]] [--preview]
crew add override <workspace>/<worktree> <VAR>=<value>
crew rm override <workspace>/<worktree> <VAR>
crew ls overrides <workspace>/<worktree>
crew env <workspace>[/<worktree>] <project>[/<server>]
crew run <workspace>[/<worktree>] <project>[/<server>] -- <command...>
```

- `--url=x` writes `{{x}}`, `--host=x` writes `{{x.host}}`, `--port=x` writes `{{x.port}}`;
  `--value` takes any template. `--scan` reads the project's `.env` files across every
  checkout and proposes bindings for values pointing at ports crew allocates; `--apply` adds
  the unambiguous ones. `--scan --json` is one row per proposal with a `status` of `proposed`,
  `already bound`, `ambiguous`, `added` or `failed`.
- **`--dry-run` saves nothing**: the binding is checked the way the add would check it and
  previewed in every worktree of the project — `<ref>\t<value | left alone — why>\t<running|stopped>`
  (a stopped worktree resolves against the ports it gets back on its next start); a refused
  draft exits 1 with the reason. `--json`: `{var, server, value, error?, previews: [{ref, value,
  resolved, running, detail}]}`. `ls bindings <p> --preview` is the same for every binding the
  project has, a `→` cell per row (`--json`: rows with `previews`). Use them before an add the
  user has to trust.
- **Scope.** The owner is `<project>` — every dev server of the project gets the var — or
  `<project>/<server>` — that server alone. A monorepo registered as one project with a
  `web` and a `worker` server binds `mono/web --var=STORE_API_URL --url=store-api` and
  `mono/worker --var=QUEUE_URL …`; a scoped binding wins over a project-wide one on the same
  var for its server. `ls bindings` shows the scope in its second column (`-` = every
  server); a scan under `<project>/<server>` reads env files in that server's `--dir`.
  `crew dev rm <p> <s>` takes the server's scoped bindings with it. Overrides are per var
  and beat both scopes.
- **`crew env <ref> <project>` is the project-wide set** — what an `eval` should take. A var
  bound only for one server is not on its stdout; the stderr table labels such rows `VAR
  (server)` and names `crew env <ref> <project>/<server>`, which prints that one server's
  full set. `crew run` takes the same `<project>[/<server>]`.
- Precedence per variable: worktree override > scoped binding (for its server) >
  project-wide binding > left alone. A template that only partly resolves is left alone
  whole — never a half-expanded URL; a scoped one that does not resolve leaves the var
  alone for its server, it does not fall back to the project-wide value.
- An override is also the acknowledgement for a binding that legitimately never resolves in
  one worktree. Override values can carry credentials: never print them back.
- `crew run` is how evals, scripts and CLIs crew does not start get the same URLs the dev
  servers got: cwd is the project's checkout, env is resolved, everything after `--` is the
  command untouched (`crew run … -- child --json` keeps the child's flag).

## 5. Workspaces and worktrees

```
crew add workspace <name> [<project> ...] [--direct] [--wait]     <project>\t<added|failed>\t<worktree|direct>\t<detail>
crew rm workspace <workspace> <project> [--dry-run]                remove a project from a workspace
                                                                   --dry-run: <ref>\t<project>\t<path>\t<n> uncommitted\t<n> commits not on the base\t<size>
crew rm <workspace>                                                the whole workspace, every worktree
crew add worktree <workspace>/<name> [--pull] [--no-install] [--no-smoke] [--wait]
crew duplicate <workspace>[/<worktree>] <new-worktree> [--no-install] [--no-smoke] [--wait]
crew rename worktree <workspace>/<worktree> <new-name>            Renamed <workspace>/<worktree> → <workspace>/<new-name>   --json: {from, to, warnings: []}
crew setup <workspace>[/<worktree>] [<project>...] [--no-smoke] [--wait]
crew setup status <workspace>[/<worktree>] [--wait]               ✓|✗|▸ <project>  <step> <took> · <step> <took> · ▸ <running step> | <step> — <reason>
crew setup logs <workspace>[/<worktree>] <project> [--lines=<n>]
crew verify <workspace>[/<worktree>] [<project>...] [--wait]
crew fix <workspace>[/<worktree>] [--print]
crew rm worktree <workspace>/<name> [--dry-run]
crew ls bases <workspace>
crew migrate [--dry-run] [--yes]
```

- **A worktree is made in the background, one runner per project.** `add worktree`,
  `duplicate`, `setup`, `verify`, `add workspace <ws> <p>…` and `import … workspace` record
  what they are about to make, reserve the worktree's ports, start one runner per project
  (a window of tmux session `crew-setup-<ws>--<wt>`: checkout → `.env` → `mise trust` →
  install → a smoke of that project's own servers → record) and **return at once**. Wall
  clock is the slowest project, not the sum. Nothing is finished when the command returns —
  `crew setup status <ref>` is where the verdicts are.
- **Poll `crew setup status <ref>`** (or `--json`): one row per project with its state
  (`starting`, `running`, `ok`, `failed`, `interrupted`), its steps in order with how long
  each took, the running one marked `▸`, a failed one with its reason. Exit **2 while any
  runner is alive**, **1** once all stopped with anything recorded, **0** otherwise. A
  failure is recorded on the worktree **the moment it happens** — `crew fix <ref> --print`
  has it while the other runners still install, so act on the first failure early instead
  of waiting for the slowest install. `--wait` stays until no runner is left (then 1 or 0).
  `crew setup logs <ref> <project>` is what an install is printing right now (its steps
  and the package manager's output) — read it when a step is taking long.
- `--wait` on any of the creating commands does the polling for you: the table live in a
  terminal, then the summary — issues and the fix line — and exit 1 while anything is
  recorded. `--json` without `--wait` is `{ref, running: true, projects}` (no health yet);
  `--wait --json` is `{ref, projects, health}` as before. Without a terminal and without
  `--wait`, the command prints the `crew setup status` line and exits 0.
- `add workspace` takes any number of projects in one call — `store-api store-app
  checkout-api` — and creates the workspace if it is new (and takes it back when a name
  fails the pre-flight). Names are
  checked before anything happens; then the members are recorded and their runners start
  in every worktree of the workspace. `added` means **recorded and installing**, not done —
  the `crew setup status <ws>/<wt>` line is printed per worktree; with `--wait` the rows say
  `added` or `failed` for real and exit 1 on any failure. A checkout or install that fails
  keeps the member, recorded on that worktree. One call, not one per project.
- `--direct` adds the projects by their canonical paths instead of git worktrees — for a repo
  that must not be checked out twice.
- `rename worktree` is synchronous: the directory, every checkout's `crew/<ws>/<wt>/<p>`
  branch, the setup table, runner logs and dev logs move to the new name; overrides,
  reserved ports and a recorded failure travel with the record; the prompt is regenerated.
  Refused while its dev servers or a setup runner are alive, on a pre-2.0 workspace, on a
  check target, and when the new name or a branch it would take exists. A checkout on its
  own branch is kept and named in a `!` line. Interrupted, run it again with the same new
  name to finish. Shells, editors and agents opened on the old paths keep them — `crew
  claude` / `crew edit` the new ref. A pushed branch keeps its old upstream name; proxy
  hostnames change with the slug.
- `add worktree` prints each project's base branch and how far behind origin it is; `--pull`
  fast-forwards the local bases first (never touches a checked-out feature branch) — that
  part is in the foreground, before the runners start. Each runner: the checkout (with the
  repo's git hooks off — a hook written for a user's checkout does not get to fail crew's;
  `mise trust` when there is a `mise.toml`), `.env` copied from the canonical repo or a
  sibling worktree (`.env*` and the `.local.env` / `.local-overrides.env` files a get-env
  script merges), the install, the env command when the project has one, then the smoke
  of that project's servers — each watched
  until it listens on its port, dies, or a minute passes. **Each server is smoked on its
  own**: siblings' URLs are resolved (ports were reserved first) but nothing answers on
  them; a server that exits at boot because its upstream is unreachable reads `died` with
  the connection error in its evidence — that is the evidence to read, not a crew fault. A
  failed install keeps the worktree and ends that runner (no smoke of a half-installed
  checkout); `crew setup <ref> <project>` re-runs it.
- **Creation never stops.** Every runner runs to its own end; a failure at any stage is an
  issue **recorded on the worktree** (`checkout failed: x`, `install failed: x`, `server died:
  x/y`, or `N issues` in `crew ls worktrees`, `installing` in the dev column while runners
  are alive). A runner that vanished without a verdict (a killed window, a reboot) is
  recorded as `interrupted` by whoever looks next — never a clean row. Creation never opens
  a TUI: it prints the runners' table as it stands, the `crew setup status` line, and crew's
  page when the server runs — the page follows the runners live.
- **Verify** finishes what is missing — checks out and installs a project that has no
  checkout, re-installs one whose install failed — and smokes every project, one runner per
  project; each clears or rewrites its own project's record. **Name the project you fixed**
  (`crew verify <ref> <project>`) and only its runner starts — the others keep their record
  and their result. `crew fix <ref>` opens Claude with every issue, its evidence and the env
  anomalies — the user runs it. **You are already here: `crew fix <ref> --print`** prints
  that same prompt (the 30-line install tails, the dead servers' log lines, the anomalies)
  so you fix the cause yourself, then `crew verify <ref> <project> --wait`. Without a
  terminal bare `fix` prints too, so you cannot get it wrong. `--json` is the recorded
  health as data; `ls worktrees --json` carries the same `issues[]`. A plain `dev start`
  never clears health; the CLI prints the issues and proceeds (`! <ref>: … — crew fix … /
  crew verify …`). `verify` and `setup` refuse while the worktree's servers are running
  (they restart them): `crew dev stop <ref>` first.
- **Refused while runners are alive** — the one thing crew blocks on besides a verify under
  running servers, because a dev server on top of an install still writing the same
  checkout is corruption, not a warning: `crew dev start`, `verify`, `setup`, `duplicate`
  of that worktree, `crew rm workspace <ws> <p>` while that project's runner is alive, and
  a second runner for the same project. The error names `crew setup
  status <ref>`; wait for it (`--wait`) and retry. Adding a new project to a busy worktree
  is fine — it is one more runner. `crew rm worktree` and `crew kill` stop the runners.
- `duplicate` is a new worktree of the same projects with the source's overrides copied
  before its runners start; ports are never copied.
- **Removals have a dry run.** `crew rm worktree <ref> --dry-run` and `crew rm workspace <ws>
  <p> --dry-run` remove nothing and list each checkout the removal would take with what is in
  it — uncommitted files, commits not on the base (the reflog keeps those, nothing else
  does), size; a direct member is the canonical checkout and is kept. `--json`: `{checkouts:
  [{ref, project, path, direct, missing, uncommitted, commits, size_bytes}], last}` — `last`
  means it is the workspace's last worktree, which goes only with `crew rm <ws>`. Show the
  user the cost before any removal.
- `crew ls bases <ws>` is the base table on its own (fetched now; `--json`: `[{project, base,
  current, behind, ahead, error?}]`, behind `-1` when unknown); `add worktree --pull` pulls.
- `rm worktree` returns at once: the checkout is renamed into `~/.crew/trash` and deleted in
  the background (a full Xcode build can be 100+ GB), and its `crew/<ws>/<wt>/<project>`
  branch is deleted from the repo (commits not on the base stay in the reflog). Disk comes
  back a little later — `crew trash` shows what is still clearing. `rm worktree
  check/<project>` removes a kept check.
- `migrate` moves pre-2.0 flat workspaces to the nested layout: backs up, prints the plan,
  moves checkouts with `git worktree move`. Always `--dry-run` first and show the user the
  plan; `--yes` applies without the prompt. `--dry-run --json` is the moves as
  `[{workspace, ref}]` (`[]` when there is nothing to migrate), the plan text on stderr;
  `--yes --json` is `{migrated: <n>}`, everything else on stderr.

## 6. Dev servers

```
crew dev start <workspace>[/<worktree>] [--proxy]
crew dev stop [<workspace>[/<worktree>]]
crew dev restart <workspace>[/<worktree>] [--proxy]
crew dev logs <workspace>[/<worktree>] <server> [-f|--follow] [--lines=<n>]
crew dev check <workspace>[/<worktree>] [--wait]                  <project>/<server>\t<running|died|not listening>\t<port>\t<took>\t<detail>
crew dev proxy [status|trust [--install]|stop]
crew dev tui <workspace>[/<worktree>]                              the launch page (TUI), as crew launch <ref>
```

- Every server runs in a tmux window of session `crew-dev-<ws>--<wt>` with `PORT` set and
  the project's resolved bindings exported. URLs are `http://localhost:<port>`; `--proxy`
  adds `http://<server>--<ws>--<wt>.<domain>` for other devices.
- Ports are reserved per worktree and reused on restart, so a URL from `crew env` stays valid.
- **After a start, check.** `crew dev start` returns as soon as the panes are up; then
  `crew dev check <ref> --wait` watches each server until it listens, dies, or a minute
  passes and says which `died` (log tail in the detail) or is `not listening` on its port —
  a failure when a binding points at it, a note when nothing does (a queue worker registered
  with a port). Bare `dev check` is one look now, for servers that have been up a while.
  Exit 1 on a failure; `crew fix <ref> --print` then has the evidence. The smoke at creation
  and `verify` apply the same tests with the same patience.
- **Read the end of `crew dev start` and relay it verbatim.** After the URLs: a resolution
  count, anything left alone, then `!` blocks — an env value pointing at a port crew gave to
  something else, or at a sibling's configured port while it runs elsewhere, or a proxy
  session that came up with nothing listening. Servers still start (warn, never block); the
  block is the one place a wrong URL is visible before it fails at runtime. `--json` gives
  the same as `{ref, urls, resolutions, conflicts, warnings, health}`.
- `stop` and `status` with a bare workspace mean all its worktrees. `crew dev stop` (and
  `crew kill`) never stop crew's server — it is not a dev session.

**Proxy on other devices.** `--proxy` runs one reverse proxy on `<server_ip>:<proxy_port>`
(`crew config show`; default the Wi-Fi IP and 80, domain `<server_ip>.nip.io`). Its own page
at `http://<server_ip>:<proxy_port>/` lists every proxied URL — `crew dev start` prints it.
Crew can only see this machine, so when a URL works here and not on a phone, have the user
open that page there and branch on the answer:
- It loads → the hostname is the problem: `<ip>.nip.io` resolves to a private IP, which
  router DNS rebind protection (Fritz!Box, UniFi, dnsmasq, Pi-hole), NextDNS or iOS Private
  Relay refuse. Fixes: allow `nip.io` in the router/resolver, turn off *Limit IP Address
  Tracking* for that Wi-Fi on the iPhone, or `crew config set domain <own wildcard domain>`.
- It does not load → the device cannot reach this machine: different network, guest/AP
  isolation, VPN, cellular.
- Tailscale sidesteps both: `crew config set server_ip $(tailscale ip -4)`, then `crew dev
  restart <ref> --proxy` — the proxy is relaunched whenever its settings changed, and the
  URLs work off the LAN too.
Verify first that it is not this side: `crew dev proxy status` — `up` with the expected
domain and port, or `up (not listening)` (the port is taken; the pane's last line is in the
`!` warning `dev start` printed) or `down`. `crew dev proxy stop` kills the proxy alone.

**HTTPS on the proxy.** The proxy also serves every hostname over HTTPS on
`proxy_https_port` (443; `-1` turns it off) with a certificate from crew's own CA in
`~/.crew/tls/<domain>/` — one CA per domain, kept for good, and limited to that domain, so it
can vouch for nothing else. A device trusts it once: `crew dev proxy trust` prints the CA, its
SHA-256 and the steps (a phone downloads it from `http://<domain>/crew-ca.pem`, the status
page links it); `--install` trusts it on this Mac. Pin `server_ip` first: while it is
detected, the domain can flip between LAN and Tailscale IPs, and each domain has its own CA.
`crew dev proxy status` ends with `https up|not listening|off` and the port.

## 7. Launching

```
crew claude <workspace>[/<worktree>]                     Claude Code in this terminal, in the worktree
crew edit <workspace>[/<worktree>] [--editor=cursor|code]   local editor on the worktree, prompt + Claude wired
crew open <workspace>[/<worktree>]                       a shell in the worktree directory
crew code <workspace>[/<worktree>]                       remote-SSH URL for Cursor/VS Code (needs ssh_host)
crew start <workspace>[/<worktree>]                      print the orientation prompt
crew launch [<workspace>[/<worktree>]]                   TUI: with a ref, the launch page; bare, a worktree picker
```

- `claude` and `open` replace the crew process and refuse without a terminal — the user runs
  them, not you (bare `fix` prints instead). `claude` skips permissions, passes every project
  with `--add-dir`, sets `CREW_REF`, and injects the orientation prompt (`crew start` prints
  it): the projects, their paths, and a `## crew` section telling that session to drive the
  servers through crew.
- `edit` opens Cursor (else VS Code) locally; `code` prints a URL for another machine. Both
  say which they are in `crew help`.
- The launch page (`crew launch <ref>`, `crew <ref>`) launches only: Editor + Claude, Claude
  in terminal, the remote editor, a shell; its servers show read-only with `l` for logs, and
  its last line names where to manage the worktree — crew's page (its link without the
  sign-in token) and `crew dev start <ref>`.

### crew's server: Set up and Voice OS

`crew` (bare) starts crew's server when it is not running and opens its page in the browser
— Home, then **Set up** or **Voice OS**; with no terminal, over SSH or with `--no-open` it
prints the link (over SSH: the proxy's link whenever crew's proxy reaches the server — a
`domain` set or the automatic `<server_ip>.nip.io` — else the
`ssh -L <port>:localhost:<port> <host>` line to run on the user's computer). It needs tmux
alone and never asks for keys (the page does). On a machine running `crew server remote` it
says so and exits 0 — the main's page is where that machine is set up. `crew server`
(bare: `status`) is the lifecycle: `start` (checks tmux and Claude Code, downloads Voice OS on
the first run, asks at a terminal for a missing key), `stop`, `restart`, `status`, `keys`.
`crew voice …` is the same command under its old name and works for good (bare `crew voice`
still starts it); at a terminal it notes the new name. **Set up** is every configuration
form — each runs a crew command from this reference and shows it — plus a per-machine
**Setup with Claude** chat; **Voice OS** is the voice and web cockpit that holds one Claude
Code session per worktree, streams their output, and takes permission answers, questions
and dictation by voice or click.

It runs in tmux session `crew-server` (outside `crew-dev-*`, so `crew dev stop` and `crew
kill` never stop it; one started before the rename, `crew-dev-os`, is still recognised and
stopped) on a remembered port, and registers the proxy route `voice--os.<domain>`. Browsers
only grant the microphone on localhost or HTTPS: the localhost link works on this Mac, and the
proxy link is HTTPS whenever the proxy serves it, so it works on any device that trusts
crew's CA (`crew dev proxy trust`). `crew server start` again reprints the link (sign-in is a
cookie); `crew server stop` ends it and its sessions, which resume on the next start. `os` is
a reserved workspace name.

`crew server start` (unless it already answers) first checks what Voice OS needs — tmux, and
Claude Code (`claude` on PATH or `VOICEOS_CLAUDE_BIN`, handed to Voice OS as found) — and stops
with the fix for anything missing (`--json`: `{"missing":[{name, why, install}]}`, exit 1).
The first start downloads Voice OS (25–40 MB) from the release matching this crew; `crew
update` refreshes it once it is installed (a version stamp beside the binary says which
release it is) and never restarts a running one (`crew server restart` picks the new version
up). A dev build of crew has no release to take it from: `cd voiceos && bun run install-dev`.
Voice needs two API keys, stored in `~/.config/crew-voiceos` (owner-only, never exported to
a shell — an exported `ANTHROPIC_API_KEY` would bill every Claude Code session per token):
Anthropic for the kernel and narrator, Soniox for speech. The page asks for them; `crew
server keys` lists them (`<name>\t<set (file|env)|missing>\t<path>`, never a value) and `crew
server keys set <anthropic|soniox>` reads one from stdin — a rejected key is not saved
(`Anthropic rejected that key — check it and try again.`), one that could not be checked
(offline) is. A running server picks a new key up from the next words.

**Other machines.** One Voice OS (the main) can drive the sessions of another machine's
worktrees — a VM, a second computer — over SSH. On that machine (the remote), install crew and
run `crew server remote` once: it checks tmux and Claude Code, installs Voice OS and starts a
daemon in tmux that outlives any SSH link (`crew server remote status|stop`). On the main,
`crew server machines add <ssh host> [--name=<name>]` (or + Add machine on the page) records it
in `~/.crew/voiceos/machines.json`, and a running Voice OS connects within a second with
`ssh <host> … crew voice _attach` (the alias — an older remote knows only that name) — BatchMode, so the host must be reachable with your keys and
its host key trusted (run `ssh <host>` once). How the machine is reachable is its own business:
LAN, a VPN, an SSH config alias. Its sessions show under their machine (`vm1:store-front/main`,
named aloud with the machine's name), its dev servers are its own crew's, and a dropped link
never stops them: the main reconnects, catches up from a snapshot and says one recap line.
`crew server machines` lists `<id>\t<name>\t<host>\t<status>` (status as the running Voice OS
last saw it, `stopped` when it is not running). A machine is a main or a remote, never both.

**Discord.** Optional: while Voice OS runs, a bot of the user's own joins one voice channel of
their Discord server and takes only one person's voice there (the server owner, or `--user`).
The user makes the bot (Discord Developer Portal → app → Bot → copy the token) and invites it
with View Channel, Connect and Speak; then `crew server discord setup` reads the token from stdin
(hidden at a terminal — hand the user `pbpaste | crew server discord setup`, never put the token
in a command line or your reply). A rejected token is not saved; an accepted one goes to
`~/.config/crew-voiceos/discord.key` (owner-only). It then decides the server (the only one the
bot is in, else `--guild=<id>`), the voice (the server owner, else `--user=<id>`) and the channel
(one named `Voice OS`, else the only voice channel, else `--channel=<name|id>`), checks the bot's
View Channel, Connect and Speak, and writes `~/.crew/voiceos/discord.json`
(`{guild,channel,channel_name,guild_name,owner}`), which a running Voice OS watches. Each
decision is one line (`server: Private (155…)`, `you: the server owner (226…)`, `channel:
General (155…)`, `ready: …`); a choice it cannot make lists `<id>\t<name>` and exits 1, and a
rerun with nothing pasted reuses the saved token. With no token at all it prints the four setup
steps. `crew server discord status` prints `<field>\t<value>` rows — setup, token, server,
channel, owner, then what Voice OS last reported (connected, owner_in_channel, error, at) or
`live\tVoice OS has not reported`; `--json`: `{set_up, token, config|null, live|null}`. `crew
server discord off` removes discord.json and the token (`removed\t<path>` per file).

**Posting to the user's Discord: `crew server discord send`.** Only when the user asks you to send
something there ("send that screenshot to Discord") — never on your own. `--text=<message>` (or text
piped on stdin) and any number of `--file=<path>` (at most 10, each at most 10 MB; text over 2000
characters goes as `message.md`); every limit is checked first, so it posts whole or not at all,
and mentions never ping. It prints `sent to <where>: <link>`; `--json`: `{channel, channel_name,
message, link, files, text_attached, is_voice_chat}`. It works the same on the main and on a remote:
a remote stages the message under `~/.crew/discord-out/<id>/` and the main fetches it over scp and
posts it with its token (the token never leaves the main). Messages go to the voice channel's own
chat unless a text channel was picked: `crew server discord setup --text-channel=<name|id>` (the bot
needs View Channel, Send Messages and Attach Files; `voice` goes back to the voice chat; a rerun
without the flag keeps it). `crew server discord channels` lists where a message can go
(`<id>\t<name>\t<text|voice>`, marking the voice channel and the current one). A session is told
about `send` in its orientation only when Discord is set up (on a remote, when the main says so).

**Trying a branch on every machine: `crew server dev push`.** A remote refuses a main on another
version, so a branch built from source can't meet your remotes until it is released. `crew server dev
push`, run in a crew checkout on any machine — the main or a remote — builds that checkout's crew
and Voice OS for each OS and CPU your machines run (go and bun needed there), stamps them
`dev-<commit>` (`-dirty-<hash>` with uncommitted ones, so each new change is a new version), and hands the push to the main, where it runs
detached in tmux `crew-voice-push`: restarting Voice OS, or the Claude session that asked, never ends
it. It copies both binaries everywhere and checks them (any failed copy → nothing installed), then
installs and restarts each machine — the other remotes, the main, the machine you pushed from last.
A machine out of reach is skipped and named. It returns at once; `crew server dev status` (from any
machine) follows it: `<version> from <source>: <phase>`, then `<machine>\t<goos>_<goarch>\t<state>`.
`--dry-run` lists the machines and targets only. `crew update` on a machine goes back to the release.
The first push must start from the main: a remote's push needs a main that already runs dev push.

**Debugging the server and Voice OS: logs, debug notes, notes.** Read these through crew, never by grepping
the files (the log rotates at 20 MB into `voiceos.log.1` … `.5`, and a remote's log is on
another machine):

- `crew server logs` — the log from every machine at once, merged by time, newest `--lines`
  (80) printed oldest first. Filters: `--since`/`--until` (a span back `10m`/`2h`/`3d`, a clock
  time `10:02` — one still ahead means yesterday — or an ISO time; converted to UTC where you
  typed it), `--cat=router,kernel`, `--level=warn` (and above), `--grep` (the message and field values, any case),
  `--machine=`/`--exclude=` (an id, a name, or `main`). On the main it asks each remote over SSH
  in parallel (20 s each; `! asking 2 machines…` on stderr): a machine that does not answer is a
  `! vm2 (build box) unreachable: …` line on stderr and a row in `unreachable`, the others still
  print; `! vm1 runs an older crew; run crew update there` when its crew predates this. Exit 1
  only when no machine answered. `--machine=main` is the fast look, no SSH. On a remote it asks
  the main through the daemon's link and prints what the main would; with the main not connected
  it prints its own log after `! the main is not connected; showing only this machine's logs`
  (`! restart the remote daemon with crew server remote` for a daemon from before this).
  `--json`: `{"lines":[{ts,machine,level,cat,msg,fields}],"unreachable":[{machine,name,reason}]}`.
- `crew server debug-notes` — what the developer flagged (`n` is the note's line in
  `debug-notes.jsonl` and survives filters); `debug-notes show <n>` prints the whole note (said,
  the kernel's words, heard here, sessions, asks, spoken) and then the main's log within
  `at ± --around` (30s), saying so when that stretch has rotated out. `--json`:
  `{"notes":[{n,at,view,text}]}` / `{"note":{…},"lines":[…]}`.
- `crew server notes [<workspace>|--all]` — the developer's own notes (bare: the general ones; a
  workspace any way Voice OS names it). `--json`: `{"notes":[{workspace,at,text}]}`.

Notes and debug notes live on the main; on a remote they come through the link and fail with the
reason (exit 1) when the main is not connected. Unknown flags are an error. Start from a debug
note: `crew server debug-notes`, then `show <n>`, then widen with `crew server logs --since=… --until=…`.

## 8. Moving to another machine

```
crew export [<file>|-] [--all | --projects=<a,b> [--workspaces=<x,y>]]     default file ./crew-export.json; - is stdout
crew import <file>|- [--plan | --all [--replace] [--pull] [--no-install] [--no-smoke] [--wait] | project <name> [--path=<dir>] [--replace] [--name=<new>] [--setup=<cmd>] [--env-cmd=<cmd>] | workspace <name> [--pull] [--no-install] [--no-smoke] [--wait]]
                                                         <project|workspace>\t<name>\t<status|outcome>\t<detail>
```

- A bundle carries projects by **git remote** (dev servers, bindings, setup, env command —
  no path) and workspace **membership** (projects and their modes). Never worktrees, ports or
  overrides. A project whose checkout has no remote still exports, as config only: `export`
  says so (`<name> has no git remote — it cannot be cloned on another machine`; `--json`
  lists them under `no_remote`).
- Without `--projects`, `export` takes everything; with it, every workspace named must be
  covered by them. `-` as the file writes the bundle to stdout (narration on stderr) — how
  the page downloads it; `crew import -` reads one from stdin.
- Bare `import` is the plan (`--plan`); crew's page walks the same plan item by item.
- **You drive it with modes.** `--plan` first: one row per item —
  `project\t<name>\texists|other remote|clone|blocked|missing\t<detail>` (`exists` = here
  under the same remote, nothing to do; `other remote` = the name is here but its checkout
  points elsewhere, detail names it; `clone` = not here, detail is where the clone lands;
  `blocked` = that dir is already taken — `--path` adopts it, or delete it; `missing` = no
  remote in the bundle — `--path=<dir>` is the only way, an old bundle's path is shown as
  the hint) and `workspace\t<name>\texists|ready|needs\t<members>`. Then per item:
  `crew import <file> project <name> [--path=<dir>] [--replace] [--name=<new>] [--setup=<cmd>] [--env-cmd=<cmd>]`
  prints the same row with the outcome — `imported`, `imported (cloned)`, `replaced`,
  `replaced (cloned)` — and the path; `--name=<new>` onto a name already in the pool is
  refused before any clone, and a rename prints `! <who>'s <VAR> point at <old> — left alone
  until re-bound` for the bundle's bindings it leaves behind; a name already in the pool needs `--replace`: same
  remote swaps the config and keeps the checkout, another remote clones fresh (refused
  while a workspace still has the project — its worktrees hang off the old checkout). A
  repo you already have on disk is cloned a second time unless you `--path` it — that is
  the trade, not a bug. `crew import <file> workspace <name> [--pull] [--no-install]
  [--no-smoke] [--wait]` creates it once every member is in the pool — **exactly the way
  `crew add worktree` makes one**: the base table (`--pull` fast-forwards the local bases
  first; say so when it prints `behind`), then one runner per project in the background;
  the row says `created\tinstalling — crew setup status <name>/main` and you poll that.
  With `--wait` the row carries the verdict: `created … N issue(s) recorded — crew fix
  <name>/main --print`, exit 1. `crew import <file> --all [--replace] [--pull] …` does the
  whole bundle: every project not here is cloned, the ones here kept unless `--replace`;
  any `blocked` or `missing` row — and, under `--replace`, an `other remote` row for a
  project a workspace still has — refuses the run up front, before a single clone; a
  project that fails on the way is a `failed` row and exit 1; a workspace already here is
  a `kept local` row. Output rows
  `<kind>\t<name>\t<outcome>\t<detail>`. A replace on a project here whose bundle entry
  has no remote (a config-only export) swaps the config and keeps the checkout.

## 9. Housekeeping

```
crew clean [--dry-run]                                  <kind>\t<path>\t<removed|would remove|pruned|would prune|failed: <reason>>  |  nothing to clean
crew doctor [--install [--yes] [--with-claude]]         <name>\t<ok|missing>\t<required|optional>\t<why>\t<install>
crew trash [empty]
crew ps [--json]
crew kill [--dry-run]
crew config show | crew config set <key> <value> | crew config refresh
crew debug [--tail=<n>]                                  bare: follow the log; --tail prints and returns
crew update [--check]                                   --check: crew v<current> — v<latest> is available (crew update) | up to date (latest v<latest>) | crew (dev build[ <sha>]) — crew update installs the latest release (v<latest>)
crew uninstall [--purge] [--yes]
crew help [<command>] [<subcommand>] [--json]
```

- `doctor` says whether tmux and git (required) and Claude Code (optional) are there and how to get
  them; exits 1 when a required one is missing. `--install` asks, then installs; without a terminal
  it needs `--yes` (`--with-claude` adds Claude Code). The first crew command that needs tmux or git
  offers it once at a terminal.
- `clean` is the sweep every crew command runs at most once an hour, now, plus `git
  worktree prune` on every pool repo: failed checks older than seven days, runner files /
  dev logs / route files of worktrees and checks that no longer exist, stale lock files,
  the trash. Kinds: `check`, `setup`, `logs`, `routes`, `lock`, `trash`, `prune`. Nothing
  outside `~/.crew` is ever removed; a live dev or setup session keeps its slug's files.
  `--dry-run` first when the user asks what it would do.
- `ps` lists crew's tmux sessions and processes that leaked out of them; `kill` stops every
  session and reclaims the leaks (never anything with a live parent) and prints how to
  restore — crew's server is listed as `kept` and never stopped. `--dry-run` first.
- `update --check` installs nothing: `--json` `{current, latest, available, dev, error?, line}` (`line` is the text form);
  offline is `available: false` with the error, not a failure. A dev build is never
  `available` and says `dev: true` — `crew update` replaces it with the latest release; a crew ahead of the
  latest is up to date (`update` never downgrades). `update --json` is `{from, to,
  updated}`. `update` never restarts crew's server.
- `config set` keys: `server_ip`, `ssh_host`, `proxy_port`, `proxy_https_port`, `domain`. A
  changed `server_ip`, `domain`, `proxy_port` or `proxy_https_port` takes effect on the next `dev start|restart --proxy`. `refresh`
  rewrites the managed tmux config.
- `uninstall --purge` deletes every checkout — confirm with the user first; `--yes` skips
  crew's own prompt.

## Flows

**"What do I have?"** — `crew ls worktrees`, then `crew dev status`.

**"Set up a second working copy of store-front"**
1. `crew ls worktrees store-front`
2. `crew add worktree store-front/wrk3 --pull` — relay the base table; the runners start.
3. `crew setup status store-front/wrk3` every ten seconds or so (or `--wait` once). A `✗`
   row while others still run: act on it now — `crew fix store-front/wrk3 --print`, fix,
   `crew verify store-front/wrk3 <project>`. Relay the final table.
4. Tell them: `crew launch store-front/wrk3`, or `crew claude store-front/wrk3` — or to
   follow it on crew's page (`crew`).

**"Why is service X talking to the wrong thing?"**
1. `crew env <ws>/<wt> <project>` — what resolved, what was left alone.
2. `crew ls bindings <project>` — is the edge declared? If not: `crew add binding <project> --scan`.
3. `crew dev restart <ws>/<wt>` — read the `!` block.

**"Something failed when I created the worktree"**
1. `crew setup status <ws>/<wt>` — which project, at which step, and whether the others
   are still running; `crew ls worktrees <ws>` has the summary (`checkout failed: …`,
   `install failed: …`, `server died: <project>/<server>`, `N issues`).
2. `crew setup logs <ws>/<wt> <project>` for what the install printed; `crew env <ws>/<wt>
   <project>` for what was left alone.
3. `crew fix <ws>/<wt> --print` — every issue with its evidence, as the prompt Claude would
   get. Fix the cause (`.env`, `crew add override`, git, the setup command) and `crew verify
   <ws>/<wt> <project> --wait` — only that project's runner, the others keep their record;
   it also finishes a checkout or install that failed. Or hand the user `crew fix <ws>/<wt>`
   to open Claude on it.

**"Open it on my phone"**
1. `crew dev restart <ws>/<wt> --proxy` — relay the URLs and the `Other devices:` line.
2. Not opening there? The user opens the `Other devices:` URL on the phone, then the §6
   branch: loads → DNS (nip.io blocked), does not → not the same network. Tailscale when
   either bites.

**"Run the evals with the right URLs"** — `crew run <ws>/<wt> checkout-api -- make eval`.

**"Dev servers for a new project"** — `crew dev add <project> --name=<n> --port=<p>
--cmd="<c>"`, then `crew add binding <project> --scan`.

**"Start everything and make sure it works"**
1. `crew dev start <ws>/<wt>` — relay the URLs and any `!` lines.
2. `crew dev check <ws>/<wt> --wait` — every row `running`? Done. A `died` or
   `not listening` row: `crew dev logs <ws>/<wt> <server> --lines=50`, or `crew fix
   <ws>/<wt> --print` for all of it at once; fix, `crew dev restart`, check again.

**"Set crew up on my other machine"**
1. Here: `crew export ~/Desktop/crew.json --all` (or Export on crew's page).
2. There: `crew import ~/Desktop/crew.json --plan` — read every row. Then per project:
   `clone` → `crew import … project <name>` (it clones into `~/.crew/projects/<name>`; if
   the user already has that repo checked out, `--path=<dir>` adopts it instead);
   `blocked` → `--path=<dir>` for the dir that is there, or have the user delete it;
   `missing` → ask where the repo is, then `--path=`; `exists` → leave it, or `--replace`
   if the user wants the bundle's servers and bindings; `other remote` → ask which repo is
   right — `--replace` clones the bundle's.
   Then `crew import … workspace <name> --pull` for each `ready` one — it makes the `main`
   worktree the way `add worktree` does (base table, then the runners in the background)
   and returns; poll `crew setup status <name>/main` and act on the first `✗` while the
   rest install; relay the final table and any `crew fix … --print` line. `--all --pull` is
   the one-shot when every row is `clone`/`exists`/`ready`; add `--wait` to have it block.

**"Disk is full"**
1. `crew trash` — anything still clearing? `crew trash empty` finishes it now.
2. `crew clean --dry-run`, then `crew clean` — leftovers of worktrees and checks that are gone.
3. `crew ls worktrees --size` — which worktree; build output inside a checkout is what grows.
4. `crew rm worktree <ws>/<wt>` for one that is done — returns at once, clears in background.

**"Which of my repos are in crew?"** — `crew add project --scan`; each `new` row is one
`crew add project <name> --path=<dir>` away — ask before adding.

**"Remove that worktree"** — `crew rm worktree <ws>/<wt> --dry-run`, tell the user what is
uncommitted or unmerged, then (confirmed) `crew rm worktree <ws>/<wt>`.

**"Add this repo and make sure it runs"** (a URL, or a pick from `gh repo list`)
1. `crew add project <url> [--setup=…] [--env-cmd=…]` (or `<name> <url>`) — clones to `~/.crew/projects/<name>`
   (a checkout the user already has: `--path=<dir>` instead).
2. Read the clone's README / Makefile / package.json / pyproject / mise.toml; `crew dev add
   <name> --name=… --port=… --cmd=…` per server, `--setup` / `--env-cmd` when the lockfile
   alone is not the answer.
3. `crew check project <name> --wait` — `✓` means the config reproduces. `✗`: `crew setup
   logs check/<name> <name>` or `crew fix check/<name> --print`, fix, check again.
4. Then `crew add workspace <ws> <name>` or `crew add workspace <ws> <name> …`.

## Rules

- A ref is `ws/wt`; print `ws--wt` only when quoting a hostname or tmux session.
- Relay `left alone` and `!` lines from `crew dev start` verbatim.
- Never paste `crew env` output into a file; use `crew run`.
- Never print override values or binding-resolved values that look like credentials.
- Destructive, confirm first: `rm <ws>`, `rm worktree`, `rm project` (crew's clone goes too),
  `uninstall --purge`, `trash empty`, `clean` (dry-run first), `migrate` (dry-run and show
  the plan), `kill`.
- Bare `crew`, the launch TUI and process-replacing commands (`claude`, `open`, bare `fix`)
  are for the user to run; give them the exact line. Everything the page and the TUI do has
  a flag form above — use that.
- Before a removal, its `--dry-run`: say what would go.
