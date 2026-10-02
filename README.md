![Crew | Voice OS: talk to your coding agents](docs/images/banner.png)

[![Test](https://github.com/FurlanLuka/crew/actions/workflows/test.yml/badge.svg)](https://github.com/FurlanLuka/crew/actions/workflows/test.yml)
[![Voice OS](https://github.com/FurlanLuka/crew/actions/workflows/voiceos.yml/badge.svg)](https://github.com/FurlanLuka/crew/actions/workflows/voiceos.yml)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](LICENSE)

**Talk to your coding agents.** Running a few Claudes at once is great until you become the
bottleneck, clicking through terminals to see who's stuck. crew turns that into a conversation:
"tell checkout to run the tests", "what's waiting on me?", "yes, but only on staging".

![Voice OS: an active session, store-front/wrk2 on another machine, with its work stream, dev servers, spoken summary and the sessions elsewhere that need you; the other active sessions are tabs along the top](docs/images/voice-os/hero.png)

## Try it

```bash
curl -fsSL https://raw.githubusercontent.com/FurlanLuka/crew/main/install.sh | sh
crew
```

That's it. `crew` starts its server and opens a page in your browser (over SSH it prints the link
instead). The first time, it walks you through the only setup it really needs: it finds the git
repos you already have on your machine, you tick the ones you work on, you group them into a
workspace, and it makes the first working copy of all of them while you watch. Then you pick
Voice OS, give it two API keys, hold **Space** and talk.

![The first run: crew lists the git checkouts it found in your code folders, each ticked, with the commands it will run](docs/images/setup/first-run.png)

## What it's like to use

Every piece of work gets its own copy of your stack and its own Claude Code session. The one on
your screen is the one you're talking to, so "revert that" or "run the migrations" just goes there.
Name another one and your words go to it instead ("checkout, add a retry"), and Voice OS offers to
take you there. There's a small router in the middle deciding where your words go, and it's strict
about one thing: anything about the actual work goes to the session in your words. It never
answers for the session or guesses what you meant.

The sessions mostly get on with it. They run in Claude Code's auto mode, so routine steps don't
wait on you. When one does need you (a permission, a plan to approve, a question with options) you
hear it and answer out loud, "yes" or "the second one" or "no, use a new branch", without switching
to it. Sessions you aren't looking at don't read you their whole essay. You hear "checkout is done"
or "checkout needs you" once it's quiet, and the full message waits until you go there. If you lose
track, "status update" gets you a short spoken recap of where everything is.

It tries to keep out of your way while you talk. If a session is busy and you give it another
instruction, the words wait behind what it's doing and Voice OS asks whether to send them right
now instead. If one of your dev servers dies, it tells you and offers to hand the failure, with its
logs, to that worktree's Claude. Screenshots and charts a session makes show up right in its page,
and the docs it writes (Claude Docs, Google Docs, Notion) turn into cards you can open by saying
"open the doc", on your phone too.

You can listen the way that fits where you are: hold Space to talk, say "Voice OS, …" when you
want it, or go fully hands-free. If you're away from the desk, Voice OS can join a Discord voice
channel and you talk to it from your phone. Sessions can also post things to Discord when you ask
("send that screenshot to Discord").

The [Voice OS guide](docs/guides/voice-os.md) has a full walkthrough, and the
[commands page](docs/guides/voice-os-commands.md) lists everything you can say, with examples from
real use.

## More than one machine

My laptop isn't where everything runs. A VM or a second computer can run its own worktrees and
sessions, and the Mac in front of you drives them over SSH with the same page and the same voice.
Each machine's sessions show up under its name, alerts come in from all of them, and if the link
drops the work on the other side keeps going. [Other machines](docs/guides/voice-os.md#other-machines)
covers the three steps to add one, and when you want to move your whole setup somewhere new,
**Export** saves it to a file and **Import** on the other machine walks you through bringing it in.
It even notices when you already have a repo checked out there, so it doesn't clone it twice.

## Setting things up

All the configuration lives on crew's page under **Set up**: projects, their dev servers, how they
point at each other, workspaces, worktrees and machines. Every form shows you the exact command it
will run, which I find more useful than any explanation. And there's a Claude on every machine you
can just ask instead:

> "Add the store api and store app repos from ~/code with their dev servers, wire the store app's
> API URL to the store API, and make a store front workspace with both."

It does the whole thing, checks every server actually starts, and shows a line for each command it
recorded. [The Set up guide](docs/guides/setup.md) goes through every page.

![Setup with Claude adding a repo: each crew command it ran, with a green "recorded" line under it](docs/images/setup/chat.png)

## How it works underneath

Voice OS is the part you talk to. crew is the boring, reliable part under it. It gives every piece of work a real, isolated copy of your stack, with its dev
servers running and the agent inside knowing how to reach them.

A **workspace** is the set of repos a feature touches. A **worktree** is one working copy of all of
them: a git worktree per repo, dev servers on ports that stay the same for that copy, and env vars
that point the services at each other instead of at whatever happens to be running on `:3000`.

```
~/.crew/workspaces/store-front/
  main/  store-api  store-app  checkout-api   ← ports 54480…
  wrk1/  store-api  store-app  checkout-api   ← ports 54494…, its own branches
```

When crew makes a worktree it proves it works before you touch it: checkout, install, servers up.
When something breaks, the failure is recorded with its evidence (which server died, which one runs
but never listens, the last lines of its log) instead of scrolling past in a terminal you closed.
The Claude in each worktree is told where it is and how to look around, so it uses `crew dev logs`,
`crew dev check`, `crew run` and `crew fix` to debug things itself.

If you'd rather type, everything the page and the Claudes do is a plain command:

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

Every command prints plain rows or `--json`, so any agent with a shell can drive crew too. In the
terminal, `crew launch` picks a worktree and opens Claude or your editor on it, and Claude Code has
a plugin with a reference skill, a `crew` agent and guided setup:

```
/plugin marketplace add FurlanLuka/crew
/plugin install crew@crew
```

## What you need, and where your data goes

crew runs on macOS and Linux and needs git and tmux. If you're missing something, `crew doctor`
tells you and `crew doctor --install` installs it for you (Homebrew or `xcode-select` on a Mac,
apt-get, dnf or pacman on Linux). Voice OS's Linux builds need glibc, so on Alpine and other musl
systems crew works but Voice OS doesn't. Every session runs on your own
[Claude Code](https://code.claude.com/docs) login, and `crew doctor --install` can set that up too.

For voice you need two API keys. The Anthropic one pays for the router and the short spoken
summaries; a spoken turn costs the router about a third of a cent. The [Soniox](https://soniox.com)
one is for speech in and out, billed by audio time ([pricing](https://soniox.com/pricing)). Both
are checked before they're saved and kept on your machine, readable only by you.

Your voice and the text of spoken replies go to Soniox, to become text and speech. What you say and
short excerpts of what sessions write go to Anthropic on your key, for routing and summaries. The
sessions themselves talk to Anthropic through Claude Code like they always do. Everything else stays
on your machine: the keys, your notes and the voice log. Voice OS never keeps recordings of your
voice.

## Learn more

- [Set up](docs/guides/setup.md): the page for projects, workspaces, worktrees and machines
- [Voice OS](docs/guides/voice-os.md): from two repos to a working feature, and what you can say
- [Voice OS commands](docs/guides/voice-os-commands.md): everything the router knows, with things to say
- [Getting set up](docs/guides/getting-set-up.md): the same setup as commands
- [How crew works](docs/concepts.md): projects, bindings, checks, failures, other devices, moving machines
- [Commands](docs/commands.md): every command and its output
- [Running crew on a remote VM](docs/guides/remote-vm.md)
- [Voice OS internals](voiceos/README.md): the router, keys, development
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md)

`crew update` keeps crew and Voice OS on the latest release (`crew update --check` only asks). A
running server keeps its version until `crew server restart`.

**License:** [Functional Source License 1.1, MIT future](LICENSE) (FSL-1.1-MIT). You can use it,
change it, run it at work and redistribute it for any purpose except a competing use: offering it,
or something built from it, in a commercial product or service that competes with crew. Each
release becomes plain MIT two years after it ships. Releases made before the license change stay
MIT.
