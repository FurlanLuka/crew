# Voice OS commands

Everything you say to Voice OS goes through the **kernel**, a small, fast model whose only job is to
decide what your words should do. It has a fixed set of tools, one for each thing it can do: pass
your words to a session, switch the screen, answer a permission, take a note, and so on. This page
lists every tool, with things you can say to reach it and what happens next.

You never name a tool. Speak the way you would to a colleague; the phrases below are examples, not
commands to learn. Any language you speak works the same way (see
[Languages](voice-os.md#languages)). For the bigger picture, read the [Voice OS guide](voice-os.md).

## Contents

- [How your words are routed](#how-your-words-are-routed)
- [Talking to sessions](#talking-to-sessions): `forward`, `send_to`, `queued_message`, `interrupt`
- [Moving around](#moving-around): `switch_view`, `go_back`, `play_missed`
- [Active sessions](#active-sessions): `activate`, `deactivate`, `list_sessions`
- [Answering what waits on you](#answering-what-waits-on-you): `answer`, `allow_denied`, `dev_offer`
- [Asking how things are](#asking-how-things-are): `read_state`, `status_update`, `read_history`
- [Dev servers](#dev-servers): `crew_dev`
- [Notes and debug notes](#notes-and-debug-notes): `note`, `read_notes`, `debug_note`
- [Docs](#docs): `open_doc`
- [Names](#names): `rename_session`, `rename_machine`
- [Voice OS itself](#voice-os-itself): `hands_free`, `mute`, `ignore_words`
- [Words that never reach the kernel](#words-that-never-reach-the-kernel)

## How your words are routed

- **On a session's screen, almost everything is for that session.** Instructions, questions about
  the code, reactions and half-thoughts go to it word for word (`forward`). The kernel acts itself
  only on the commands below (switching, answering, notes, and so on), and when you name another
  session.
- **Off a session's screen** (Active, Activate, Settings — the kernel calls these Mission Control)
  there is no session in front of you, so words reach a session only when you name it ("checkout,
  run the tests").
- **Setting crew up is not voice's job.** Projects, workspaces, worktrees and machines are made in
  **Set up**, crew's other page, where each machine's setup session is a chat you type to. Voice OS
  never routes words to a setup session, never says what it does and never counts its questions.
- **The kernel never answers questions about your work.** "Why is this slow?" or "what did we do
  last?" goes to the session, which holds the whole conversation. The kernel answers only about
  Voice OS itself: what is waiting, where you are, which sessions there are.
- **It never guesses where words go.** Words that name no session go to the one on screen. Words
  that only mention another session get "For checkout?" first.
- **Some tools only exist in some places.** `forward` exists only while a session is on screen.
  `read_history` exists only off a session's screen, because a session remembers its own past.
  `rename_machine`, and showing one machine's worktrees on Activate, appear once you have
  [other machines](voice-os.md#other-machines).

## Talking to sessions

### Send words to the session on screen — `forward`

The default on a session's screen. Your words go to that session's Claude exactly as heard, never
reworded. A session that isn't running starts by itself.

- "Run the tests and tell me what fails."
- "Hmm, I don't like that. Revert the last change."
- "Why does the retry loop sleep so long?"
- "Could we brainstorm a bit first?"

**What happens:** the words appear in the session's stream, and Voice OS reads its reply when it
ends its turn. While the session is working:

- an **instruction** waits in its queue;
- a **question** is answered on the side, without stopping the work;
- a **redirect** ("actually, stop the refactor and fix the login bug first") asks whether to switch
  now or do it after.

**In practice:**

- Say "by the way" to force a side question. Say "queue it" or "send it now" to decide yourself
  (see [Queued messages](voice-os.md#queued-messages)).
- A sentence cut off by a pause is joined with the next one, so "why are the retries so…" followed
  by "slow on the checkout worker?" reaches the session as one sentence.
- Mention your own notes ("check my notes for the plan") and the session is told where they are.
- If the words point at what Voice OS just did ("look at this debug note"), the session is told what
  that was.
- A bare "yes" or "no" right after Voice OS asked something of its own ("Did you mean the debug
  notes?") answers Voice OS, not the session: it is never forwarded.

### Send words to another session — `send_to`

The same as `forward`, for a session you name, without leaving the one you are on.

- "Checkout, run the tests."
- "Tell checkout to add backoff to the webhook retries."
- "Sorry, I meant that for store front main." Resends your last words there.

**What happens:** "Sent to checkout. Switch there?" Yes switches; anything else keeps you where you
are. A short answer is said at once, with the session's name; a longer one comes later in the
[meanwhile line](voice-os.md#talking-to-sessions).

**In practice:**

- A session is named by its worktree ("store front work one") or the name you gave it, never by its
  work.
- A follow-up like "and the lint?" names no session, so it goes to the one on screen. Name checkout
  again, or switch there.
- Crew setup work ("add a project", "create a worktree") is never sent to a setup session: on a
  session's screen it goes to that session like any other work; on Active, Voice OS says it is done
  in Set up.
- A bare "yes" or "no" right after Voice OS asked something of its own reaches a session only when
  you name it ("checkout, yes"); unnamed, it answers Voice OS.

### Change words already queued — `queued_message`

Acts on words that wait in a session's queue, or that it just received.

- "Why are you queuing it? I want it now." · "Do that first." Sends them now: the current work
  stops and they go first.
- "Take that back." · "Don't send that." Removes them if they still wait. If the session already
  got them, it is told to ignore them.
- "That wasn't for it." Takes them back from the session that got them.

**In practice:** it acts on your last words for that session. The page's **▲ now** and **✕ cancel**
buttons do the same by click.

### Stop the current work — `interrupt`

- "Stop." · "Wait." · "Hold on."
- "Stop checkout."

**What happens:** the session's current turn ends and it keeps everything up to that point. The
session stays active, and you can carry on with it.

**In practice:** a bare "stop" interrupts the session on screen, never one you are not looking at.
"Stop the refactor and fix the login bug first" names what to do instead, so it is a redirect sent
with `forward`, not an interrupt. Off a session's screen, with a session working and none named,
Voice OS asks which one.

## Moving around

### Show a session, Active or Activate — `switch_view`

- "Switch to checkout." · "Go to store front work one." · "Open crew main on Build box."
- "Home." · "Mission Control." · "Go to active." · "Show my active sessions." All open Active, the
  home view.
- "Show me Build box." Opens Activate on that machine's worktrees (with other machines only).
- "Switch to it." Right after a session's line, opens that session.
- "Switch to checkout and ask it to run the release checklist." Switches, then sends the rest.

**What happens:** Voice OS says "Switching to checkout" first (a click is silent), and that
session's update, if it had one waiting, plays when you get there. When the sentence also asks the
session for work, that part goes to it once you are there, and you hear "Sent to checkout". A longer
sentence that asks for work in a place ("go to the research folder and check what's in there") goes
to the session on screen instead.

### Go back — `go_back`

- "Go back." · "Back." · "Previous session."
- "Let's go back to what we have to do on the lesson types — what's next?" Goes back, then sends
  the rest to the session it went back to.

**What happens:** "Back to crew." Say it again to go further back. Sessions that stopped are passed
over ("checkout stopped. Back to crew."). "Go back to checkout" switches to checkout, and "go back
to crew research" finds crew research even when crew main is named "Crew"; "home" means Active.
Words that also ask the session for work reach the session you land on.

### Hear what you missed — `play_missed`

- "What did I miss?" · "Any updates?"

**What happens:** the other sessions' updates that were waiting for a quiet moment play now, as one
line ("Meanwhile, ranking needs you about the index, and checkout said: all retry tests pass"), or
you hear that nothing is new. Clicking **N updates waiting** in the top bar does the same. A plain
"yes" right after "Switch there?" answers that question, so it switches instead of replaying.

## Active sessions

Only active sessions exist for voice (see [Active sessions](voice-os.md#active-sessions)).

### Activate a worktree — `activate`

- "Activate checkout." · "Start checkout." · "Enable crew main."
- "Activate the scheduler on Build box."
- "Activate this." For the inactive session on screen.
- "Yes." After Voice OS asked "checkout isn't active. Activate it?"

**What happens:** "Activated checkout. Switch there?" Its Claude starts and resumes its
conversation. On its own screen you hear just "Activated checkout." (no screen to watch over
Discord). If two worktrees match, Voice OS asks which one.

**In practice:** "Start checkout and tell me what it did last" activates it, then sends it the rest
once it is up. Activating never creates a worktree: make one in Set up. A setup session is never
activated; it runs by itself for Set up's chat.

### Deactivate a session — `deactivate`

- "Deactivate checkout." · "End the checkout session." · "Close crew main."
- "Deactivate this."

**What happens:** its Claude stops, and Voice OS drops what it held for it (queued words, questions,
updates). The conversation is kept for the next activation. If the session is working, you are
asked first: "checkout is working. Deactivate anyway?"

### Ask what there is — `list_sessions`

- "What machines do I have?"
- "What's on Build box?"
- "What's active?"
- "What worktrees does store front have?"

**What happens:** counts first ("Build box has 11 worktrees in 6 workspaces; none active"), then
names when the list is short. These are answered even on a session's screen. "What's running in the
tests?" is about the work, so it still goes to the session.

## Answering what waits on you

### Answer a permission, plan or question — `answer`

- "Yes." · "Go ahead." · "Always."
- "No, use a new branch." Declines, and your reason reaches the session.
- "Yes, but push to a new branch afterwards." Approves, with an instruction.
- "The second one." · "Reuse orders." Picks an option by position or by name.

**What happens:** the session continues with your answer, and the dock on the page closes.

**In practice:**

- "Always" is offered only when Claude Code suggests a rule, and saves that rule unchanged.
- A bare "yes" answers what was just asked aloud, even from a session you are not looking at. If two
  things wait and it is unclear which you mean, you hear "Yes to which, ranking or checkout?".
- "Also run the linter" is not an answer: you are told the session is still waiting on its
  permission.
- A question a session asked at the end of its reply ("want me to push it?") is not a pending
  question. Your reply goes to the session as words, with `forward`.

See [Questions, plans and permissions](voice-os.md#questions-plans-and-permissions).

### Let a blocked call through once — `allow_denied`

- "Allow it." · "Let it."

**What happens:** when auto mode blocked something (the red **blocked** strip), that one call goes
through and the session retries it. Auto mode is back for the next call. See
[Auto mode and approvals](voice-os.md#auto-mode-and-approvals).

### Accept or decline a dev-server fix — `dev_offer`

When a dev server dies, Voice OS asks whether Claude should fix it.

- "Yes, fix it." · "Sure."
- "No, leave it."

**What happens:** yes hands the worktree's session the failure with its log; no lets it go.

## Asking how things are

### Sessions right now — `read_state`

- "Is anything waiting on me?"
- "What's checkout doing?" · "How far is ranking?"
- "What did the session say?" Reads the session's last reply back, with any choice it left you.
- "Did that go to the session?"
- "Where am I?" · "Who am I talking to?"
- "Options." Reads out again the choices of what waits on you.

**What happens:** a short spoken answer. Voice OS looks at the sessions (status, what each was last
asked, what waits on you, their latest lines) and answers in a sentence or two. An answer about one
other active session ends with "Switch to checkout?", so a "yes" takes you there.

**In practice:** this is for sessions you are not looking at. "Status" or "how far are you?" on a
session's own screen goes to that session, because it knows its work better than any summary.
Even when Voice OS reads that session first, the words still go to it, unless they are for Voice OS
itself, such as "repeat what it said".

### A recap of what happened — `status_update`

- "Status update." · "Give me a recap." · "What's been happening?"
- "What happened in the last half hour?" · "Status update on checkout."

**What happens:** a short spoken recap of the last hour (or the time you name): first what waits on
you ("checkout asks: push to main?"), then what each session got done, then what is still running,
each session by name. It is written when you ask, from the turns Voice OS recorded and the updates
you have not heard, so nothing runs in the background. The updates it covers are heard: the
meanwhile line does not say them again.

**In practice:** made for when you are away from the screen, over Discord or a closed page. A bare
"status" or "how far are you?" on a session's own screen still goes to that session, which knows its
work best. Without an Anthropic key, or if the recap is slow, you hear a plain version: what waits
on you, then each session's latest line.

### Past turns — `read_history`

- "What did checkout do yesterday?"
- "Which session was working on the retry logic?"

**What happens:** Voice OS searches the turns it recorded, across restarts, and answers briefly.
Only off a session's screen: on one, the session remembers its own past.

## Dev servers

### Start, stop, restart or check them — `crew_dev`

- "Start the dev servers." · "Restart them." · "Stop the servers."
- "Restart checkout's dev servers."
- "What's wrong with the dev servers here?"

**What happens:** Voice OS runs it through crew on the worktree's own ports and says how it went:
which server died, and which never started listening. If one fails after a start, it offers a fix
(`dev_offer`).

**In practice:** "Why were they failing? Check the logs." is work for the session, which reads them
with `crew dev logs`. See [Dev servers](voice-os.md#dev-servers).

## Notes and debug notes

### Take a note — `note`

- "Note: try a different tone per session."
- "Add a note to check the retries."
- "Note for store front: check the image sizes."
- "Add this too: …" Right after a note, adds to it.

**What happens:** "Noted." The note goes to the workspace on screen, the one you name, or your
general notes off a session's screen.

### Read notes back — `read_notes`

- "What are my notes?" · "Read my store front notes."

**What happens:** a brief read-back, newest last. "Go through my notes and pick one to build next"
is work, so the session reads the file itself.

### Flag Voice OS going wrong — `debug_note`

- "Debug note: it read out every option when I only wanted the question."
- "Add a note that I get double speech when a plan opens." Counts as a debug note even without the
  word "debug".
- "Add this to it too: …" Right after a debug note, adds to it.

**What happens:** "Debug note saved." Your words are saved with a snapshot of this moment, next to
Voice OS's log. Read them with `crew server debug-notes`. See
[Notes and debug notes](voice-os.md#notes-and-debug-notes).

## Docs

### Open a doc a session made — `open_doc`

- "Open the doc." The session's newest one.
- "Open the risks doc." · "Show me the artifact."
- "Open checkout's rollout doc."

**What happens:** it opens in the browser tab you spoke from. If the browser blocks the new tab
(phones usually do), a banner offers the link.

**In practice:** only docs the session listed. "Show me the diff" or "add a section on risks to the
doc" is work for the session.

## Names

### Name a session — `rename_session`

- "Rename this to api work."
- "Call checkout main payments."
- "Call store front main on Build box api work."
- "Clear the name." An empty name brings back crew's label.

**What happens:** the name shows everywhere and Voice OS answers to it. "Rename the function to
parseRef" is work, so it goes to the session, and a name-like phrase heard inside other words
("commit directly to main and release") renames nothing. See [Session names](voice-os.md#session-names).

### Name a machine — `rename_machine`

- "Rename vm1 to Build box." · "Call the GPU box training rig."

**What happens:** the machine is shown and spoken by its new name. Only with other machines set up.

## Voice OS itself

### Change how this tab listens — `hands_free`

- "Push to talk." · "Turn off hands-free." · "Stop listening."
- "On demand." · "Listen for Voice OS." Always listening, acting only on what follows "Voice OS".
- "Hands-free on." · "Start listening."

**What happens:** Voice OS confirms the mode aloud ("Hands-free."). A bare "stop" or "wait" is never
this: those interrupt. See [Listening modes](voice-os.md#listening-modes).

### Quiet — `mute`

- "Quiet." · "Shut up." · "Mute."
- "No, quiet, I don't need to hear all of that." A reason or a complaint beside it still mutes.

**What happens:** what Voice OS had queued to say is dropped, and its routine narration stops.
Sessions' own lines, questions and alerts still play.

### Words that want nothing — `ignore_words`

- "Hey." · "Okay." · "Thanks." · "Hmm."
- "And can you…" A thought cut off before it said what it wants.
- Speech that wasn't meant for Voice OS: a video, a song, someone else in the room.

**What happens:** nothing, and nothing is said. A bare "yes" or "sí" right after Voice OS's own
"Switch there?" is never ignored: it answers the offer.

**In practice:** filler in front of a request doesn't count ("hmm, let's start this" is a request),
and a question is never ignored. Thinking out loud about the work goes to the session.

## Words that never reach the kernel

Some words are settled before the kernel sees them:

- **Typed text on a session's page** goes straight to that session, unless it starts with "Voice
  OS, …", names another session, or the session is waiting on an answer from you. Then the kernel
  reads it like spoken words.
- **Dictation** goes to the session on screen.
- **"For checkout?"** A spoken yes or no settles it directly. Anything longer is routed as usual.
- **"Switch there?"** A bare no closes the offer and nothing else happens. A yes goes to the
  kernel, which switches (`switch_view`).
- **"Voice OS"** at the start wakes it in on-demand mode, and **"end of turn"** sends what you said
  at once. These are part of [listening](voice-os.md#listening-modes), not commands.
