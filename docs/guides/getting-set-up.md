# Getting set up: a workspace, its projects, a worktree

This takes you from an empty crew to two copies of your stack running side by side, typed out as
commands. The quickest way is to say it instead: Voice OS's setup session runs these same steps for
you — see [the walkthrough](voice-os.md#from-two-repos-to-a-working-feature). The example is a store
with an API and a web app; use your own repos.

## 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/FurlanLuka/crew/main/install.sh | sh
```

crew needs git and tmux (installed for you on Linux). For agents in the worktrees you'll want
[Claude Code](https://code.claude.com/docs), though any agent with a shell can drive crew.

## 2. Add your projects

A project is a repo crew knows about. Give it a URL and crew clones it; give it `--path` and crew
adopts a checkout you already have.

```bash
crew add project store-api git@github.com:example/store-api.git
crew add project store-app --path=~/code/store-app
```

Tell crew how each one runs. The dev command must listen on `$PORT` — crew hands every copy its
own port, so `next dev -p $PORT`, `uvicorn --port $PORT` or `process.env.PORT`:

```bash
crew dev add store-api --name=store-api --port=3000 --cmd="npm run dev"
crew dev add store-app --name=store-app --port=3001 --cmd="npm run dev"
```

The installs are detected from the lockfile (and `mise`). If a checkout needs more, add
`--setup="make sync"`; if its env files come from a vault, `--env-cmd="make get-env"`.

## 3. Point the services at each other

The web app needs the API's URL, and that URL is different in every copy. A binding says so once:

```bash
crew add binding store-app --scan            # what store-app's .env seems to point at
crew add binding store-app --scan --apply    # add the clear ones
crew add binding store-app --var=API_URL --url=store-api   # or say it yourself
```

At start, `API_URL` becomes `http://localhost:<the port store-api got in that copy>`.

## 4. Prove a project works from nothing

Before building on it, check that a fresh checkout installs and its servers come up:

```bash
crew check project store-api --wait
```

A failure keeps the checkout with its evidence; `crew fix check/store-api` opens Claude on it.

## 5. Make the workspace

A workspace is the set of projects a piece of work touches. Creating it also makes its first
copy, `main`:

```bash
crew add workspace store-front store-api store-app
crew setup status store-front/main --wait    # one runner per project: checkout, install, smoke
```

Each project gets its own git worktree on a `crew/store-front/main/<project>` branch, its `.env`
copied in, its install, and a smoke start of its servers. A failure is recorded with its
evidence; `crew fix store-front/main` hands it to Claude.

## 6. Run it

```bash
crew dev start store-front/main           # servers up on this copy's ports
crew dev check store-front/main --wait    # did each one start listening?
crew claude store-front/main              # Claude, told where it is and how to reach everything
```

The Claude inside knows its worktree and has `crew dev logs`, `crew dev check`, `crew run` (tests
and scripts with the same URLs the servers got) and `crew fix` at hand.

## 7. A second copy

```bash
crew add worktree store-front/wrk1 --pull   # fresh base branches, then a copy of everything
crew dev start store-front/wrk1             # different ports; nothing collides
```

Now two features can move at once, each with its own branches, servers and agent. Add a project
to an existing workspace later with `crew add workspace store-front checkout-api`.

## Or do it all in a TUI

`crew project` → `a` walks a new project through the same steps, one card at a time.
`crew workspace` → `n` makes a workspace and lands on its worktree page. Or, in
[Voice OS](voice-os.md), ask the setup session: "make a worktree in store front for the search
fix".

More: [how crew works](../concepts.md) · [every command](../commands.md) ·
[running crew on a remote VM](remote-vm.md)
