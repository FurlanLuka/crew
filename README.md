# crew

**Talk to your coding agents.** Every feature you're working on gets its own copy of your stack and
its own Claude — and you run them all by voice: "tell checkout to run the tests", "what's waiting
on me?", "yes, but only on staging".

<!-- Demo video: three sessions, spoken commands, "checkout is done". -->

## Try it

```bash
curl -fsSL https://raw.githubusercontent.com/FurlanLuka/crew/main/install.sh | sh
crew voice
```

The first `crew voice` checks you have tmux and Claude Code, downloads Voice OS, and asks for an
Anthropic key and a Soniox key — checked before they're saved, stored only on this machine. Then it
opens in your browser: hold **Space** and talk.

Your Claude sessions run on your own Claude Code login. The keys pay only for the router and the
voice: a spoken turn costs about a third of a cent.

## What it does

- **One session per piece of work.** Each worktree has its own Claude Code session; Voice OS keeps
  them running and shows them side by side.
- **Speak to the one on screen, or any of them by name.** "Revert that", "checkout, run the
  migrations", "open the ranking one". A small router decides where your words go — and anything
  about the work goes to the session, in your words, instead of being guessed at.
- **Answer without switching.** Permissions, plans and questions come to you by voice: "yes",
  "always", "the second one", "no, use a new branch".
- **Hear what matters, not everything.** Sessions you aren't looking at say "checkout is done" or
  "checkout needs you: the backoff cap"; the full message plays when you switch there.
- **Your dev servers, watched.** When one dies after a start, Voice OS tells you and offers to have
  that worktree's Claude fix it — "yes" hands it the failure with its logs.
- **Notes as you think.** "Note: try a tone per session" — kept per workspace.

[The Voice OS guide](docs/guides/voice-os.md) has what you can say, from real use.

## How it works: crew

Voice OS sits on crew, which gives every piece of work a real, isolated copy of your stack — with
its dev servers running and the agent inside knowing how to reach them.

A **workspace** groups the repos a feature touches. A **worktree** is one working copy of all of
them: a git worktree per repo, dev servers on stable ports, and env vars that point the services at
*each other* instead of at whatever happens to run on `:3000`.

```
~/.crew/workspaces/store-front/
  main/  store-api  store-app  checkout-api   ← ports 54480…
  wrk1/  store-api  store-app  checkout-api   ← ports 54494…, its own branches
```

**Dev servers that stay honest.** crew starts every server of a worktree on ports it keeps for that
copy, then checks them: which one died, which runs but never listens, with the last lines of its
log. A new worktree is proven the same way before you touch it — checkout, install, servers up —
and a failure is recorded with its evidence instead of scrolling past.

**Agents that debug on their own.** The Claude in a worktree is told where it stands and how to
reach everything: `crew dev logs` for any server's output, `crew dev check` for what's up, `crew
run` to run tests or scripts with the same URLs the servers got, and `crew fix` to pick up a
recorded failure with all its evidence. No hunting for which terminal ran what.

```bash
crew add project store-api git@github.com:example/store-api.git
crew add project store-app git@github.com:example/store-app.git
crew dev add store-api --name=store-api --port=3000 --cmd="npm run dev"
crew dev add store-app --name=store-app --port=3001 --cmd="npm run dev"
crew add binding store-app --scan --apply             # which env vars point at store-api
crew add workspace store-front store-api store-app    # checkout, install, servers checked
crew add worktree store-front/wrk1                    # a second copy of everything
crew dev start store-front/wrk1                       # its servers, on its own ports
```

Or skip the commands: in Voice OS, ask the setup session — "make a worktree in store front for the
search fix".

## Without voice

Everything is a plain command that prints rows or `--json`, so any agent with a shell can drive
crew; `crew workspace` and `crew project` open a TUI. Claude Code gets a plugin with the reference
skill, a `crew` agent and guided setup:

```
/plugin marketplace add FurlanLuka/crew
/plugin install crew@crew
```

## Learn more

- [Getting set up](docs/guides/getting-set-up.md) — a workspace, its projects, a second worktree
- [Voice OS](docs/guides/voice-os.md) — what you can say, from real use
- [How crew works](docs/concepts.md) — projects, bindings, checks, failures, other devices, moving machines
- [Commands](docs/commands.md) — every command and its output
- [Running crew on a remote VM](docs/guides/remote-vm.md)
- [Voice OS internals](voiceos/README.md) — the router, keys, development

Requires macOS or Linux, git and tmux (installed for you on Linux), and
[Claude Code](https://code.claude.com/docs) for the sessions. `crew update` keeps crew — and Voice
OS, once installed — current; it asks GitHub through the `gh` CLI, so it needs `gh auth login`
once. MIT licensed.
