---
name: crew
description: >
  Reference for driving crew — workspaces, worktrees, dev servers with stable per-worktree
  ports, env bindings, and running scripts with the same env. Use whenever the user mentions
  crew, a workspace, a worktree, dev servers, bindings, or asks to launch or set up a
  working copy of their projects.
user-invocable: true
---

# crew

`crew` is a CLI + TUI. Every list command prints tab-separated rows; `--json` works anywhere.
`crew help <cmd> [<sub>]` is authoritative when unsure. Never guess — run the command.

## Model, in four words

- **Project** — a repo in the pool: path, dev servers, bindings, optional setup command.
- **Workspace** — membership: which projects, with which roles. Config only.
- **Worktree** — a working copy of a workspace's projects. One git worktree per project under
  `~/.crew/workspaces/<ws>/<wt>/<project>`, branch `crew/<ws>/<wt>/<project>`. Keeps its dev
  server ports across restarts.
- **Ref** — `<workspace>/<worktree>`. A bare `<workspace>` works when it has one worktree.

Commands that start something take a ref. `crew dev stop` and `crew dev status` accept a bare
workspace to mean all of its worktrees.

## Bindings — why localhost URLs are crew's job

Projects reach each other over localhost. Ports are allocated by crew, so no static value in a
`.env` can be right. A **binding** on a project declares the variable and a template:

```
crew add binding ai-tutor-api --var=SPEAK_API_URL --url=speak-api
crew add binding ai-tutor-api --var=LIVEKIT_URL --value='ws://{{livekit.host}}/rtc'
crew add binding ai-tutor-api --var=LIVEKIT_AGENT_NAME --value='{{worktree}}'
crew add binding ai-tutor-api --scan            # propose from the project's own .env
crew add binding ai-tutor-api --scan --apply
crew ls bindings ai-tutor-api --check=phone-speak/wrk1
```

Tokens: `{{proj}}` → `http://localhost:<port>`; `{{proj.host}}` → `localhost:<port>` (for
`ws://`, `https://`, a path); `{{proj.port}}` → the number; `{{proj/server}}` when the project
has several servers, `.host`/`.port` after it; `{{worktree}}`, `{{workspace}}` → the names.
Older bindings may still read `{{url:proj}}` / `{{port:proj}}` — same meaning, still valid. At `crew dev start`, bindings resolve against the
allocated ports and are exported into each server's env. A worktree **override** wins over a
binding (`crew add override <ws>/<wt> VAR=value`) and is also the acknowledgement for a binding
that legitimately never resolves in one worktree.

Env files are never rewritten by crew.

## The commands

### Look around
```
crew ls workspaces                       name  projects  worktrees
crew ls worktrees [<ws>]                 ws/wt  path  [dev]      ← "what do I have checked out"
crew ls projects                         name  path
crew show <ws>/<wt>                      project  path  mode  role
crew dev status [<ws>[/<wt>]]            ws/wt  server  port  url
crew ls bindings <project>
```

### Start, resolve, run
```
crew dev start <ws>/<wt> [--proxy]       stable ports; --proxy adds LAN hostnames
crew dev restart|stop <ws>/<wt>
crew dev logs <ws>/<wt> <server> [-f]
crew env <ws>/<wt> <project>             KEY=VALUE on stdout (eval-able); table on stderr
crew run <ws>/<wt> <project> -- <cmd…>   run a script/eval with the same env, cwd = checkout
```

**Read the end of `crew dev start` and relay it verbatim.** After the URLs it prints a
resolution count, then anything left alone, then `!` conflict blocks — an env value pointing at
a port crew gave to something else, or at a sibling's configured port while it actually runs
elsewhere. Servers still start; the block is the one place a wrong URL becomes visible before
it fails at runtime. `crew env` shows the full table.

### Worktrees
```
crew add worktree <ws>/<name> [--pull] [--no-install] [--no-smoke]
crew rm worktree <ws>/<name>
crew duplicate <ws>/<wt> <new-wt>
crew setup <ws>/<wt>                     re-run installs after a failure
```

`add worktree` shows each project's base branch and how far behind origin it is (`--pull`
fast-forwards the local bases; never touches a checked-out feature branch), checks out,
copies `.env` from the canonical repo or a sibling worktree, installs (`mise install`, then
the lockfile's package manager or the project's setup command), and smoke-starts the servers
— a server that dies within seconds is reported with its last log lines. Warnings, not blocks.

### Projects and workspaces
```
crew add project <name> <path> [--setup=<cmd>]     --setup replaces lockfile detection
crew add workspace <name> [<project> --role=<r> [--direct]]
crew rm workspace <ws> <project>
crew rm <ws>
```

### Launch
```
crew launch <ws>/<wt>        the worktree page (TUI): servers, launch, open
crew <ws>/<wt>               same
crew code <ws>/<wt>          Cursor / VS Code remote-SSH URLs (needs ssh_host)
crew start <ws>/<wt>         print the orientation prompt for a multi-project worktree
```

`crew launch` takes over the terminal — the user runs it, not you.

### Everything else
```
crew migrate [--dry-run]     move pre-2.0 workspaces to the nested layout (backs up first)
crew ps / crew kill          process inventory and reclaim
crew config show|set         server_ip, domain, ssh_host, proxy_port
crew update / crew uninstall [--purge]
```

## Typical flows

**"Set up a second working copy of phone-speak"**
1. `crew ls worktrees phone-speak` — see what exists.
2. `crew add worktree phone-speak/wrk3 --pull` — read the base table; relay the smoke result.
3. Tell them: `crew launch phone-speak/wrk3`.

**"Why is service X talking to the wrong thing?"**
1. `crew env <ws>/<wt> <project>` — what crew resolved and what it left alone.
2. `crew ls bindings <project>` — is the edge declared? If not, `--scan`.
3. `crew dev restart <ws>/<wt>` — read the `!` block.

**"Run the evals with the right URLs"**
`crew run <ws>/<wt> ai-tutor-api -- make eval`

**"Dev servers for a new project"**
`crew dev add <project> --name=<n> --port=<p> --cmd="<c>" [--dir=<d>]` — the port is reference
only; crew passes `$PORT`. Then `crew add binding <project> --scan`.

## Rules

- A ref is `ws/wt`; only ever print `ws--wt` when quoting a hostname or tmux session.
- Relay `left alone` and `!` lines from `crew dev start` verbatim.
- `crew migrate` moves git worktrees on disk: `--dry-run` first, show the user the plan.
- `crew uninstall --purge` deletes every checkout — confirm with the user.
- Prefer `crew run` to pasting `crew env` output anywhere; values are point-in-time.
