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

Everything crew does is a command. List commands print tab-separated rows; `--json` works on
any command, in any position. `crew help <cmd> [<sub>]` is authoritative; `crew help --json`
dumps the whole tree. Never guess state — run the command.

A few commands open a full-screen TUI and are the **user's to run**, not yours: `crew
workspace`, `crew project`, `crew config` (bare), `crew launch`, `crew dev tui`, `crew debug`,
`crew export` without flags, `crew import` without `--all`. Everything below is scriptable.

## 1. Model

- **Project** — a repo in the global pool: name, path, dev servers, **bindings**, optional
  setup command, all shared by every workspace it appears in.
- **Workspace** — membership: which projects, with which roles. Config only.
- **Worktree** — one working copy of a workspace's projects: a git worktree per project under
  `~/.crew/workspaces/<ws>/<wt>/<project>`, branch `crew/<ws>/<wt>/<project>`. Owns its
  reserved **ports** (kept across restarts) and its **overrides**.
- **Ref** — how you name a worktree: `<ws>/<wt>`, or bare `<ws>` when it has one worktree.
  `ws--wt` is the slug crew uses in hostnames, log dirs and tmux sessions; never type it.
- **Binding** — `{var, template}` on a project. Resolved against the worktree's ports at
  `crew dev start` and exported into each server's env. Env files are read, never written.

## 2. Read state

```
crew ls workspaces                                         <name>\t<n> projects\t<worktree>,<worktree>
crew ls worktrees [<workspace>] [--size]                   <workspace>/<worktree>\t<path>\t[<size>\t][dev]
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
```

- `ls worktrees` is "what do I have checked out". `--size` walks every file — slow on a
  worktree with a full build inside; say so before running it on a big one.
- `env` prints resolved `KEY=VALUE` on stdout (eval-able); the table and anything left alone
  go to stderr. Values are point-in-time — resolve at run time with `crew run` instead of
  pasting them anywhere.
- `dev status` with no ref covers every worktree; a bare workspace means all its worktrees.

## 3. Projects and dev servers

```
crew add project <name> <path> [--setup=<cmd>]
crew add project <name> [--setup=<cmd>] [--path=<dir>]         re-run on an existing project updates it
crew rm project <name>
crew dev add <project> --name=<name> --port=<port> --cmd=<command> [--dir=<subdir>]
crew dev rm <project> <server-name>
crew dev setup <project>                                       interactive detection of package.json scripts
```

- Project names: `a-z 0-9 -`, and not `worktree`, `workspace`, `url`, `host`, `port` — they
  are token words.
- `--setup` is the install command for a fresh checkout when the lockfile alone is not the
  answer (`make sync` for a repo that also pulls model weights). Without it crew detects
  `uv sync`, `pnpm install`, `npm ci` or `yarn` from the lockfile; `mise install` runs first
  either way.
- `--path` on an existing project: the repo moved. Worktrees already made keep working.
- `dev add` on an existing server name replaces it. The port is **reference only**: crew
  allocates a free port per worktree and passes it as `$PORT`; the configured one is what
  `.env` files and bindings are matched against.

## 4. Bindings and overrides

Projects reach each other over localhost, and crew allocates the ports, so no static value
in a `.env` can be right. A binding says which variable, and a template says how:

```
{{speak-api}}                  http://localhost:<port>        the project's one server (URL)
{{speak-api.host}}             localhost:<port>               for ws://, https://, a path: ws://{{speak-api.host}}/rtc
{{speak-api.port}}             <port>
{{ai-tutor-api/worker}}        a named server, when the project has several; .host / .port after it
{{worktree}}  {{workspace}}    the names — agent-{{worktree}}, db_{{workspace}}_{{worktree}}
```

A value without tokens is used as-is. `{{url:x}}` / `{{port:x}}` is the pre-2.1 spelling —
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
  the unambiguous ones.
- Precedence per variable: worktree override > binding > left alone. A template that only
  partly resolves is left alone whole — never a half-expanded URL.
- An override is also the acknowledgement for a binding that legitimately never resolves in
  one worktree. Override values can carry credentials: never print them back.
- `crew run` is how evals, scripts and CLIs crew does not start get the same URLs the dev
  servers got: cwd is the project's checkout, env is resolved, everything after `--` is the
  command untouched (`crew run … -- child --json` keeps the child's flag).

## 5. Workspaces and worktrees

```
crew add workspace <name> [<project> --role=<role>] [--direct]     no project: create; with one: add it (re-runnable)
crew rm workspace <workspace> <project>                            remove a project from a workspace
crew rm <workspace>                                                the whole workspace, every worktree
crew add worktree <workspace>/<name> [--pull] [--no-install] [--no-smoke]
crew duplicate <workspace>[/<worktree>] <new-worktree> [--no-install] [--no-smoke]
crew setup <workspace>[/<worktree>] [--no-smoke]
crew rm worktree <workspace>/<name>
crew migrate [--dry-run]
```

- `--direct` adds the project by its canonical path instead of a git worktree — for a repo
  that must not be checked out twice.
- `add worktree` prints each project's base branch and how far behind origin it is; `--pull`
  fast-forwards the local bases first (never touches a checked-out feature branch). Then:
  checkouts (all-or-nothing), `.env` copied from the canonical repo or a sibling worktree,
  installs per project, and a smoke start — servers up for a few seconds, which still run,
  last log lines for the dead ones. Read that output and relay it; a failed install keeps
  the worktree and `crew setup <ref>` re-runs it.
- `duplicate` is a new worktree of the same projects with the source's overrides copied;
  ports are never copied.
- `rm worktree` returns at once: the checkout is renamed into `~/.crew/trash` and deleted in
  the background (a full Xcode build can be 100+ GB). Disk comes back a little later — `crew
  trash` shows what is still clearing.
- `migrate` moves pre-2.0 flat workspaces to the nested layout: backs up, prints the plan,
  moves checkouts with `git worktree move`. Always `--dry-run` first and show the user the plan.

## 6. Dev servers

```
crew dev start <workspace>[/<worktree>] [--proxy]
crew dev stop [<workspace>[/<worktree>]]
crew dev restart <workspace>[/<worktree>] [--proxy]
crew dev logs <workspace>[/<worktree>] <server> [-f|--follow]
crew dev tui <workspace>[/<worktree>]                              the worktree page (TUI)
```

- Every server runs in a tmux window of session `crew-dev-<ws>--<wt>` with `PORT` set and
  the project's resolved bindings exported. URLs are `http://localhost:<port>`; `--proxy`
  adds `http://<server>--<ws>--<wt>.<domain>` for other devices.
- Ports are reserved per worktree and reused on restart, so a URL from `crew env` stays valid.
- **Read the end of `crew dev start` and relay it verbatim.** After the URLs: a resolution
  count, anything left alone, then `!` blocks — an env value pointing at a port crew gave to
  something else, or at a sibling's configured port while it runs elsewhere. Servers still
  start (warn, never block); the block is the one place a wrong URL is visible before it
  fails at runtime.
- `stop` and `status` with a bare workspace mean all its worktrees.

## 7. Launching

```
crew claude <workspace>[/<worktree>]                     Claude Code in this terminal, in the worktree
crew edit <workspace>[/<worktree>] [--editor=cursor|code]   local editor on the worktree, prompt + Claude wired
crew open <workspace>[/<worktree>]                       a shell in the worktree directory
crew code <workspace>[/<worktree>]                       remote-SSH URL for Cursor/VS Code (needs ssh_host)
crew start <workspace>[/<worktree>]                      print the orientation prompt
crew launch [<workspace>[/<worktree>]]                   TUI: with a ref, the worktree page; bare, the workspace list
```

- `claude` and `open` replace the crew process — the user runs them, not you. `claude` skips
  permissions and passes every project with `--add-dir`; a multi-project worktree, or one
  with a direct-mode project, gets the orientation prompt (`crew start` prints it) injected.
- `edit` opens Cursor (else VS Code) locally; `code` prints a URL for another machine. Both
  say which they are in `crew help`.

## 8. Moving to another machine

```
crew export [<file>] [--all | --projects=<a,b> [--workspaces=<x,y>]]     default file ./crew-export.json
crew import <file> [--all]
```

- A bundle carries projects (path, dev servers, bindings, setup, origin remote) and workspace
  **membership** (projects, roles, modes). Never worktrees, ports or overrides.
- Without flags `export` is a picker: tick projects, then the workspaces those ticks fully
  cover. With `--projects`, every workspace named must be covered by them.
- Without `--all`, `import` walks one card per item — the user drives it: `y` import, `e` edit
  name/path/setup, `c` clone the remote (when the path is not here), `n` skip, `r` replace one
  already here; then `y` creates each workspace with a checkout of every member (no
  installs). Every `y` is applied at once; `esc` keeps what was done.
- `--all` imports what is new, keeps what exists, and refuses up front if any path is missing
  — it never guesses a path and never clones.

## 9. Housekeeping

```
crew trash [empty]
crew ps [--json]
crew kill [--dry-run]
crew config show | crew config set <key> <value> | crew config refresh
crew debug                                               the debug log (TUI)
crew update
crew uninstall [--purge]
crew help [<command>] [<subcommand>] [--json]
```

- `ps` lists crew's tmux sessions and processes that leaked out of them; `kill` stops every
  session and reclaims the leaks (never anything with a live parent) and prints how to
  restore. `--dry-run` first.
- `config set` keys: `server_ip`, `ssh_host`, `proxy_port`, `domain`. `refresh` rewrites the
  managed tmux config.
- `uninstall --purge` deletes every checkout — confirm with the user first.

## Flows

**"What do I have?"** — `crew ls worktrees`, then `crew dev status`.

**"Set up a second working copy of phone-speak"**
1. `crew ls worktrees phone-speak`
2. `crew add worktree phone-speak/wrk3 --pull` — relay the base table and the smoke result.
3. Tell them: `crew launch phone-speak/wrk3`, or `crew claude phone-speak/wrk3`.

**"Why is service X talking to the wrong thing?"**
1. `crew env <ws>/<wt> <project>` — what resolved, what was left alone.
2. `crew ls bindings <project>` — is the edge declared? If not: `crew add binding <project> --scan`.
3. `crew dev restart <ws>/<wt>` — read the `!` block.

**"Run the evals with the right URLs"** — `crew run <ws>/<wt> ai-tutor-api -- make eval`.

**"Dev servers for a new project"** — `crew dev add <project> --name=<n> --port=<p>
--cmd="<c>"`, then `crew add binding <project> --scan`.

**"Set crew up on my other machine"**
1. Here: `crew export ~/Desktop/crew.json --all` (or the picker, user-run).
2. There: `crew import ~/Desktop/crew.json` — user drives the cards; missing repos are edited
   or cloned from their remotes. Then `crew add worktree` as needed.

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
- TUI commands and process-replacing ones (`claude`, `open`) are for the user to run; give
  them the exact line.
