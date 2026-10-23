# Install and your first worktree

This takes you from nothing to the same store running twice on one machine, each copy on its own
branches, its own ports and its own `.env`. I use two repos throughout: `store-front`, a React app
on Vite, and `store-api`, a FastAPI service with a background worker. Your own repos work the same
way.

Everything here can be done on crew's page or in the terminal. I show the page first and the
command it runs right under it, with the output it really prints, so you can pick either and
switch whenever you like.

## Before you start

crew runs on macOS and Linux. It needs:

- **git**, because every project and every worktree is a git checkout.
- **tmux**, because dev servers, setup runners and checks all run in tmux sessions.
- **Claude Code**, for the sessions in each worktree and for Voice OS. crew itself works without it,
  and any agent with a shell can drive it.
- **mise activated in your shell**, if your projects use mise.

That last one bit me, so it gets its own paragraph. crew runs a checkout's install through
`mise exec`, so the install always finds the right node or python. Dev servers run in your normal
login shell though, and if mise isn't activated there, `npm run dev` or `uv run` simply isn't on
the PATH. The smoke start then reports the server as died with `command not found` (you'll see
exactly that [further down](#when-something-fails)). Activate it once:

```bash
echo 'eval "$(mise activate zsh)"' >> ~/.zshrc   # or bash, fish
```

## Install crew

```bash
curl -fsSL https://raw.githubusercontent.com/FurlanLuka/crew/main/install.sh | sh
```

Then ask crew what it thinks of the machine:

```
$ crew doctor
tmux	ok	required	dev servers, setup runners and checks run in tmux	brew install tmux
git	ok	required	projects and worktrees are git checkouts	xcode-select --install
claude	ok	optional	Voice OS and crew claude run Claude Code	curl -fsSL https://claude.ai/install.sh | bash, then run claude once to sign in
```

Anything missing has its install command in the last column. `crew doctor --install` runs them
for you after asking.

## Open the page

```bash
crew
```

Bare `crew` starts crew's server if it isn't running and opens its page in the browser. Over SSH,
without a terminal or with `--no-open` it prints the link instead. The first time, the page opens
on the first run with three ways in: **Import** (an export from another machine), **Set it up step
by step** and **Skip**.

![The first run: the crew wordmark and three ways in, Import, Set it up step by step and Skip](../images/tutorials/first-run.png)

Pick **Set it up step by step**.

## Add the projects

The first step, **Pick your projects**, lists the git checkouts crew found in your usual code
folders (`~/code`, `~/projects`, `~/dev`, `~/src`, `~/Developer`, `~/work`, `~/repos`). Each one
you tick is cloned fresh from its remote into crew's own folder, `~/.crew/projects/<name>`. Your
checkout is never touched. That matters later: crew's worktrees branch from its own clone, so
nothing it does lands in the repo you already work in.

My two repos aren't on this machine yet, so I use **Add by URL**:

![Pick your projects with the Add by URL field open, the git URL of store-front filled in and the Add store-front button under it](../images/tutorials/add-by-url.png)

That's this command:

```
$ crew add project store-front git@github.com:FurlanLuka/store-front.git
Cloning git@github.com:FurlanLuka/store-front.git → ~/.crew/projects/store-front
Added project: store-front (~/.crew/projects/store-front)
New checkouts will run: mise install → npm ci
```

The last line is crew telling you how it will install every new checkout. It found a `mise.toml`
and a `package-lock.json`, so it's `mise install` then `npm ci`. For `store-api` it reads
`uv.lock` and says `mise install → uv sync`. The lockfiles it knows are `uv.lock`,
`pnpm-lock.yaml`, `yarn.lock`, `bun.lock` and `package-lock.json`. When that isn't enough,
`--setup="make sync"` replaces the detection (mise still runs first). If you already have a
checkout you'd rather crew use as is, `--path=<dir>` adopts it instead of cloning.

The git remote is the project's identity from here on. `crew ls projects` shows it in the third
column:

```
$ crew ls projects
store-front	~/.crew/projects/store-front	git@github.com:FurlanLuka/store-front.git
store-api	~/.crew/projects/store-api	git@github.com:FurlanLuka/store-api.git
```

## Tell crew how each project runs

At this point crew only knows each repo and its detected install. The env command, the dev
servers and the Environment are up to you. On the page they live on the project's form in Set up
(**Go to Set up** at the end of the first run, click the project, **Edit setup**), so there you'd
add them once the first run is done and then press **Verify** on the worktree. In the terminal I add
them now, before the workspace exists, so `main`'s first smoke already covers them.

![store-api's Edit setup form: the env command scripts/get-env.sh, the dev servers api on port 8000 and worker with no port, and CORS_ORIGIN in its Environment](../images/tutorials/project-form.png)

### The env command

`store-api` reads its secrets from `.env`. At work that file would come out of a vault or sops; in
this repo `scripts/get-env.sh` writes it, standing in for that. An env command runs in every new
checkout after the install:

```
$ crew add project store-api --env-cmd=scripts/get-env.sh
Env command for store-api: scripts/get-env.sh
```

It has to write files, never print values, because its output goes into the install log. Before it
runs, crew has already copied the `.env` from the canonical repo (or a sibling worktree), so the
env command only overwrites what it needs to.

### Dev servers

A dev server is a name, a command and a port. The one rule crew has for your code is that the
command listens on `$PORT`. crew gives every server in every worktree its own port and runs the
command with `PORT=<n>` set, so two copies never fight over 5173. The port you type is a reference
only, for scans and conflict checks.

```bash
crew dev add store-front --name=web --port=5173 --cmd="npm run dev"
crew dev add store-api --name=api --port=8000 --cmd='uv run uvicorn app.main:app --reload --port $PORT'
```

`store-front`'s `vite.config.ts` sets the port from `process.env.PORT`, so plain `npm run dev` is
enough. Yours might need `-p $PORT` on the command instead.

`store-api` also has a worker that pulls jobs and never listens on anything. Leave the port out and
crew knows that:

```
$ crew dev add store-api --name=worker --cmd="uv run python -m app.worker"
Added dev server 'worker' to store-api (no port — it does not listen)
```

A port-less server runs with no `PORT` and gets no URL, and when crew checks it, staying alive is
the whole test. If I'd given it a port, crew would wait a minute for something to answer on it
and report it as not listening.

### Bindings

The front needs the API's URL, and that URL is different in every worktree. A binding says how to
compute it, once, on the project that needs the value:

```
$ crew add binding store-front --var=VITE_API_URL --url=store-api/api
Bound VITE_API_URL for store-front to {{store-api/api}}
```

`{{store-api/api}}` becomes `http://localhost:<the port api got in that worktree>` when the
servers start. I name the server because `store-api` has two. The other direction is the same
idea, with no server name because `store-front` has only one:

```bash
crew add binding store-api --var=CORS_ORIGIN --url=store-front
```

[How crew works](../concepts.md#bindings) has the whole template list, `.host`, `.port`,
`{{worktree}}` and friends.

On the page, each Environment line shows the value it would get in every worktree before you save
it:

![store-api's Environment form: CORS_ORIGIN from store-front's URL for every server, previewing http://localhost:54010 in store/main and http://localhost:54030 in store/wrk1](../images/tutorials/binding-preview.png)

In the terminal that's `--dry-run`, which saves nothing and prints one line per worktree:

```
$ crew add binding store-front --var=VITE_API_URL --url=store-api/api --dry-run
store/main	http://localhost:56354	running
```

(This is from later, once `store/main` existed. Before there's a worktree, there's nothing to
preview.) `crew ls bindings store-front --preview` does the same for the bindings you already have.

`crew add binding <project> --scan` reads the project's `.env` and proposes bindings for values
that point at local ports. It reads `.env`, not `.env.example`, so on a fresh clone it usually has
nothing to say.

## Make the workspace

A workspace is the set of projects you work on together. The first run's next step, **Make a
workspace**, asks for a name and the projects, and shows the session it will make:

![Make a workspace: the name store, store-front and store-api ticked, and "your session: store/main" under the name](../images/tutorials/workspace-step.png)

```bash
crew add workspace store store-front store-api
```

Creating it also makes its first worktree, `main`. For each project crew makes a git worktree on
its own branch (`crew/store/main/store-front`), copies the `.env` in, runs the install and the env
command, then smoke-starts that project's servers to see that each one comes up. It does this with
one runner per project, in the background, so the command returns at once and the slowest project
sets the pace.

The page follows the runners on **Getting store/main ready**, one row per project with the step
it is on, and moves on by itself:

![Getting store/main ready: the progress line Projects, Workspace, Getting it ready; a bar about half full; store-front running npm ci after checkout and mise install, store-api running uv sync](../images/tutorials/project-setup.png)

The first run's rows stop at the install because, on the page, nothing else is set up yet. In the
terminal, with the env command and servers already added, the same runners go further:

```
$ crew setup status store/main
  ✓ store-front  checkout 0s · mise install 5s · npm ci 1s · smoke web 2s
  ✓ store-api    checkout 0s · mise install 2s · uv sync 2s · env: scripts/get-env.sh 0s · smoke api 6s · smoke worker 6s
```

Add `--wait` to stay until the last runner is done. `crew setup logs` is what a runner printed,
which is where to look when a step takes long:

```
$ crew setup logs store/main store-api --lines=12
[09:13:11] ▸ mise install
[09:13:13] ✓ mise install 2s
[09:13:13] ▸ uv sync
[09:13:15] ✓ uv sync 2s
[09:13:15] ▸ env: scripts/get-env.sh
wrote .env (2 values)
[09:13:16] ✓ env: scripts/get-env.sh 0s
[09:13:16] ▸ smoke api
[09:13:16] ▸ smoke worker
[09:13:21] ✓ smoke api 6s
[09:13:21] ✓ smoke worker 6s
[09:13:22] done
```

When both are green the first run says so:

![store/main is ready: 2 projects checked out and installed, with Open Voice OS highlighted and Go to Set up beside it](../images/tutorials/ready.png)

**Open Voice OS** is [tutorial 2](2-voice-os.md). For now I stay in the terminal.

## Run it

```
$ crew dev start store/main
Dev servers for store/main
  http://localhost:56353
  http://localhost:56354
Resolved env  2 vars across 2 projects
Session: crew-dev-store--main
```

Two URLs for three servers, because the worker has none. `dev start` returns as soon as the panes
are up, so the next thing to run is `dev check --wait`, which watches each server until it listens,
dies or a minute passes:

```
$ crew dev check store/main --wait
store-front/web	running	56353	0s
store-api/api	running	56354	0s
store-api/worker	running	-	0s
```

`crew dev status` shows what's running, with the configured port next to the one it actually got:

```
$ crew dev status store/main
store/main	web	5173	http://localhost:56353
store/main	api	8000	http://localhost:56354
store/main	worker	-	-
```

And `crew dev logs store/main api` prints a server's log (`-f` follows it, `--lines=50` is just the
end). Logs start fresh on every start.

## The worktree page

All of this is on the worktree's page in Set up too (the board, then **store**, then **main**). Its
Dev servers card says what's going on, "Running · 3 of 3 listening" here, with **Stop**,
**Restart** and **Verify**, and lists each server with its command and URL. The worker has no URL,
only the word that it answered.

![The Set up page for store/main: Running, 3 of 3 listening, with Stop, Restart and Verify; web, api and worker with their commands, the first two with localhost URLs; What each server gets open on store-front, with VITE_API_URL from {{store-api/api}}; On disk 1.5 GB](../images/tutorials/worktree.png)

The Environment card under it, opened on **What each server gets**, is the final env server by
server. Click a server and its log opens beside the list and follows it:

![The same page with api's log open beside the server list, showing Uvicorn starting on its port and requests like GET /products?q=mug and POST /orders](../images/tutorials/worktree-logs.png)

The terminal has a worktree page of its own, `crew launch store/main` (or just `crew store/main`).
That one is for launching, with **Editor + Claude**, **Claude in terminal**, the remote editor and
**Shell here**, the servers read-only under them and `l` for their logs. It starts and stops
nothing.

## The env, outside the servers

The servers got their bindings at start. To see what a project gets, `crew env` prints it:

```
$ crew env store/main store-front
VITE_API_URL=http://localhost:56354
```

stdout is plain `KEY=VALUE`, so you can `eval` it. Those values go stale when servers restart
though, so for tests and scripts I use `crew run`, which runs the command in the project's checkout
with exactly that env:

```
$ crew run store/main store-api -- uv run pytest -q
..   2 passed in 0.01s
```

## A second worktree

This is the point of all of it. A second copy of the whole store, on its own branches, running at
the same time:

```
$ crew add worktree store/wrk1 --wait
Branching from

  store-front  main        up to date
  store-api    main        up to date

Creating store/wrk1
  ✓ store-front  checkout 0s · mise install 0s · npm ci 1s · smoke web 2s
  ✓ store-api    checkout 0s · mise install 0s · uv sync 0s · env: scripts/get-env.sh 0s · smoke api 2s · smoke worker 2s

Created store/wrk1

  store-front	~/.crew/workspaces/store/wrk1/store-front
  store-api	~/.crew/workspaces/store/wrk1/store-api

crew launch store/wrk1
```

The table at the top is each project's base branch and how far it is behind origin. `--pull`
fast-forwards them first. Then start it next to `main`:

```
$ crew dev start store/wrk1
Dev servers for store/wrk1
  http://localhost:56463
  http://localhost:56464
Resolved env  2 vars across 2 projects
Session: crew-dev-store--wrk1

$ crew dev status
store/main	web	5173	http://localhost:56353
store/main	api	8000	http://localhost:56354
store/main	worker	-	-
store/wrk1	web	5173	http://localhost:56463
store/wrk1	api	8000	http://localhost:56464
store/wrk1	worker	-	-
```

Each copy talks to its own API, because the binding resolved against its own ports:

```
$ crew env store/wrk1 store-front
VITE_API_URL=http://localhost:56464
```

A worktree keeps its ports, so a restart lands on the same ones. Now one Claude can fix search in
`wrk1` while `main` stays as it was.

## When something fails

Creating a worktree never stops halfway. A step that fails is recorded on the worktree with its
evidence, and the other runners carry on. Here's my first try, before mise was active in my shell:

```
  ✗ store-front  checkout 0s · mise install 5s · npm ci 1s · smoke web — died
  ! smoke     store-front/web
      zsh: command not found: npm
    crew fix store/main     Claude in the worktree with this failure
    crew verify store/main  finish what is missing and check again
```

The install worked, because it ran through mise. The server didn't, because my shell had no npm.
`crew ls worktrees` and the page both show the failure until something clears it.

The two lines at the bottom are the way out. `crew fix store/main` opens Claude in the worktree
with the failure, its log lines and the instruction to fix it and verify (`--print` writes that
prompt to stdout instead, for an agent that's already there). `crew verify store/main` finishes
whatever is missing, installs again where the install failed, smoke-starts every server and clears
the record when it passes:

```
$ crew verify store/main --wait
Verifying store/main
  ✓ store-front  smoke web 2s
  ✓ store-api    checkout 0s · mise install 2s · uv sync 2s · env: scripts/get-env.sh 0s · smoke api 6s · smoke worker 6s
store/main checks out — unlocked
```

`crew verify store/main store-front` re-checks only the project you fixed. Verify refuses while
the worktree's servers run, since it would restart them, so stop them first with
`crew dev stop store/main`.

## Next

[Tutorial 2](2-voice-os.md) opens Voice OS on these worktrees and fixes the search bug by talking
to them. For the page in detail see [Set up](../guides/setup.md), for the model underneath
[how crew works](../concepts.md), and for every flag [the command reference](../commands.md).
