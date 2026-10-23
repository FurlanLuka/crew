# Everyday commands and keeping things tidy

By now you have a workspace, a couple of worktrees and probably Voice OS. This is the rest of what
I use day to day, one short section each, with the output crew really prints. It's the `store`
workspace from [tutorial 1](1-install-and-first-worktree.md) again, with `store/main` and
`store/wrk1`. Everything here is also on crew's page ([Set up](../guides/setup.md)), and
[the command reference](../commands.md) has every flag.

## Worktrees

A new worktree is a fresh copy of every project in the workspace, on its own branches and ports:

```bash
crew add worktree store/wrk2 --pull --wait
```

`--pull` fast-forwards each project's local base branch from origin first. It never touches a
branch you have checked out.

`crew duplicate` makes a new worktree from an existing one. The checkouts are fresh, but the
overrides of the source come along (more on those [below](#overrides)):

```
$ crew duplicate store/wrk1 wrk2 --wait
Duplicating store/wrk1 → store/wrk2
  ✓ store-front  checkout 0s · mise install 0s · npm ci 1s · smoke web 1s
  ✓ store-api    checkout 0s · mise install 0s · uv sync 0s · env: scripts/get-env.sh 0s · smoke api 2s · smoke worker 2s

Duplicated store/wrk1 → store/wrk2
```

Once I know what a worktree is for, I give it a name that says so:

```
$ crew rename worktree store/wrk2 search-fix
Renamed store/wrk2 → store/search-fix
shells, editors and agents opened on the old paths still hold them — crew claude store/search-fix / crew edit store/search-fix reopen on the new ones
crew verify store/search-fix re-checks it if anything baked the old path
```

It moves the directory and renames crew's branches (`crew/store/wrk2/store-api` becomes
`crew/store/search-fix/store-api`). The ports, overrides and any recorded failure go with it. It
refuses while the worktree's servers or a setup runner are alive, so stop them first. A branch you
already pushed keeps its old name on the remote.

Before removing a worktree, `--dry-run` says what you'd lose:

```
$ crew rm worktree store/search-fix --dry-run
store/search-fix	store-front	~/.crew/workspaces/store/search-fix/store-front	0 uncommitted	0 commits not on the base	79 MB
store/search-fix	store-api	~/.crew/workspaces/store/search-fix/store-api	0 uncommitted	0 commits not on the base	28 MB

$ crew rm worktree store/search-fix
Removed worktree store/search-fix
```

Removal returns at once. The checkouts go to crew's trash and are deleted in the background, and
the `crew/store/search-fix/*` branches are deleted. Commits that weren't on the base stay in the
repo's reflog if you need them back. crew won't remove a workspace's last worktree this way.

## Overrides

A binding computes a value for every worktree. An override pins one variable in one worktree,
and wins over any binding:

```
$ crew add override store/wrk1 VITE_API_URL=http://localhost:9999
Override VITE_API_URL in store/wrk1

$ crew ls overrides store/wrk1
VITE_API_URL	http://localhost:9999

$ crew rm override store/wrk1 VITE_API_URL
Removed override VITE_API_URL from store/wrk1
```

I use them for a worktree that should talk to a shared staging API, or for a test key one copy
needs. When two projects in the workspace read the same variable, `store-front.VITE_API_URL=…`
pins it for one of them. Servers read the new value on their next start.

## Scoped bindings

A binding on the bare project reaches every one of its servers. Name a server and it reaches only
that one, and wins there over a project-wide binding of the same variable. That's how a monorepo's
web app and its worker get different siblings. With `--dry-run`, crew shows what the worker would
get in each worktree and saves nothing:

```
$ crew add binding store-api/worker --var=STORE_URL --url=store-front --dry-run
store/main	http://localhost:56353	running
store/wrk1	http://localhost:56463	running
```

Drop `--dry-run` to save it. `crew env store/main store-api/worker` is then what that server gets,
and `crew run store/main store-api/worker -- <cmd>` runs a command with exactly that env.
[How crew works](../concepts.md#bindings) has the precedence spelled out.

## Checking a project from nothing

When I change a project's install, env command or servers, I want to know that a clean checkout
still comes up, without touching any worktree I work in. `crew check project` does exactly that, on
a scratch checkout of its own:

```
$ crew check project store-api --wait
Branching from

  store-api  main        up to date

  ✓ store-api  checkout 0s · mise install 0s · uv sync 0s · env: scripts/get-env.sh 0s · smoke api 2s · smoke worker 2s

check store-api passed — target removed
```

A pass cleans up after itself. A failure stays as `check/store-api` with its evidence, so
`crew fix check/store-api` opens Claude on it and `crew verify check/store-api` re-runs it in
place. `--status` says where it stands without starting one:

```
$ crew check project store-api --status
store-api	passed	1 minute ago
```

## Moving to another machine

`crew export` writes the projects (by git remote, with their servers, bindings, install and env
commands) and which projects each workspace has. Worktrees, ports, overrides and `.env` files stay
behind.

```
$ crew export
Wrote crew-export.json — 2 projects, 1 workspace
```

On the other machine, `crew import` with only the file shows the plan and changes nothing:

```
$ crew import crew-export.json --plan
project	store-front	exists	~/.crew/projects/store-front
project	store-api	exists	~/.crew/projects/store-api
workspace	store	exists	
```

That's what the plan looks like on a machine that already has everything. On a new one the rows
say `clone` and where to. Then `crew import crew-export.json --all --pull` clones every project
and makes each workspace with its `main` worktree, or `project <name>` and `workspace <name>` do
one at a time. If you already have one of the repos checked out, the plan says `found` with its
path, and `project <name> --path=<it>` uses that instead of a second clone. The page walks the
same plan ([Moving to another machine](../guides/setup.md#moving-to-another-machine)).

`crew export -` and `crew import -` use stdout and stdin, handy over SSH.

## Trash and clean

Removed checkouts go to `~/.crew/trash` and are deleted in the background, because a checkout with
a full build in it can be huge. `crew trash` shows what's still clearing:

```
$ crew trash
~/.crew/trash	102 MB	2 entries	clearing in background — crew trash empty deletes now
```

Every crew command also sweeps up leftovers at most once an hour: failed checks older than a week,
logs and runner files of worktrees that are gone, stale locks, the trash. `crew clean` runs that
now and adds a `git worktree prune` on every project. Look first:

```
$ crew clean --dry-run
prune	~/.crew/projects/store-api	would prune
prune	~/.crew/projects/store-front	would prune
trash	~/.crew/trash	would remove
```

## What's running, and stopping all of it

`crew ps` lists crew's tmux sessions and their processes, one row each, and ends with a count:

```
$ crew ps
session	15631	crew-dev-store--main	npm run dev
session	15646	crew-dev-store--main	uv run uvicorn app.main:app --reload --port 56354
session	15653	crew-dev-store--main	uv run python -m app.worker
…
crew: 13 processes · user total 617/2666
```

`crew kill` stops every crew session at once and reclaims processes that leaked out of them, and
prints how to bring back what it stopped. A process whose parent is still alive (your editor's
terminal, a Claude session) is left alone, and so is crew's server. `--dry-run` shows the list:

```
$ crew kill --dry-run
session  crew-dev-store--main (13 processes)
session  crew-dev-store--wrk1 (13 processes)

24 process(es) in the workspace tree still have a live parent and are left alone.

--dry-run: nothing was killed.
```

For one worktree, `crew dev stop store/wrk1` is enough. Bare `crew dev stop` stops every dev
server.

## Launching

- `crew launch` with no ref is a picker over every worktree. Enter opens its worktree page.
- `crew launch store/wrk1`, or the shortcut `crew store/wrk1`, opens the worktree page directly:
  **Editor + Claude**, **Claude in terminal**, the remote editor and **Shell here**.
- `crew claude store/wrk1` is **Claude in terminal** as a command: Claude Code in the worktree,
  every project added, the orientation prompt that tells it where it is and how to drive the
  servers.
- `crew edit store/wrk1` opens Cursor (else VS Code) on the worktree with Claude wired up.
  `--editor=code` picks one.

These need a terminal. Without one, crew says what to run instead, and `crew start store/wrk1`
prints the orientation prompt for any other agent.

## Updating crew

```
$ crew update --check
crew v6.10.0 — up to date (latest v6.10.0)
```

`crew update` installs the latest release, and Voice OS with it. It never restarts a running
server, so the new Voice OS starts on your next `crew server restart`. Machines you've added to
Voice OS don't need their own update: when a remote runs an older crew than the main, the main
updates it over SSH, once per version, and never downgrades one.

## The proxy

By default every server is `http://localhost:<port>`. `crew dev start store/wrk1 --proxy` also
serves each one by name, `http://<server>--<workspace>--<worktree>.<domain>`, through one shared
reverse proxy, so a phone on the same network can open them. `crew dev proxy` is that proxy:

```
$ crew dev proxy status
down	192.168.1.144.nip.io	80	http://192.168.1.144/	https not listening	443
```

`crew dev proxy trust` prints crew's certificate and how to trust it on a Mac, iPhone or Android
(needed once per device, for the microphone in Voice OS on a phone), `trust --install` trusts it on
this Mac, and `crew dev proxy stop` stops the proxy alone while the servers keep running on their
ports. When a proxied URL opens here but not on the phone, `crew help dev start` has the
two-minute diagnosis, and [Other devices](../concepts.md#other-devices) explains why.
