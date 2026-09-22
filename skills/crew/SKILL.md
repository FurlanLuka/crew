---
name: crew
description: >
  Complete CLI reference for crew — projects, workspaces, worktrees, dev servers on stable
  per-worktree ports, env bindings, launching Claude and editors, moving to another machine,
  disk housekeeping. Use whenever the user mentions crew, a workspace, a worktree, dev
  servers, bindings, or wants Claude or an editor opened on a checkout.
user-invocable: true
---

# crew

crew is a plain CLI; this reference is for any agent with a shell. Everything crew does is a
command. List commands print tab-separated rows; `--json` works on
any command, in any position. `crew help <cmd> [<sub>]` is authoritative; `crew help --json`
dumps the whole tree. Never guess state — run the command.

Every action has a non-interactive form; nothing needs the TUI. The full-screen views are
the **user's to run**, not yours — `crew workspace`, `crew project`, `crew config` (bare),
`crew launch`, `crew dev tui`, `crew debug` (bare), `crew export` without flags, `crew import`
without a mode — and so are the commands that replace the process (`crew claude`, `crew open`;
bare `crew fix` prints when there is no terminal). Everything below is scriptable, and
`--json` works everywhere; under `--json` progress goes to stderr and stdout is the document.

**If you are inside a crew worktree** (`$CREW_REF` is set, or the session opened with a
"## crew" section in its first message): that ref is yours. Servers, env, logs and checks go
through crew — never start a server by hand, never `-f`.

## 1. Model

- **Project** — a repo in the global pool: name, path, dev servers, **bindings**, optional
  setup command, all shared by every workspace it appears in.
- **Workspace** — membership: which projects, with which roles. Config only.
- **Worktree** — one working copy of a workspace's projects: a git worktree per project under
  `~/.crew/workspaces/<ws>/<wt>/<project>`, branch `crew/<ws>/<wt>/<project>`. Owns its
  reserved **ports** (kept across restarts) and its **overrides**.
- **Ref** — how you name a worktree: `<ws>/<wt>`, or bare `<ws>` when it has one worktree.
  `ws--wt` is the slug crew uses in hostnames, log dirs and tmux sessions; never type it.
- **Binding** — `{var, template}` on a project: which env var crew computes and how, so a
  project finds its siblings on the ports crew allocated. Resolved against the worktree's
  ports at `crew dev start` and exported into each server's env. Env files are read, never
  written. §4 has the grammar; the README's "Bindings" section has the why.

## 2. Read state

```
crew ls workspaces                                         <name>\t<n> projects\t<worktree>,<worktree>
crew ls worktrees [<workspace>] [--size]                   <workspace>/<worktree>\t<path>\t[<size>\t][dev|installing][\t<recorded failure>]   --json adds issues[], installing
crew ls projects                                           <name>\t<path>
crew ls bindings <project> [--check=<workspace>[/<worktree>]]   <var>\t<template>[\t<resolved value>]
crew ls overrides <workspace>/<worktree>                   <key>\t<value>
crew show <workspace>[/<worktree>]                         <name>\t<path>\t<role>
crew dev status [<workspace>[/<worktree>]]                 <workspace>/<worktree>\t<server>\t<port>\t<url>
crew dev show <project>                                    <server-name>\t<port>\t<command>[\t<dir>]
crew env <workspace>[/<worktree>] <project>                <VAR>=<value>
crew ps [--json]                                           <kind>\t<pid>\t<session|cwd>\t<command>
crew trash [empty]                                         <path>\t<size>\t<n> entries\t<note>  |  <path>\tempty
crew config show                                           <key>\t<value>
crew dev proxy [status|stop]                               <up|up (not listening)|down>\t<domain>\t<port>\t<status url>
crew debug [--tail=<n>]                                    <date> <time> [<category>] <message>
```

- `ls worktrees` is "what do I have checked out". `--size` walks every file — slow on a
  worktree with a full build inside; say so before running it on a big one.
- `env` prints resolved `KEY=VALUE` on stdout (eval-able); the table and anything left alone
  go to stderr. Values are point-in-time — resolve at run time with `crew run` instead of
  pasting them anywhere.
- `dev status` with no ref covers every worktree; a bare workspace means all its worktrees. A
  `!` line on stderr means a proxied worktree's proxy is down.
- Logs print and return: `dev logs <ref> <server> [--lines=N]`, `debug --tail=N`. Never `-f`
  or bare `debug` — they follow forever and you would hang.
- `debug --tail=N` is the last N lines of crew's own log (every git/tmux/install command it
  ran, with errors); `--json` parses them into `{at, category, message}`. Bare `debug` follows.

## 3. Projects and dev servers

```
crew add project <name> <path> [--setup=<cmd>] [--env-cmd=<cmd>]
crew add project <name> [--setup=<cmd>] [--env-cmd=<cmd>] [--path=<dir>]         re-run on an existing project updates it
crew rm project <name>
crew dev add <project> --name=<name> --port=<port> --cmd=<command> [--dir=<subdir>]
crew dev rm <project> <server-name>
crew dev setup <project> [--apply --port=<port>]               <detected|added>\t<name>\t<command>
```

- Project names: `a-z 0-9 -`, and not `worktree`, `workspace`, `url`, `host`, `port` — they
  are token words.
- `--setup` is the install command for a fresh checkout when the lockfile alone is not the
  answer (`make sync` for a repo that also pulls model weights). Without it crew detects
  `uv sync`, `pnpm install`, `npm ci` or `yarn` from the lockfile; `mise install` runs first
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
- `dev setup` detects one server from `package.json` (`dev`, else `start`) and prints it;
  `--apply --port=<p>` records it. It cannot know the port; nothing detected is an error
  naming the `dev add` line to run instead. `dev add` is the full form.
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
crew add binding <project> --var=<VAR> (--url=<proj[/server]> | --host=<proj[/server]> | --port=<proj[/server]> | --value=<template>) | --scan [--apply]
crew rm binding <project> <var>
crew ls bindings <project> [--check=<workspace>[/<worktree>]]
crew add override <workspace>/<worktree> <VAR>=<value>
crew rm override <workspace>/<worktree> <VAR>
crew ls overrides <workspace>/<worktree>
crew env <workspace>[/<worktree>] <project>
crew run <workspace>[/<worktree>] <project> -- <command...>
```

- `--url=x` writes `{{x}}`, `--host=x` writes `{{x.host}}`, `--port=x` writes `{{x.port}}`;
  `--value` takes any template. `--scan` reads the project's `.env` files across every
  checkout and proposes bindings for values pointing at ports crew allocates; `--apply` adds
  the unambiguous ones. `--scan --json` is one row per proposal with a `status` of `proposed`,
  `already bound`, `ambiguous`, `added` or `failed`.
- Precedence per variable: worktree override > binding > left alone. A template that only
  partly resolves is left alone whole — never a half-expanded URL.
- An override is also the acknowledgement for a binding that legitimately never resolves in
  one worktree. Override values can carry credentials: never print them back.
- `crew run` is how evals, scripts and CLIs crew does not start get the same URLs the dev
  servers got: cwd is the project's checkout, env is resolved, everything after `--` is the
  command untouched (`crew run … -- child --json` keeps the child's flag).

## 5. Workspaces and worktrees

```
crew add workspace <name> [<project>[:<role>] ...] [--role=<role>] [--direct] [--wait]     <project>\t<added|failed>\t<worktree|direct>\t<detail>
crew rm workspace <workspace> <project>                            remove a project from a workspace
crew rm <workspace>                                                the whole workspace, every worktree
crew add worktree <workspace>/<name> [--pull] [--no-install] [--no-smoke] [--wait]
crew duplicate <workspace>[/<worktree>] <new-worktree> [--no-install] [--no-smoke] [--wait]
crew setup <workspace>[/<worktree>] [<project>...] [--no-smoke] [--wait]
crew setup status <workspace>[/<worktree>] [--wait]               ✓|✗|▸ <project>  <step> <took> · <step> <took> · ▸ <running step> | <step> — <reason>
crew setup logs <workspace>[/<worktree>] <project> [--lines=<n>]
crew verify <workspace>[/<worktree>] [<project>...] [--wait]
crew fix <workspace>[/<worktree>] [--print]
crew rm worktree <workspace>/<name>
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
- `add workspace` takes any number of projects in one call — `store-api:"Backend API"
  store-app:"iOS app" checkout-api` — and creates the workspace if it is new. Names are
  checked before anything happens; then the members are recorded and their runners start
  in every worktree of the workspace. `added` means **recorded and installing**, not done —
  the `crew setup status <ws>/<wt>` line is printed per worktree; with `--wait` the rows say
  `added` or `failed` for real and exit 1 on any failure. A checkout or install that fails
  keeps the member, recorded on that worktree. One call, not one per project.
- `--direct` adds the projects by their canonical paths instead of git worktrees — for a repo
  that must not be checked out twice.
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
  recorded as `interrupted` by whoever looks next — never a clean row. In a terminal,
  creation lands on the worktree page, which shows the runners' table live and stays
  **locked** to `f fix with Claude` / `v verify` (plus logs and a shell) while anything is
  recorded or still installing; esc leaves the runners going.
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
  of that worktree, and a second runner for the same project. The error names `crew setup
  status <ref>`; wait for it (`--wait`) and retry. Adding a new project to a busy worktree
  is fine — it is one more runner. `crew rm worktree` and `crew kill` stop the runners.
- `duplicate` is a new worktree of the same projects with the source's overrides copied
  before its runners start; ports are never copied.
- `rm worktree` returns at once: the checkout is renamed into `~/.crew/trash` and deleted in
  the background (a full Xcode build can be 100+ GB). Disk comes back a little later — `crew
  trash` shows what is still clearing.
- `migrate` moves pre-2.0 flat workspaces to the nested layout: backs up, prints the plan,
  moves checkouts with `git worktree move`. Always `--dry-run` first and show the user the
  plan; `--yes` applies without the prompt.

## 6. Dev servers

```
crew dev start <workspace>[/<worktree>] [--proxy]
crew dev stop [<workspace>[/<worktree>]]
crew dev restart <workspace>[/<worktree>] [--proxy]
crew dev logs <workspace>[/<worktree>] <server> [-f|--follow] [--lines=<n>]
crew dev check <workspace>[/<worktree>] [--wait]                  <project>/<server>\t<running|died|not listening>\t<port>\t<took>\t<detail>
crew dev proxy [status|stop]
crew dev tui <workspace>[/<worktree>]                              the worktree page (TUI)
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
- `stop` and `status` with a bare workspace mean all its worktrees.

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

## 7. Launching

```
crew claude <workspace>[/<worktree>]                     Claude Code in this terminal, in the worktree
crew edit <workspace>[/<worktree>] [--editor=cursor|code]   local editor on the worktree, prompt + Claude wired
crew open <workspace>[/<worktree>]                       a shell in the worktree directory
crew code <workspace>[/<worktree>]                       remote-SSH URL for Cursor/VS Code (needs ssh_host)
crew start <workspace>[/<worktree>]                      print the orientation prompt
crew launch [<workspace>[/<worktree>]]                   TUI: with a ref, the worktree page; bare, the workspace list
```

- `claude` and `open` replace the crew process and refuse without a terminal — the user runs
  them, not you (bare `fix` prints instead). `claude` skips permissions, passes every project
  with `--add-dir`, sets `CREW_REF`, and injects the orientation prompt (`crew start` prints
  it): the projects, their roles, and a `## crew` section telling that session to drive the
  servers through crew.
- `edit` opens Cursor (else VS Code) locally; `code` prints a URL for another machine. Both
  say which they are in `crew help`.

## 8. Moving to another machine

```
crew export [<file>] [--all | --projects=<a,b> [--workspaces=<x,y>]]     default file ./crew-export.json
crew import <file> [--plan | --all [--clone] [--replace] [--pull] [--no-install] [--no-smoke] [--wait] | project <name> [--path=<dir>] [--clone[=<dir>]] [--replace] [--name=<new>] [--setup=<cmd>] [--env-cmd=<cmd>] | workspace <name> [--pull] [--no-install] [--no-smoke] [--wait]]
                                                         <project|workspace>\t<name>\t<status|outcome>\t<detail>
```

- A bundle carries projects (path, dev servers, bindings, setup, origin remote) and workspace
  **membership** (projects, roles, modes). Never worktrees, ports or overrides.
- Without flags `export` is a picker: tick projects, then the workspaces those ticks fully
  cover. With `--projects`, every workspace named must be covered by them.
- Bare, `import` is a wizard the user drives: `y` import, `e` edit name/path/setup, `c` clone
  the remote (the path field opens prefilled with crew's guess, enter takes it, or type
  another), `n` skip, `r` replace one already here; then `y` creates each workspace the way
  `crew add worktree` does — the card shows the runners' table until they are done. Every
  `y` is applied at once; `esc` keeps what was done.
- **You drive it with modes.** `--plan` first: one row per item —
  `project\t<name>\texists|path exists|suggested|clone|missing\t<path>` (`suggested` = a
  sibling found beside a repo crew knows, taken automatically — even under `--clone`;
  `clone` = where `--clone` would put it; `missing` = give `--path` or `--clone=<dir>`) and
  `workspace\t<name>\texists|ready|needs\t<members>`. Then per item:
  `crew import <file> project <name> [--path=<dir>] [--clone[=<dir>]] [--replace] [--name=<new>] [--setup=<cmd>] [--env-cmd=<cmd>]`
  prints the same row with the outcome — `imported`, `imported (cloned)`, `replaced`,
  `replaced (cloned)` — and the path; a name already in the pool needs `--replace` (refused
  before anything is cloned). `crew import <file> workspace <name> [--pull] [--no-install]
  [--no-smoke] [--wait]` creates it once every member is in the pool — **exactly the way
  `crew add worktree` makes one**: the base table (`--pull` fast-forwards the local bases
  first; say so when it prints `behind`), then one runner per project in the background;
  the row says `created\tinstalling — crew setup status <name>/main` and you poll that.
  With `--wait` the row carries the verdict: `created … N issue(s) recorded — crew fix
  <name>/main --print`, exit 1. `crew import <file> --all [--clone] [--replace] [--pull]
  …` does the whole bundle: new items only unless `--replace`; missing paths refuse the run
  unless `--clone`; never guesses. Output rows `<kind>\t<name>\t<outcome>\t<detail>`.

## 9. Housekeeping

```
crew trash [empty]
crew ps [--json]
crew kill [--dry-run]
crew config show | crew config set <key> <value> | crew config refresh
crew debug [--tail=<n>]                                  bare: follow the log; --tail prints and returns
crew update
crew uninstall [--purge] [--yes]
crew help [<command>] [<subcommand>] [--json]
```

- `ps` lists crew's tmux sessions and processes that leaked out of them; `kill` stops every
  session and reclaims the leaks (never anything with a live parent) and prints how to
  restore. `--dry-run` first.
- `config set` keys: `server_ip`, `ssh_host`, `proxy_port`, `domain`. A changed `server_ip`,
  `domain` or `proxy_port` takes effect on the next `dev start|restart --proxy`. `refresh`
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
4. Tell them: `crew launch store-front/wrk3`, or `crew claude store-front/wrk3`.

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
1. Here: `crew export ~/Desktop/crew.json --all` (or the picker, user-run).
2. There: `crew import ~/Desktop/crew.json --plan` — read every row. Then per project:
   `path exists`/`suggested` → `crew import … project <name>`; `clone` → `… --clone`;
   `missing` → ask where the repo is or should go, then `--path=` or `--clone=<dir>`;
   `exists` → leave it, or `--replace` if the user wants the bundle's servers and bindings.
   Then `crew import … workspace <name> --pull` for each `ready` one — it makes the `main`
   worktree the way `add worktree` does (base table, then the runners in the background)
   and returns; poll `crew setup status <name>/main` and act on the first `✗` while the
   rest install; relay the final table and any `crew fix … --print` line. `--all --clone
   --pull` is the one-shot when every row is plain; add `--wait` to have it block.

**"Disk is full"**
1. `crew trash` — anything still clearing? `crew trash empty` finishes it now.
2. `crew ls worktrees --size` — which worktree; build output inside a checkout is what grows.
3. `crew rm worktree <ws>/<wt>` for one that is done — returns at once, clears in background.

## Rules

- A ref is `ws/wt`; print `ws--wt` only when quoting a hostname or tmux session.
- Relay `left alone` and `!` lines from `crew dev start` verbatim.
- Never paste `crew env` output into a file; use `crew run`.
- Never print override values or binding-resolved values that look like credentials.
- Destructive, confirm first: `rm <ws>`, `rm worktree`, `rm project`, `uninstall --purge`,
  `trash empty`, `migrate` (dry-run and show the plan), `kill`.
- TUI commands and process-replacing ones (`claude`, `open`, bare `fix`) are for the user to
  run; give them the exact line. Everything they do has a flag form above — use that.
