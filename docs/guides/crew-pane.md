# The crew pane in Claude Code

crew's Claude Code plugin draws a pane inside every Claude session whose folder is a crew worktree.
It shows that worktree's dev servers as they are right now, lets you read a server's log and restart
it, follows setup while a worktree is being made, and puts anything crew recorded as failed at the
top with a button that drafts the fix into your prompt box. It works in a terminal session and in
Claude Desktop, and it needs Claude Code 2.1.287 or later.

## Getting it

The pane ships in crew's plugin, version 6.6.0 and later:

```
/plugin marketplace add FurlanLuka/crew
/plugin install crew@crew
```

If you already have the plugin, `claude plugin update crew@crew` brings it up to date. `crew claude
<ref> --desktop` checks this before it opens Desktop and tells you the exact command when the plugin
is missing, disabled or too old, or when Claude Code itself is older than 2.1.287.

## What it shows

Each server the worktree declares gets a card: its name, its state, its URL, and **Logs** and
**Restart** buttons. A server that died or never started listening shows the last line of its log
instead of the URL and gets **Fix in Claude** as well. The header says how many servers run and has
**Restart all** and **Stop**, or **Start all** when nothing runs.

**Logs** replaces the list with that server's log, following it live, with **‹ Back** to return.
**Restart** replaces only that server's window, on the same port and with the same environment it
had, so everything that points at it keeps working. **Fix in Claude** runs `crew fix --print` and
puts the result in your prompt box with a line naming the server. It never sends anything: you read
it and press Enter.

While a worktree is being set up, the pane shows each project's current step and how long it has
taken, with **Install log** for the installer's output, and offers no start until setup is done.

Everything in the pane comes from crew's own commands. It finds the worktree with `crew which
<folder>`, follows `crew dev watch <ref> --json` for the state, and every button runs one crew
command you could type yourself: `crew dev restart <ref> <project>/<server>`, `crew dev logs <ref>
<project>/<server> -f`, `crew fix <ref> --print`.

## Where it opens

In a terminal at least 144 columns wide it opens by itself beside the transcript. In a narrower one
it waits; type `/crew-pane` to open it. In Claude Desktop it docks on the right. Sessions that nobody
looks at, like the ones Voice OS runs, never open it and never ask crew anything.

A session crew didn't launch, such as one opened in Desktop or a plain `claude` you started in a
worktree yourself, also gets crew's orientation (what `crew start <ref>` prints) at the start of the
conversation, so it knows how to drive the servers.

## Opening a worktree in Claude Desktop

`crew claude <ref> --desktop` opens the worktree in Claude Desktop on the machine crew runs on. A
single project opens at its checkout, so its own CLAUDE.md and settings load; several projects open
at the worktree root. crew also writes `.claude/launch.json` there with one entry per server
pointing at crew's port, so Desktop's preview attaches to crew's running servers instead of starting
its own on another port. In a checkout the file is kept out of git through the repo's own exclude
list, and a `launch.json` you wrote yourself is never touched.

From another computer, open the worktree over SSH instead. crew's page shows a link for each
worktree, `claude://code/new?ssh_host=<host>&ssh_folder=<folder>`, built from `crew config set
ssh_host <host>`. Open it on the computer you're sitting at: Desktop connects to the crew machine
over SSH, the session and the pane run there, and only the drawing shows up on your screen.

## Known quirks

Claude Desktop drops the first click on a pane that doesn't have focus: the click gives the pane
focus and is lost, and the second click works. It's a Desktop bug, reported to Anthropic. The pane
keeps everything in one place so focus moves as little as possible, but coming back from typing in
the chat still costs a click.

A worktree whose servers were started before crew 6.6 shows in the pane as usual, but restarting a
single server asks you to restart the whole worktree once first, because crew named its windows
differently then.
