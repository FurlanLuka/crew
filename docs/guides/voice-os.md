# Voice OS

Voice OS is a web page that runs one Claude Code session per crew worktree and lets you drive all
of them by talking, typing or clicking. You say what you want. A small router (the **kernel**)
decides where your words go, and most of the time that is the session on your screen. Sessions
talk back in short spoken lines, answer questions, ask for permission and report when they are done.
You don't have to watch a terminal.

It runs on your machine, next to crew. The sessions are ordinary Claude Code sessions on your own
Claude Code login, working in crew's worktrees.

![Voice OS: a pinned session, store-front/wrk2 on Build box, with its work stream, dev servers and spoken summary, and the other pinned sessions as tabs](../images/voice-os/hero.png)

## Contents

- [Languages](#languages)
- [What you need](#what-you-need)
- [First run](#first-run)
- [The setup session](#the-setup-session)
- [From two repos to a working feature](#from-two-repos-to-a-working-feature)
- [Mission Control](#mission-control)
- [Listening modes](#listening-modes)
- [Talking to sessions](#talking-to-sessions)
- [Pinned](#pinned)
- [Session names](#session-names)
- [Questions, plans and permissions](#questions-plans-and-permissions)
- [Auto mode and approvals](#auto-mode-and-approvals)
- [Queued messages](#queued-messages)
- [Docs, images and sub-agents](#docs-images-and-sub-agents)
- [Dev servers](#dev-servers)
- [Notes and debug notes](#notes-and-debug-notes)
- [Other machines](#other-machines)
- [Running Voice OS](#running-voice-os)
- [Where state lives](#where-state-lives)
- [Troubleshooting](#troubleshooting)
- [Privacy and cost](#privacy-and-cost)

## Languages

You can talk to Voice OS in any language, and mix them. Choose the ones you speak under
**Languages you speak** in the listening menu (the round button next to the mic). Soniox is told
to expect them; English is the default.

**Works in any language:** where your words go, answers to questions and permissions ("ja",
"ne", "sí"), approvals and refusals, taking words back ("vergiss das"), "that was for checkout",
muting, changing how the tab listens, "For checkout?" answers, and asides versus queued work. A
small, separate Claude Haiku check reads the words whenever Voice OS is about to act on what you
meant (approve something, drop words, mute), and when it cannot tell, Voice OS takes the safe side:
it does not approve and does not drop your words. It runs only on those turns, adding a few hundred
milliseconds and a fraction of a cent there, and nothing to a plain message to a session.

**English only, for now:**

- **Stop words.** "Stop", "wait" and "no" cut Voice OS's speech at once in English. In another
  language they stop it a moment later, once the kernel has heard them.
- **"End of turn".** In another language a turn ends on the pause instead.
- **The wake word** is "Voice OS", however you say the rest.
- **Typed keywords** ("by the way", "queue it" at the start of typed text).
- **Voice OS's own lines** ("Sent to checkout", "Switching to…") are spoken in English. The
  sessions answer in whatever language you use with them.

## What you need

- **crew**, installed. Voice OS shows crew's worktrees and adds nothing of its own. With no
  worktree yet, [the setup session](#the-setup-session) makes one for you (or type it out with
  [Getting set up](getting-set-up.md)).
- **tmux**, because Voice OS runs in a tmux session that crew keeps alive.
- **Claude Code** (`claude` on your PATH), signed in. Every session is Claude Code on your login,
  on whatever plan you already have.
- **An Anthropic API key**, used by the kernel (which routes what you say) and the narrator
  (which writes the spoken summaries). This key is separate from your Claude Code login.
- **A Soniox API key**, used for speech-to-text and text-to-speech.
- A **browser** with a microphone. Voice OS works on macOS and Linux (x64 and arm64). The Linux
  builds need glibc, so musl distributions such as Alpine are not supported.

`crew doctor` shows what is missing, and `crew doctor --install` installs it.

## First run

```bash
crew voice
```

The first run does four things, and stops early with the fix if something is missing:

1. It checks for tmux and `claude`, and names anything missing with its install command.
2. It downloads Voice OS for your platform (25–40 MB) from the crew release matching your crew
   version, into `~/.crew/bin/voiceos`.
3. It asks for the two keys, hidden as you paste. Each key is checked with its service before it
   is saved. A key the service rejects is asked for again. A key it could not check (for example
   because you are offline) is saved with a warning. Press Enter on an empty prompt to skip a key.
4. It starts Voice OS, prints its sign-in links and opens the localhost one in your browser (`open` on macOS, `xdg-open` on Linux).

The output looks like this:

```
up	41873	http://localhost:41873/login?token=…	https://voice--os.192.168.1.20.nip.io/login?token=…
```

The columns are the state, the port, the localhost link and the link through crew's dev proxy. A
line under it says which one to open.

Open the **localhost** link on the machine running Voice OS. The link signs that browser in by
setting a cookie. If you lose the cookie, or want to sign in from another browser, run
`crew voice` again: it reprints the links without restarting anything.

> **Microphone access.** Browsers allow the microphone only on `localhost` or over HTTPS. The
> localhost link always works on the machine itself. To use a phone or another computer, open the
> proxy link: it works once crew's dev proxy serves HTTPS and that device trusts crew's certificate
> authority (`crew dev proxy trust` shows how, once per device). Until then the proxy link works
> for text and clicks only.

If you skip a key, Voice OS still starts. A banner says voice is off, and typing and clicking keep
working. Set the key later with `crew voice keys set anthropic` (or `soniox`), then run
`crew voice restart`.

**Where to get the keys:** an Anthropic API key from the [Anthropic Console](https://console.anthropic.com),
and a Soniox key from your Soniox account at [soniox.com](https://soniox.com). Both are billed per
use (see [Privacy and cost](#privacy-and-cost)).

**On a fresh crew**, This Mac shows only the setup session. Hold Space and tell it which repos to
add: [the walkthrough](#from-two-repos-to-a-working-feature) goes from there to a working feature.

## The setup session

The **setup** session is always first on This Mac's grid. It runs in your home folder with the
crew CLI, and it is for crew itself: adding projects, making workspaces, creating and removing
worktrees. Dev servers and code belong to each worktree's own session. You can talk to it from
anywhere:

- "Setup, make a worktree in store front for the search fix."
- "Create a new worktree for the search fix."
- "Delete the checkout worktree."

It runs in auto mode like every session, and it is told to ask rather than guess when a misheard
name could lead to a destructive change. That is an instruction, not a lock, so say plainly what to
remove. crew moves a removed checkout to its trash and empties it in the background, and deletes
the worktree's `crew/…` branches, so treat a removal as final.

A new worktree shows up on the grid by itself within a few seconds, because Voice OS rereads
crew's worktrees every 10 seconds.

## From two repos to a working feature

This is the whole loop by voice, on two small repos: `store-api` serves products and `store-app`
lists them from `API_URL`. Each dev command must listen on the port crew hands it in `$PORT`
([Getting set up](getting-set-up.md#2-add-your-projects) says how).

1. **Set it up.** "Setup, add the store api and store app repos from ~/code to crew with their
   dev servers, wire the store app's API URL to the store API, and make a store front workspace
   with both." The setup session reads each repo, registers it with `crew add project`, works out
   how its dev server starts, adds the binding and creates the `store-front` workspace. crew
   installs a fresh copy and starts it once to prove it works.
2. **It reports back.** You hear a short summary, and the details are on the page.
3. **The worktree appears.** `store-front/main` shows up on This Mac's grid.
4. **Open it and start its servers.** "Open store front main." "Start the dev servers." Both come
   up on this worktree's own ports.
5. **Build something.** "Add a search box to the store app's product page that filters the
   products by name as you type. When it works, take a screenshot of the page and show it to me."
   The session writes the code, restarts the servers through crew and checks its work.
6. **See the result.** If its Claude Code has a browser tool (for example the Playwright MCP
   server), it tries the page in a browser and its screenshot shows in the session's stream, on
   whichever device you are using. Without one, it checks what it can from the shell and tells you
   what to look at.

## Mission Control

Mission Control is the home screen. It shows one card per place your sessions live:

- **Pinned** comes first and gathers the sessions you pinned, from every machine.
- **This Mac** is the machine Voice OS runs on (it is called This Mac on Linux too).
- There is a card for **each other machine** you added (see [Other machines](#other-machines)).
- **+ Add machine** adds another machine.

Each card shows how many sessions are there, how many are running and how many are waiting on you,
and the first thing that is waiting ("store-front/main: approve the migration?").

![Mission Control: the Pinned card, This Mac, a second machine and + Add machine](../images/voice-os/mission-control.png)

Click a card, or say its name, to open that machine's **grid**. The grid has one tile per
worktree, with the setup session first. A tile shows the session's status, what you last asked
it, its branch, its dev servers and its last line. Each tile has **rename** and **pin** buttons.

![This Mac's grid: the setup session first, then admin/main, a session renamed checkout, signals/wrk1 waiting on you and store-front/main running, each with rename and pin](../images/voice-os/machine-grid.png)

Click a tile to open that session. Opening a session only shows it: a stopped session stays
stopped until you send it something or ask to start it.

**Esc** goes up one level: from a session to its grid (or to Pinned, if you opened it from there),
and from a grid to Mission Control. The **Esc →** button in the top bar does the same. The top bar
also shows session counts and your Claude usage (weekly and 5-hour).

The session page shows the conversation as it streams, a tab for each session on the same machine
(or for each pin, inside Pinned), and side panels: status and cost, sub-agents, dev servers,
what you said here, notes, docs, and **elsewhere** (sessions on other screens that need you).

![A session page: the stream, its last spoken line, dev servers and a named tab](../images/voice-os/session.png)

By voice:

- "Take me back to Mission Control." · "Show me everything." · "Go back."
- "Open store front main." · "Show me the checkout one." · "Switch back to store front main."
- "Show me the locale work." Sessions can be named by their worktree or by what they are working
  on.

## Listening modes

The round button next to the mic opens the menu that chooses how the tab listens. Each tab remembers its own mode, so a
second tab never starts listening on its own.

![The listening-mode menu in the bottom bar: Push to talk, On demand, Hands-free, Dictation](../images/voice-os/listening-modes.png)

| Mode | How it works |
| --- | --- |
| **Push to talk** | Hold **Space** (anywhere except in a text field), or hold the mic button. Release to send. |
| **On demand** | Always listening, but Voice OS only acts on what follows "Voice OS": "Voice OS, tell checkout to run the tests." A chime says it heard its name and the input shows *Listening to you*. The turn ends when you pause, or at once when you say "end of turn". A second request needs "Voice OS" again. |
| **Hands-free** | Always listening. Every sentence is a turn. |
| **Dictation** | For brain dumps. Click the mic (or press **Space**) to start and talk as long as you like: pauses never end it, and "stop" or "wait" are just words. **Send** sends everything, word for word, to the session on screen, marked as dictated. It never goes through Voice OS's routing. **Discard** throws it away (it asks once more when there are words). With no session on screen, or one waiting on your answer, the words land in the text box to send from there. |

You can also switch modes by voice: "Switch to on demand." · "Hands-free on." · "Turn off
hands-free." · "Push to talk." Voice OS confirms the change aloud.

Tips:

- **Talking over it.** Pressing the talk key cuts off whatever Voice OS is saying, and in
  hands-free you can simply talk over it. "Stop", "wait" and "no" count as yours even right after
  Voice OS spoke.
- **Noisy rooms.** On demand is the mode for a room with a TV or other people: nothing is acted on
  until someone says "Voice OS". Say the name and the request in one breath. If you pause after
  "Voice OS", whatever is said next becomes the request.
- **"End of turn."** In either always-listening mode this sends what you said right away instead of
  waiting for the pause.
- Background talk, music and a half-finished "and can you—" are ignored, and Voice OS says nothing
  about them.
- **Cost.** Both always-listening modes stream your microphone to Soniox for as long as listening
  is on, so they cost the same. Push to talk streams only while you hold the key, and dictation
  only until you send it.
- **Phones.** A phone may stop the microphone when the tab goes to the background or the screen
  locks. Bring the tab back to the front to continue.

You can always type instead. The chip at the end of the bottom bar shows where your words will
go. For speech it reads **→ Voice OS** (the kernel decides), or **answering …** when something is
waiting on you. Once you start typing on a session page it reads **→ store-front/main**, because
typed text goes to that session.

> **Typed text on a session page goes straight to that session**, just as if you had typed it into
> Claude Code. The kernel is skipped, so a typed "pin this" reaches Claude, not Voice OS. There are
> two exceptions: text that starts with another session's name ("checkout, run the tests") goes
> through the kernel, and so does anything typed while the session is waiting on your answer. Voice
> OS commands work when spoken, or when typed on Mission Control or a grid.

## Talking to sessions

Speak the way you would to a colleague. Filler, restarts and half-sentences are fine, and there
is no need to phrase anything carefully.

**The session in front of you** gets anything about the work: instructions, questions, reactions
and half-formed thoughts.

- "Hmm, I don't like that. Revert the last change."
- "Why is this so slow?"
- "Okay, the retry works but it's too aggressive. Cap it at three attempts and log each one."
- "Could we brainstorm a bit first?"
- "What's the last thing we've done?" The session remembers its own conversation.

The session gets your words exactly as heard, never a rewrite, so nothing you said is lost. When
one sentence did two things ("restart the servers and have it check the logs"), the session gets
its part, copied word for word. Voice OS does not answer these questions itself and does not ask
what you meant. If the session needs more, it asks you.

**Other sessions**, without leaving the one you are in:

- "Tell checkout to add backoff to the webhook retries."
- "Checkout, run the tests."
- "Is anything waiting on me?" · "How's checkout doing?" · "What's the ranking work doing?"
- "What did the session say?" Voice OS reads the session's last reply back, including any choice it
  left you.

**A conversation with a session you are not looking at.** Say "checkout, is the build green?" and
you stay where you are: Voice OS says "Sent to checkout", and checkout's answer plays in full, with
its name, however long it takes to come. Follow-ups ("and the lint?") keep going to checkout until a
minute after its last answer, or until you say something clearly about the session on screen ("Sent
to crew" tells you the conversation ended). Voice OS never asks to switch in the middle of it: say
"switch to it" when you want to. The bottom bar shows **Talking with checkout** while it lasts: click
the name to switch, × to end it.

- "Where am I?" · "Who am I talking to?" "You're on crew, talking with checkout."
- "Switch to it." Opens the session you are talking with.
- "Go back." Returns to the session you were on before, saying "Back to crew"; say it again to go
  further back. A session that stopped is passed over ("checkout stopped. Back to crew."). "Go back
  to checkout" goes to checkout, wherever you came from. "Home" still means Mission Control.
- "No, that was for store front." Resends your words there. If the session that got them is still
  working on them, it is stopped: "Stopped checkout."

When Voice OS switches for you, it says so first: "Switching to checkout" (a click is silent).

**Starting, stopping and interrupting:**

- "Start checkout." Starts the session and opens it.
- "Start checkout and tell me what it did last." Starts it and sends it the rest.
- "End the checkout session." The conversation resumes the next time the session starts.
- "Stop." · "Wait." · "Hold on." Interrupts the session on screen while it is working. The session
  stays open.
- "Actually, stop the refactor and fix the login bug first." Voice OS asks whether to stop the
  current work and switch (**Switch** / **After**).

**What you hear from sessions you are not looking at.** Sessions on other screens don't talk over
you. Nothing is dropped while you talk: what was queued waits, and the answer to what you just said
plays first. Other sessions' updates wait for a quiet moment (8 seconds with push to talk, 12 when
listening, never more than 50 seconds) and come as one line: "Meanwhile, ranking needs you about the
index, checkout said: all retry tests pass, and two others finished." Each session is described in
its own words (its last line, shortened), never by an old summary. An update you already met (you
switched there, answered it, or spoke to that session) is not said again. The top bar shows **N updates
waiting** until then; click it, or say "What did I miss?", to hear them now. The full message of a
session plays when you switch there. Another session's permission or question waits for the line
playing to end, plus a breath. A session still waiting on you is mentioned again ("checkout still
needs you") every five minutes, at most three times, while a Voice OS page is open.

**Replying to an update.** After "Meanwhile, checkout said: …" or "checkout needs you: …", your
reply is for checkout. "Tell me about that" switches to checkout and plays its update; a specific
question ("what did it change in the cap?") switches and asks it. While you are in the middle of a
conversation with the session on screen, the reply goes to checkout without a switch, and Voice OS
says where it went and offers the switch in one line: "Sent to checkout. Switch there?" (once per
update; yes switches, anything else keeps you where you are). When your words could be for either
("review all of this"), Voice OS asks "For checkout?": yes, or naming it, sends them there; no or
silence keeps them on the session on screen ("Kept on crew"). The eight seconds for an answer start
when you have heard the question.

- "Quiet." Drops what Voice OS had queued to say and stops its routine narration. The sessions' own
  lines, questions and alerts still play.

## Pinned

**Pinned** is your own view of the sessions you care about most, gathered from every machine. It
is the first card on Mission Control.

![Pinned: sessions from This Mac and Build box, and a pin whose machine is out of reach](../images/voice-os/pinned.png)

- Pin or unpin a session with the **pin** button on its tile or in the session's top bar.
- By voice: "Pin this." · "Pin checkout main." · "Unpin this." · "Unpin the setup session." Say
  "go to pinned" or "show my pinned sessions" to open it.
- A pinned session always opens inside Pinned. Its tabs are your pins, and Esc goes back to Pinned.
- A pin whose machine is out of reach stays as a tile ("… · Build box out of reach") and comes
  back when the machine does. If the worktree was removed, the tile reads "gone". Unpin it to let it
  go.
- Pins are kept in `~/.crew/voiceos/pinned.json` and survive restarts.

"Pin the version in package.json" is about the work, so it goes to the session.

## Session names

By default a session is called by its worktree (`store-front/main`). You can give it a name you
would rather say, such as "api work". Voice OS shows that name everywhere and answers to it.

- Click **rename** on a tile or in the session's top bar, type the name and press Enter. An empty
  name clears it and brings back crew's label. Esc keeps the old name.
- By voice: "Rename this to api work." · "Call checkout main payments." · "Call store front main on
  Build box api work."
- A name belongs to one session: a name that is already taken is refused. Names can be up to 60
  characters.
- A named session is never spoken with its machine in front: you chose the name to stand on its
  own.
- Names are kept in `~/.crew/voiceos/names.json`. They are Voice OS's own and change nothing in
  crew or git.

"Rename the function to parseRef" is work, so it goes to the session. "Rename store-vm to Build
box" renames a machine (see [Other machines](#other-machines)).

> Pins and names are Voice OS preferences, not crew state, so they have no `crew` command. Use the
> page or your voice.

## Questions, plans and permissions

When a session asks you a question, shows a plan or asks for permission, you hear it and the page
shows it in the dock at the bottom. Answer it the way you would answer a person, or click.

![A question from a session, with its options in the dock](../images/voice-os/question.png)

- "Yes." · "Go ahead." · "Always." ("Always" is offered when Claude Code suggests a rule. Voice
  OS hands that suggestion back to Claude Code unchanged, so the rule is kept wherever the
  suggestion names: for this session only, or in one of your Claude Code settings files, where it
  lasts beyond this session.)
- "No, use a new branch." Declines, and your reason reaches the session.
- "Yes, but push to a new branch afterwards." Approves, with a note.
- "The second one." · "Reuse orders." Picks an option by position or by name.
- "Options." Reads the choices out again.
- "Why does step three touch the kernel?" Asks about the plan without answering it. The session
  answers on the side and the plan keeps waiting.

A plan has **Approve**, and **Change the plan…** to send it back with your notes. A permission
has **Yes**, **Always for this** (when offered), **No**, and **No, and tell it why…**.

If you say something unrelated ("actually, let's look at the router first"), you are moving on:
your words go to the session, and they decline what it was waiting on.

A bare "yes" answers whatever was just asked aloud, even if it came from a session you are not
looking at. If two things are waiting and it is unclear which you mean, Voice OS asks
("Yes to which — ranking or checkout?").

`/clear` and `/compact`, typed or said ("slash compact"), wait for a yes before they reach the
session.

## Auto mode and approvals

Sessions run in Claude Code's **auto** permission mode. Routine work runs without asking, and
Claude Code blocks a call it judges risky instead of running it. You do not approve every file
edit and command. Plans and questions are different: they always wait for you, in any mode.

Whether auto mode is available depends on your Claude Code account, model and settings. Voice OS
asks for it but does not check what Claude Code did with the request; any permission prompt
Claude Code raises comes to you like the others.

When auto mode blocks something, the session page shows a red **blocked** strip that says what the
session was trying to do ("Auto mode blocked store-front/main from trying to run git push"), and
Voice OS tells you.

![The blocked strip, and an "Allowed once" line in the stream](../images/voice-os/approval.png)

- **Allow it** (or say "allow it" / "let it") lets that one call through. The session retries it,
  and the stream shows **✓ Allowed once: …**. Only that call is allowed: auto mode is back for the
  next one, and any allowance still unused ends with the turn.
- **Leave it blocked** dismisses the strip. The session carries on without it.

Asking "why is auto mode off?" or "why do you keep asking me?" on a session's page goes to the
session. Voice OS does not guess at causes.

> **Trust.** Auto mode is Claude Code's own safety check, and your Claude Code settings (allow and
> deny rules, CLAUDE.md files, plugins) still apply, because sessions load your user, project and
> local settings. Voice OS never widens what a session may do on its own: "Allow it" lets one
> call through, and "Always" saves only the rule Claude Code itself suggested. A session's
> environment has `ANTHROPIC_API_KEY` and the Soniox key removed.

## Queued messages

A session works on one thing at a time. What you send while it is busy waits in its queue, shown
under the stream as **queued 1**, **queued 2**, and so on. Each message goes in order when the
current work ends.

- **▲ now** sends that message at once. It interrupts the current work and goes first.
- **✕ cancel** removes it from the queue.
- By voice: "Why are you queuing it? I want it now." · "Do that first." With more than one of your
  messages waiting, "send them all now" sends them together as one.
- "Take that back." · "Don't send that." Removes your last message if it is still waiting. If it
  already reached the session, the session is told to ignore it.
- "Sorry, I meant that for store front main." Sends it there instead and takes it back from the
  wrong session.

**Questions don't queue.** A question to a busy session is answered **on the side**: a short fork
of its conversation answers it without stopping the work, and with every tool denied. Asides are
not saved and are gone after a restart. You can steer this:

- Start with **"by the way"** to force an aside ("by the way, which file holds the retry config?").
- Say **"queue it"** to force the queue.
- A question that needs tools or changes the work is queued after all.

Instructions always queue, unless you say they go now ("tell it right now to stop pushing").

## Docs, images and sub-agents

- A screenshot, chart or diagram that a session makes shows inline in its stream. Voice OS stores
  the image and serves it itself, so it shows on your phone too. Images are kept for 30 days.
- Docs and artifacts a session links (claude.ai artifacts, Google Docs, Sheets and Slides, Drive
  files, Notion pages) become cards, and the session's **docs** panel keeps them together.
- "Open the doc" opens the session's newest doc, and "open the risks doc" opens the one you name,
  in the browser tab you spoke from. If the browser blocks the new tab (phones usually do), a
  banner offers the link to tap.
- "Add a section on the rollout risks to the doc" is work, so it goes to the session, which edits
  the doc itself.
- While a session runs sub-agents, the **sub-agents** panel lists each one with its current step.

## Dev servers

Voice OS starts, stops and watches each worktree's dev servers through crew, on that worktree's own
ports. The session page's **dev servers** panel shows each server with its link and state.

- "Start the dev servers." · "Restart them." · "Stop the servers."
- "What's wrong with the dev servers here?" Answered from what crew sees: which one died, and which
  never started listening.
- "Why were they failing? Check the logs." That is work, so it goes to the session, which reads
  them with `crew dev logs`.

When a server dies after a start, Voice OS says so and asks whether Claude should fix it. Say
"yes" (or click **Fix …**) to hand that worktree's session the failure, with its log.

## Notes and debug notes

**Notes** are your own ideas and reminders, said out loud. Voice OS keeps them per workspace in a
plain Markdown file.

- "Note: try a different tone per session." Saved to the workspace on screen. On Mission Control it
  goes to your general notes. Voice OS replies "Noted."
- "Note for store front: check the image sizes." Saved to that workspace.
- "What are my notes?" · "Read my store front notes." Reads them back briefly.
- "Go through my notes and pick one to build next." That is work: the session reads the file
  itself.

The notes panel on the page shows them. The files are `~/.crew/voiceos/notes/<workspace>.md`, and
general notes go in `_general.md`. A workspace's notes are shared by every machine.

**Debug notes** are for when Voice OS itself gets something wrong: it misheard, sent your words to
the wrong session, or talked at the wrong moment.

- "Debug note: it read out every option when I only wanted the question."
- "Add a note that I get double speech when a plan opens." Voice OS saves this as a debug note,
  even without the word "debug".

Each debug note is saved with a snapshot of the moment (what you said and what Voice OS did on that
screen, the sessions, what was waiting, what was said last) to
`~/.crew/voiceos/logs/debug-notes.jsonl`, next to the log. Include them if you report a bug.

Read both from a terminal, or have an agent read them:

- `crew voice notes store-front` · `crew voice notes` (general) · `crew voice notes --all`
- `crew voice debug-notes` lists the debug notes, numbered; `crew voice debug-notes show 3` prints
  one whole, then the log around it (`--around=2m` for more).

Notes and debug notes live on the main. On a remote these commands ask the main through the link.

## Other machines

One Voice OS can drive the sessions on other machines too, such as a VM or a second computer, over
SSH. You keep talking to the Voice OS on your own machine (the **main**). The other machine (a
**remote**) runs its sessions and nothing else: no page, no keys, no voice.
[Running crew on a remote VM](remote-vm.md) sets one up from nothing.

1. **On the other machine:** install crew, then run `crew voice remote`. It checks tmux and Claude
   Code, installs Voice OS and starts it in the background. Sign in to Claude Code there once.
2. **Check SSH:** from your machine, `ssh <host>` must log in with no password prompt (your key or
   ssh-agent, and the host key accepted once). Voice OS connects with `BatchMode=yes`, so it cannot
   answer a prompt. How the host is reached is up to you: the LAN, a VPN, or an alias in
   `~/.ssh/config`.
3. **On your machine:** `crew voice machines add store-vm --name="Build box"`, or use **+ Add
   machine** on Mission Control.

Mission Control then shows a card for the machine, with what runs there and what waits on you.
Click it, or say its name, to open its grid.

- "Show me Build box." · "Switch to the personal server." · "Go to this Mac."
- "Rename store-vm to Build box." You can also click **rename** on the card, or run
  `crew voice machines rename store-vm "Build box"`. A machine's id comes from its SSH host
  (`store-vm` here); its name is what you call it aloud.
- "Build box store front main, run the tests." If a session name exists on two machines, it means
  the one on the machine you are looking at. Name the machine to reach the other one: "store front
  main on this Mac".
- Its dev servers are its own. "Start the dev servers" works as it does here, and the links are
  that machine's addresses.
- Alerts from every machine play with the machine's name in front ("Build box, store front main
  needs you"), and switching to a machine tells you what is waiting there.

When the link drops, the sessions there keep working. The card shows the machine as **out of
reach** and why. What you say to it waits and is sent when it is back, and you hear one line about
what happened meanwhile ("Build box is back: store front main finished").

A machine is either a main or a remote, never both: `crew voice` refuses on a remote, and
`crew voice remote` refuses on a main. **remove** on the card (or `crew voice machines rm <id>`)
stops driving a machine. Its sessions keep running there.

## Running Voice OS

| Command | What it does |
| --- | --- |
| `crew voice` | Starts Voice OS if it is not answering and prints the sign-in links. Safe to run any time. |
| `crew voice start` | The same as bare `crew voice`. |
| `crew voice restart` | Stops and starts it. Use it after changing a key or after `crew update`. |
| `crew voice stop` | Stops Voice OS **and every Claude session it runs**. Their conversations resume the next time each session starts. |
| `crew voice status` | Prints `up`, `up (not answering)` or `down`, with the port and both links. |
| `crew voice logs [--since=…] [--level=…] [--machine=…]` | The log of every machine, filtered and merged by time (80 lines by default). See [Reading the log](#troubleshooting). |
| `crew voice debug-notes [show <n>]` | Lists your debug notes, or prints one with the log around it. |
| `crew voice notes [<workspace>\|--all]` | Prints your notes. |
| `crew voice keys` | Shows which keys are set and where (never their values). |
| `crew voice keys set <anthropic\|soniox>` | Sets a key from stdin, for example `pbpaste \| crew voice keys set soniox`. |
| `crew voice machines [ls\|add\|rm\|rename]` | Manages the other machines. |
| `crew voice remote [status\|stop]` | Makes this machine a remote, or reports or stops it. |

Add `--no-open` to `start` or `restart` to skip opening the browser. `--json` gives
machine-readable output. [Every crew command](../commands.md#crew-voice) has the details.

**A restart keeps your place.** Voice OS remembers the screen you were on and returns to it. For
another machine's session, it waits up to a minute for that machine to reconnect. Open pages
reconnect by themselves, and the first one to reconnect hears "Voice OS restarted." Session streams
are rebuilt from Claude Code's own transcripts. Sessions do not start again on their own: each one
resumes its conversation the next time you send it something.

> A restart ends every running Claude session, even one that is in the middle of work. The same is
> true of `crew kill`, and of `crew dev stop` without a workspace name: both stop every crew tmux
> session, including Voice OS's.

**Updating.** `crew update` also updates Voice OS to the matching version, but never restarts it,
because that would end your sessions. It says so when an update is waiting. Run
`crew voice restart` when you are ready. A remote picks up the new version on its next connect,
at once; a session at work there is cut off and resumes on the new release. You don't have to update a remote yourself: when one runs an
older release than this Voice OS, Voice OS runs `crew update` there over SSH and reconnects. Its card
says "Updating …" while that runs. A remote on a *newer* release is never downgraded; its card tells
you to update this machine instead.

## Where state lives

| Path | What |
| --- | --- |
| `~/.config/crew-voiceos/anthropic.key`, `soniox.key` | The API keys, readable by you only (0600). |
| `~/.crew/bin/voiceos` | The Voice OS binary, with a `.version` stamp beside it. |
| `~/.crew/voiceos/token` | The sign-in token (0600). Deleting it and restarting signs every browser out. |
| `~/.crew/voiceos/state.json` | The port and pid crew tracks, and each machine's last status. |
| `~/.crew/voiceos/sessions.json` | Which Claude Code conversation each session resumes. |
| `~/.crew/voiceos/view.json` | The screen you were on, restored after a restart. |
| `~/.crew/voiceos/pinned.json`, `names.json` | Your pins and session names. |
| `~/.crew/voiceos/journal/` | One file per session of what was asked and done in each turn, used for "what did checkout do yesterday". |
| `~/.crew/voiceos/notes/` | Your notes, one Markdown file per workspace. |
| `~/.crew/voiceos/media/` | Images sessions showed, kept for 30 days. |
| `~/.crew/voiceos/machines.json` | The other machines. |
| `~/.crew/voiceos/logs/voiceos.log` | The log, rotated into `.1` … `.5` (`crew voice logs`). |
| `~/.crew/voiceos/logs/debug-notes.jsonl` | Debug notes (`crew voice debug-notes`). |
| `~/.crew/voiceos/remote/` | A remote's own daemon state, socket and log. |

The conversations themselves are Claude Code's, stored where Claude Code keeps them.

## Troubleshooting

**The page says "Microphone blocked."** Allow the microphone for the page in the browser's site
settings. Remember that browsers give the microphone only to `localhost` or HTTPS pages: on
another device, use the HTTPS proxy link after `crew dev proxy trust` on that device. On macOS,
also check System Settings → Privacy & Security → Microphone for your browser.

**A banner says voice is off until keys are set.** Run `crew voice keys` to see which key is
missing, set it with `crew voice keys set <anthropic|soniox>`, then run `crew voice restart`. If the
service rejects a key, check it in the Anthropic or Soniox console. Keys belong in the key files,
not in your shell: an exported `ANTHROPIC_API_KEY` would also switch your own Claude Code to
per-token billing.

**A session never starts, or stops at once with an error.** Usually Claude Code is not signed in
on this machine: sessions run on your Claude Code login, and Voice OS removes `ANTHROPIC_API_KEY`
from their environment, so a key in your shell does not count. The page shows Claude Code's own
error, as a **Stopped: …** line or as the session's reply. Run `claude` once in a terminal, sign
in, then send the session something again.

**Holding Space does nothing.** Space talks only in push to talk, and not while the cursor is in
a text field: click outside the input first. In on demand or hands-free there is nothing to hold;
switch back to push to talk from the menu by the mic. If the mic never starts, check the
microphone permission ("Microphone blocked" above).

**"This browser has no Voice OS session."** The sign-in cookie is missing. Run `crew voice` and
open the link it prints.

**`crew voice status` says `up (not answering)`.** The tmux session exists but Voice OS does not
answer. Run `crew voice` to relaunch it, and `crew voice logs` to see why it stopped answering.

**"Voice OS needs a few things first."** tmux or `claude` is missing, or not on the PATH of the
shell you ran crew from. Install what it names (`crew doctor --install`), or point
`VOICEOS_CLAUDE_BIN` at your `claude`.

**"Reconnecting to the Voice OS server…"** The page lost its connection, usually because Voice OS
restarted or stopped. It reconnects by itself. If it doesn't, run `crew voice status`.

**A machine card says "out of reach" or "needs a fix".** The card shows the reason. The common ones:

| The card says | Fix |
| --- | --- |
| Its host key is not trusted yet | Run `ssh <host>` once in a terminal and accept the key. |
| SSH refused the login | Check your key and that ssh-agent has it (`ssh-add -l`). |
| crew is not installed there | Install crew on that machine, then run `crew voice remote`. |
| Its Voice OS did not start | Run `crew voice remote` there, then `crew voice remote status`. |
| Missing on that machine: tmux, claude | Install them there (`crew doctor --install`). |
| That machine runs Voice OS as a main | Run `crew voice stop` there, then `crew voice remote`. |
| Host … not found | Check the host name or your `~/.ssh/config` alias. |

**The mic stops on a phone.** Phones pause the microphone when the tab goes to the background or
the screen locks. Bring the tab back. Push to talk is the most reliable mode on a phone.

**It misheard or did the wrong thing.** Say "debug note: …" right away. Then
`crew voice debug-notes` finds it and `crew voice debug-notes show <n>` prints it with the log
around it. `crew debug --tail=20` shows what crew itself ran (starts, stops, key checks).

**Reading the log.** `crew voice logs` reads the log of every machine at once and merges it by
time, newest 80 lines. Narrow it down:

- `--since=10m`, `--since=10:02 --until=10:05`, or an ISO time. Times are yours; crew converts
  them for every machine.
- `--level=warn` (warn and error), `--cat=router,kernel`, `--grep=signals` (any case).
- `--machine=vm1` or `--exclude=vm2`; `--machine=main` reads the main alone, without SSH.
- `--lines=200` for more, `--json` for a document.

On the main, crew asks each remote over SSH, even while Voice OS is down. A machine that does not
answer is named on stderr (`! vm2 (build box) unreachable: …`) and the others still print. One on
an older crew says `run crew update there`. On a remote, crew asks the main through the link; with
the main away you get that machine's own log and a warning. The log rotates at 20 MB and keeps
five older files (`voiceos.log.1` … `.5`); `crew voice logs` reads them all.

## Privacy and cost

**What leaves your machine:**

- **Audio** goes to Soniox for speech-to-text while you talk (for as long as listening is on in the
  always-listening modes), and Voice OS's spoken lines go to Soniox to be turned into speech.
- **Text** goes to the Anthropic API, using your key. The kernel gets what you said, together with
  a summary of the sessions (their status, what you asked them, what is waiting, their recent lines). After a
  turn, the session's final message goes to the narrator when it has no spoken line.
- **Your Claude Code sessions** talk to Anthropic as Claude Code always does, on your login.

**What stays on your machine:** everything under `~/.crew/voiceos/` (see
[Where state lives](#where-state-lives)). The log records what you said and where it went, so treat
it as private. Voice OS does not record audio. The one exception is a contributor debug switch
(`VOICEOS_DEBUG_AUDIO=1`, see the [Voice OS README](../../voiceos/README.md)), which is off unless
you run Voice OS from source with it set.

**Who can open the page:** Voice OS listens on `127.0.0.1` only. Other devices reach it through
crew's dev proxy, and every request needs the sign-in cookie, which is set only by the link that
carries your token.

**Cost:**

- **Claude Code sessions** use your Claude plan like any other Claude Code session. The top bar
  shows your usage. Each session page shows a cost: the figure Claude Code reports for the
  session's turns. On a Claude subscription that is an API-price estimate, not a bill.
- **The kernel** (Claude Haiku) handles every spoken turn, and every typed one that does not go
  straight to a session. **The narrator** (Claude Sonnet) summarizes a turn only when a session's
  final message has no spoken line of its own. When a session asks you something, a short Haiku call names what
  the question is about. All of them bill your Anthropic key. A spoken turn costs the kernel roughly a third of a
  cent. The language check (Haiku, see [Languages](#languages)) runs only on turns where Voice OS
  acts on what you meant, and costs a small fraction of that.
- **Soniox** bills audio: speech-to-text for as long as the microphone streams, and text-to-speech
  for what Voice OS says ([Soniox pricing](https://soniox.com/pricing)). On demand and hands-free stream the whole time listening is on. Push to
  talk streams only while you hold the key.

More: [how crew works](../concepts.md) · [every crew command](../commands.md) ·
[running crew on a remote VM](remote-vm.md) · [how Voice OS is built](../../voiceos/README.md)
