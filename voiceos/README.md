# Voice OS

crew's server and its web page. The page has two halves behind one Home: **Voice OS**, a voice and
web cockpit that runs one Claude Code session per worktree through the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk), streams their output to the browser,
and lets you answer permissions and questions, dictate, and hear "done" and "waiting on you", by
voice or by click; and **Set up**, which configures crew through its CLI (`POST /api/crew`). crew
owns its lifecycle: bare `crew` starts it and opens the page, `crew server …` manages it. `crew voice …`
is the same command, forever. What one machine runs on another (`crew voice _attach`, `voice logs
--local`, `voice machines`, `voice _restart`, the dev-push handoff) keeps the `voice` spelling on
purpose: an older crew on the other end knows only that one.

**Using Voice OS?** Read the [Voice OS guide](../docs/guides/voice-os.md): install, keys, Set up,
Active and Activate, listening modes, active sessions, approvals, other machines, troubleshooting and
privacy. [Voice OS commands](../docs/guides/voice-os-commands.md) lists every kernel tool with
things to say; a tool change updates its section (`src/tools/definitions.spec.ts` checks each has
one). This README is for working on Voice OS itself. [CONTRIBUTING.md](../CONTRIBUTING.md)
covers the repository-wide rules.

## Run it

```bash
crew          # downloads the server on first run, starts it, opens the page (keys are asked there)
```

The download matches your crew version and `crew update` keeps it current. To run your own
build instead:

```bash
cd voiceos && bun install && bun run install-dev
crew server restart
```

`install-dev` compiles into `~/.crew/bin/voiceos` (or `$CREW_VOICEOS_BIN`) and removes the
`.version` stamp, so the next `crew update` replaces it with the release.

With remotes, a build from source alone can't connect: a remote refuses a main on another version.
`crew server dev push`, from a crew checkout on any machine (the main or a remote), builds that
checkout's crew and Voice OS for every machine's OS and CPU (`scripts/build-dev.ts`), stamps them
`dev-<commit>`, and the main puts them everywhere and restarts every machine, the one you pushed from
last — detached, so it survives the restart. `crew server dev status` follows it.

To run from source with its own state (token, sessions, active set, logs) instead of your real
`~/.crew/voiceos`, point its config folders at a scratch directory and sign in with the token it
writes. The crew CLI it calls still reads your real `~/.crew`, so it shows your real worktrees. Use
a throwaway `HOME` (see [CONTRIBUTING.md](../CONTRIBUTING.md)) to isolate crew too.

```bash
export CREW_CONFIG_DIR=/tmp/voiceos-dev/.crew VOICEOS_KEYS_DIR=/tmp/voiceos-dev/keys
PORT=4100 bun run dev
open "http://localhost:4100/login?token=$(cat /tmp/voiceos-dev/.crew/voiceos/token)"
```

A Voice OS that crew did not launch (`VOICEOS_RECORD_STATE` unset) never writes `state.json`, so
it cannot take over the port and pid crew tracks. It calls whichever `crew` is on PATH, or
`$CREW_BIN`.

## Keys and environment

Keys live in files readable by you alone, never in your shell environment. An exported
`ANTHROPIC_API_KEY` would switch every Claude Code session to per-token billing, so workers have
it (and the other keys) removed from their environment (`sessions/worker.ts`, `buildWorkerEnv`).

| File | For |
| --- | --- |
| `~/.config/crew-voiceos/soniox.key` | speech in and out (Soniox) |
| `~/.config/crew-voiceos/anthropic.key` | the kernel, the judge and the question writer (Haiku) and the narrator (Sonnet) |
| `~/.config/crew-voiceos/discord.key` | optional: the Discord bot (`crew server discord setup`) |

The page asks for missing keys (Set up's `keys_set` command, the value on stdin, this Mac only);
`crew server start` asks at a terminal. Both check each with its service
(`crew/internal/voice/keys.go`). `crew server keys` lists them, and `crew server keys set
<anthropic|soniox>` reads one from stdin. A running server watches the keys folder and rebuilds
everything keyed (`src/keyed-services.ts`: TTS, STT, kernel, judge, narrator, question writer) when
a key file changes, so a new key needs no restart. Voice OS's own lookup (`src/config.ts`, `loadKeys`), in
order:

- **anthropic:** `VOICEOS_ANTHROPIC_API_KEY`, then `anthropic.key`, then `ANTHROPIC_API_KEY` in
  Voice OS's own environment.
- **soniox:** `SONIOX_API_KEY`, then `soniox.key`.

With a key missing, Voice OS still starts: the page shows a banner, and text and clicks work.

| Variable | Effect |
| --- | --- |
| `VOICEOS_KEYS_DIR` | Where the key files are (default `~/.config/crew-voiceos`). crew reads the same variable. |
| `CREW_CONFIG_DIR` | Voice OS's view of crew's folder (default `$HOME/.crew`). Its state goes in `voiceos/` under it. The crew CLI does not read this variable. |
| `VOICEOS_CLAUDE_BIN` | The `claude` to run. crew sets it from the `claude` it found, because the tmux server's PATH is not the caller's. |
| `CREW_BIN` | The crew binary Voice OS calls back into (crew sets it). |
| `PORT` | The gateway's port (crew passes the remembered one; `0` picks one). |
| `VOICEOS_PROXY_HOST`, `VOICEOS_PROXY_PORT`, `VOICEOS_PROXY_HTTPS_PORT` | The dev proxy's address, for the allowed WebSocket origins. |
| `VOICEOS_RECORD_STATE=1` | Set by crew only: this instance writes `state.json`. |
| `VOICEOS_DEBUG_AUDIO=1` | Saves every push-to-talk press as a WAV (with what was heard) under `~/.crew/voiceos/debug/`. Contributor switch for speech bugs. `crew server` never sets it, so run from source to use it. |
| `VOICEOS_DEBUG_SPEECH=1` | Lets a page inject heard words with `window.voiceos.say("…")`, for demos and screenshots. Refused otherwise. |
| `VOICEOS_REMOTE_EXEC` | Tests and QA: a shell command run instead of `ssh` for a machine link. |
| `VOICEOS_REMOTE_UPDATE_EXEC` | Tests and QA: a shell command run instead of `ssh … crew update` when a remote is behind. |
| `VOICEOS_LIVE=1` | Enables the live Claude session tests. |

## How it is built

One pure reducer owns the state. Clicks, voice commands, worker events and speech all become
**inputs**. The reducer returns the next state and the **effects** to run (send to a worker, speak,
start dev servers, and so on). The store stamps every input, and each browser replays the same
stamped inputs, so every tab and device shows the same thing.

```
browser (src/web) ──ws──▶ gateway ──▶ router ──▶ kernel (Haiku, src/tools) ──▶ store/reducer
                                                                                    │ effects
              speech in/out (Soniox) ◀── voice-in / voice-out ◀── narrator ◀────────┤
                                                   sessions (Agent SDK, one per worktree)
                                                   remote machines (SSH links)
```

### Module map

| Path | What it owns |
| --- | --- |
| `src/app.ts` | The cockpit's wiring: paths, keys, store, sessions, speech, kernel, gateway, persistence, shutdown. |
| `src/main.ts` | One binary, two roles: no arguments is the cockpit, `remote serve` / `remote attach` a remote. |
| `src/config.ts` | Paths under `~/.crew/voiceos/`, key lookup, the sign-in token. |
| `src/state/reducer.ts` | The reducer and its effects. The inputs are split by concern into `asks.ts` (permissions, plans, questions, allow-once), `delivery.ts` (send, queue, aside, now), `held-lines.ts` (what a session off screen may say), `machines.ts`, `active.ts` (activate, deactivate, `active_loaded`), `names.ts`, `commands.ts` (`/clear`, `/compact`), `redirect.ts`, `take-back.ts`, `continuation.ts`, `subagents.ts` (the running sub-agents and their transcripts, `subagentRuns`, capped: every browser replays them). `store.ts` stamps and fans out. |
| `src/shared/` | Types and pure helpers shared by server and page: `protocol.ts` (state, inputs, messages), `machine-ref.ts` (`vm1:store-front/main`), `active.ts` (`isActive`, `listActiveRefs`: the one reading of the active set), `machines.ts` (labels, `parentView`, waiting lists), `spoken.ts` / `spoken-tags.ts`, `notes.ts`, `route-chip.ts`. |
| `src/router/` | `router.ts` routes each utterance, one at a time. Typed text on a session page goes straight to that session, and everything else goes to the kernel. `kernel.ts` is the Haiku kernel and its prompt. `refs.ts` resolves spoken names to sessions. |
| `src/tools/` | The kernel's tools: `definitions.ts` (schemas, and the order is part of the prompt), `tools.ts` (execution), and one file per tool that has rules of its own (`answer.ts`, `send.ts`, `queued.ts`, `activate.ts`, `chats.ts` (plain sessions: `new_session`, `remove_session`), `list-sessions.ts`, `rename.ts`, `machines.ts`, `docs.ts`, `hands-free.ts`). `call-lines.ts` and `recent-action.ts` decide what the kernel remembers of its own calls. |
| `src/sessions/` | One Agent SDK session per worktree (`worker.ts`), started, resumed and stopped by `manager.ts`, with session ids kept in `registry.ts`. `events.ts` maps SDK messages to observations, `permissions.ts` bridges `canUseTool` to the page, `side-answer.ts` runs asides, `history.ts` rebuilds streams from Claude Code's transcripts at boot, `media.ts` stores images, `doc-links.ts` finds docs, `setup-session.ts` defines the setup session, and `voice-context.ts` holds the orientation every session gets. |
| `src/judge/` | `judge.ts`: one narrow Haiku question about what the developer's words mean, in any language (`JUDGE_QUESTIONS`, a forced `verdict` tool with an enum answer). Asked only by a guard about to act; a timeout or failure is `unclear`, every guard's safe side. It logs the question key, verdict and ms, never the words. Specs use `test/support/english-judge.ts`. |
| `src/narrator/` | After a turn, `turn.ts` speaks the session's own spoken line, or asks the Sonnet narrator (`narrator.ts`, `prompt.ts`) to summarize one without it. `about.ts` names what a session's question is about (Haiku). |
| `src/speech/` | `voice-in.ts` handles push to talk and dictation (a press held open until sent), and `listener.ts` the always-listening modes, with `wake.ts` (on demand), `turns.ts` (when a turn ends, "end of turn"), `echo.ts` (its own voice heard back) and `stt.ts` (Soniox STT). `voice-out.ts` and `queue.ts` handle what is said and when (alerts first, never over your voice, reminders, mute), and `tts.ts` streams Soniox TTS over one kept-open WebSocket. `instant-ack.ts` is Voice OS's own filler (see below). |
| `src/recap/` | The status update (`status_update`): `recap.ts` (pure: what goes in — each session's waits, unheard update and recorded turns in the time asked about — the prompt, and the plain recap said without a model) and `writer.ts` (Haiku, one try, 6 s timeout). Written only when asked; the updates it covers are heard (`recap_heard`). |
| `src/voice-lines/` | Haiku words Voice OS's follow-up lines ("Sent to X. Switch there?"): `prompt.ts` (pure: the prompt, the message, the rules a worded line must keep) and `writer.ts` (one try, short timeout, `createFallbackWriter` without a key). |
| `src/memory/` | Files that outlive a restart: `journal.ts`, `view.ts`, `active.ts`, `names.ts`, `notes.ts`, `debug-notes.ts`. Writes go through `json-file.ts` (atomic). |
| `src/dev/` | Dev servers through crew: `servers.ts` and `watch.ts` (crash detection, the fix offer). |
| `src/crew/` | `adapter.ts`: Voice OS's own calls into the crew CLI (`ls worktrees`, `show`, `dev …`, `fix --print`) and `spawnRunner` (stdin, a timeout that kills). `commands.ts`: Set up's `SetupCommand` union (zod, browser-safe), the pure `toCrewArgv`, per-variant traits (timeout, local-only, detached, json); `test/fixtures/shared/setup-argv.json` is one sample per variant, walked through crew's help tree by a Go test. `api.ts`: `POST /api/crew` (`checkRequest`, validation, status codes) and `createSetupRunner` (here, detached, or over a machine's link). |
| `src/keyed-services.ts` | Everything built from the Anthropic and Soniox keys, held behind getters and rebuilt when a key file changes. |
| `src/gateway/` | HTTP and WebSocket on 127.0.0.1. `/`, `/voice…` and `/setup…` all serve the one page (its router picks the half). `auth.ts` handles sign-in (a host-only cookie set from `~/.crew/voiceos/token`) and the exact Origin check; `checkRequest` (`crew/api.ts`) is shared by `/ws` and `/api/crew`, which also wants `Content-Type: application/json` and never echoes a body. `validate.ts` checks inbound messages, and `/media` serves the media folder and nothing else. |
| `src/remote/` | Other machines (see below). |
| `src/discord/` | The Discord voice channel (see below). |
| `src/web/` | The React page, bundled by Bun: `App.tsx`, `components/`, `derive.ts` (pure view logic), `use-connection.ts`, the mic (`audio.ts`, `ptt.ts`, `listen-mode.ts`) and the player (`use-speech-player.ts`, `pcm.ts`). The design reference is `design/crew-web.html`: the prototype of every screen, with its design brief. |

### Behaviours worth knowing before you change them

- **Spoken lines come from the sessions.** Every message a session writes for the developer opens
  with `<spoken>…</spoken>` (`<spoken asks>` for a question), which is said the moment the tag
  closes in the stream (`src/shared/spoken-tags.ts`). Work opens with a short acknowledgement and
  ends with a report line. A final message without a tag is summarized by the narrator. Voice OS
  adds only what the session cannot know yet: "after its current work", "starting it up", a crash.
  `sessions/voice-context.ts` is where sessions are told this.
- **Voice tags.** A spoken line may carry one bracketed cue that Soniox reads as delivery, not
  words. Only the tags in `ALLOWED_TAGS` (`src/shared/spoken.ts`) are kept: `laughs`, `chuckles`,
  `sighs`, `pause`, `warm`, `reassuringly`, `excited`, `curious`, `relieved`. Any other `[tag]` and
  any SSML is removed before speech, because Soniox would read it aloud. Stored, shown and matched
  text goes through `stripTags`. The same list is given to sessions in their orientation, so
  changing it changes the prompt.
- **Artifacts.** Workers get the SDK's Artifact tools (`CLAUDE_CODE_ARTIFACT=1` in `buildWorkerEnv`; a
  developer's own value stands): docs they make show as cards opened by voice.
- **Auto mode.** Workers run in the SDK's `auto` permission mode. A `permission_denied` becomes a
  denial on the page. "Allow it" switches that worker to `default` mode for one retried call, which
  Voice OS approves without asking, and then back to `auto` (`state/asks.ts`, `allowDenied`,
  `restoreAutoEffects`).
- **Asides.** While a session works, a question to it is answered aside (`sessions/side-answer.ts`):
  a throwaway fork of its conversation, one turn, every tool denied, like Claude Code's `/btw`.
  "By the way" forces an aside, "queue it" forces the queue, "send it now" replaces the work — unless
  agents it started still run: an interrupt would stop them, so the words (a promoted queued message
  or a spoken follow-up too) are folded into the running turn, read between tool rounds (the
  kernel's `deliver` argument for spoken words, in any language; typed text keeps the English
  keywords), and a question that needs tools or changes the work is queued after all
  (`state/delivery.ts`, `decideDelivery`). Asides are not saved.
- **Held lines.** A session off screen does not speak its lines. Its update waits in `meanwhile`
  and is said with the others' in one line once it is quiet (`speech/meanwhile.ts`, `state/meanwhile.ts`),
  in the session's own words (`describeDoneAbout`: its last line, shortened), and the full line plays
  on switch (`state/held-lines.ts`). An item is dropped once the developer meets that update another
  way (`settleMeanwhile`). The line is spoken with `isUpdate` and the `refs` it named, like a "needs
  you" announcement: `listHeardBefore` shows it to the kernel as heard, for "switch to it" and
  read-backs, never as where the next words go. A line about one session that told no ask in full
  ends "Switch there?" and opens `state.switchOffer` for it (`playMeanwhile`), unless an offer is
  still open; one naming several asks nothing. Another session's question, plan or permission, on a
  session's screen, joins it too (`ask_opened`, `askId` on the item): needs-you first, after a
  3 s breath (`MEANWHILE_ASK_QUIET_MS`), with the needs chime, in words read from the live ask when
  the line plays (`describeAskForMeanwhile`) — one answered meanwhile is left out. A permission or a
  short question is said in full (`toldAsks` on the line): heard, even cut short, it is answered like
  any question asked aloud; a line asking for two sessions answers neither on a bare yes. A plan or a
  long question is only its gist: a bare yes to it asks "Switch to X?" (it may only acknowledge),
  while "switch to it" right after it switches at once (`refuseAnnouncedOnly`).
- **Words go to the screen, or to a session named in them.** Nothing guesses that words were "really"
  for another session. `send_to` X from a session's screen goes through only when X is named in the
  developer's words, checked in code (`isRefNamedIn`: its ref, its workspace — shared by siblings, so
  ambiguous still counts as named — or the developer's own name for it, on the machine said if one
  is), and the judge's `spoken_to` says they speak to X rather than mention it
  (`tools/send-guard.ts`). Unnamed, the code forwards them to the screen itself (`forwardChosen`,
  `tools/forward.ts`); earlier words pointed at an unnamed session ("I meant that for the other one")
  are refused instead, since the screen already got them. Named but only mentioned, Voice OS asks
  "For X?" (`ask_which`, `state/target-ask.ts`, settled by `router/target.ts`) and holds the words:
  yes sends them there, anything else keeps them on the screen. A bare yes or no to a session's
  permission or plan is sent to the answer tool first (`describeMisroutedAnswer`). The exceptions
  are code paths, not guesses: a yes to "Want me to ask
  it?" (`askedBack`), earlier words pointed at a named session ("I meant that for X"), the `answer`
  tool's reply to a question the session ended its turn on — only once that question was heard
  (`findLastAskedAloud`, `wasJustHeardAbout`) — and off a session's screen (the kernel's "Mission
  Control": Active, Activate, Settings), where the kernel asks which
  session itself. A session's long lines off screen come back through the meanwhile line; a short
  one (`isShortLine`) is still said at once, named.
- **"Sent to X. Switch there?"** (`state/sends.ts`, `followSends`): spoken words that went to a
  session not on screen say so and offer the switch in the same line (`state.switchOffer`), unless
  X is out of reach, X has its own open question, or an offer is still open; typed words get "Sent to
  X" alone. Words said on a screen the developer clicked away from say nothing (`saidOn`). A bare
  yes after the offer never approves another session's permission (`isClearlyAnswerFor`); a bare no
  closes it in the router, without the kernel. Its window, and "For X?"'s, count from when the
  question was heard (`heardAt`, 8 s; 30 s if it never plays). Speech ranks Voice OS's acks and the
  kernel's replies first (`speech/queue.ts`) and holds everything, never drops it, while the
  developer talks. "Switching to X" is said for a switch Voice OS makes, "Back to X" for `go_back`
  (`state/view-history.ts`, five views).
- **Responsive, not talkative.** Two things fill the silences, and each errs toward saying nothing.
  - *Instant acknowledgement* (`speech/instant-ack.ts`): when the router hands a spoken turn to the
    kernel (`RouterOptions.onKernelTurn`, wired in `app.ts`, off in the conversation tests), a
    neutral pool line ("Mm-hm.", "Got it.", never one of the last two; after words ending in a question
    mark only "One sec." or "Let me check.", which cannot be heard as a yes) plays 600 ms after the router
    took the words, unless the words are under four (`MIN_REQUEST_WORDS`), Voice OS is muted, spoke
    in the last 6 s, already queued its answer, has something playing or queued, or the developer is
    talking (`decideInstantAck`). An ack not yet heard is withdrawn when the answer arrives or the
    developer speaks. Pool lines carry no voice tags; `keepsTags` on a pool line voices one anyway.
  - *Worded follow-ups* (`voice-lines/`): "Sent to X", "…Switch there?", "Switching to X", "Back to
    X", "Activated X…" and "Okay, after its current work." carry `facts` (`shared/follow-up.ts`) on
    their speak effect; the reducer still decides whether they are said and which offer is open
    (`withSwitchAsked` sets `offersSwitch` in the step that appends the question). `voice-out` queues
    the fixed text at once and holds its place while Haiku words it — 1 s after an ack, 0.6 s
    otherwise — then plays whichever is ready. A worded line that drops a label, asks a question
    nobody offered (or drops the offered one), says the wake word or runs past 25 words is not used.
    The duplicate drop (debug note 31) compares the fixed text.
  - Both are *filler* (`isFiller` on the line): no chime, a filler line about a session off screen
    is dropped rather than held, and it is never Voice OS's question, never heard before, never the
    session's own line, and never resets the quiet the meanwhile line waits for.
- **Only active sessions exist for voice.** An active session's Claude runs; an inactive one has
  no process (`startWorker` in `state/helpers.ts` refuses it, which covers send, "now" and
  reconnect), is left out of the kernel's turn, and says nothing: one gate in `speech/connect.ts`,
  one in `dev/watch.ts`, the reconnect recap, and `addMeanwhile` for late worker events.
  `shared/active.ts` is the one reading of the set (`isActive`, `listActiveRefs`) outside the
  reducer and its persistence. Deactivate goes through `stopWorker`, which shares `releaseRefs` with
  removing a machine. `machine_resynced` matches a remote up on every connect: active and stopped starts,
  inactive and running stops. Words to an inactive session wait in its queue behind "X isn't active. Activate
  it?" (`state.switchOffer` with kind `activate`); a yes activates it and its start sends them.
  An `activate` for a worktree Voice OS has not listed yet (Set up's "Open Voice OS" moments after
  crew made it; `open: true` also shows it) is held in `state.pendingActivations` and answered with
  a `refresh_worktrees` effect (crew's `ls worktrees` read at once); the next list that has it
  applies it, and one older than `PENDING_ACTIVATION_MS` is let go.
- **The setup session is out of voice.** One per machine (ref `setup`, `vm1:setup`), in the home
  folder with the crew CLI: Set up's "Setup with Claude" chat, which sends with the ordinary
  `send` and answers its asks with the `answer_*` inputs. `isActive` is false for every setup ref
  (`isSetupRef`), so it is never in the kernel's turn, never narrated, never in the meanwhile line,
  never a switch offer or "Sent to" (`state/sends.ts`), never reminded, and its asks are not voice's
  (`listHeardAsks`). It still runs: `canRun` (active, or a setup ref) is asked only at the lifecycle
  sites — `startWorker`, `matchMachine`, the resync drain and delivery — so a send to a stopped
  setup starts it and words queue while it works. Names never resolve to it (`findRefsByName`),
  `activate` refuses it, `showView` never opens it, and `active_loaded` drops a stored one. On the
  wire it is still `Session.isPinned` (older remotes read it); `SETUP_ORIENTATION` tells it it is
  Set up's chat.
- **The active set and names are cockpit preferences**, not crew state, and have no CLI form. Both
  are keyed by machine ref, dropped at load for machines the state does not know, and saved only
  after the saved list has been merged (`memory/active.ts`, `memory/names.ts`). `active.json` is
  read first; `pinned.json` only when it does not exist (setup dropped), then written as
  `active.json`. A corrupt `active.json` is an empty set. A name is unique across sessions,
  because voice routes by it (`state/names.ts`).
- **Views** are `active` (home) | `session` | `activate {machine?}` | `settings`; the voice log of
  every non-session screen is keyed `HOME_SCREEN`. A machine removed, or a session gone, falls back
  to Active.
- **Restart keeps the screen.** `memory/view.ts` saves the view on every `switch_view` and restores
  it at boot; `migrateSavedView` reads an earlier release's (`machines` → Active, `grid{machine}` →
  Activate). For a remote session it waits up to `VIEW_RESTORE_MS` for the machine. A page that
  connects within two minutes of a boot that found a saved view hears "Voice OS restarted."
- `/clear` and `/compact` (typed or said) wait for an explicit yes (`src/state/commands.ts`).
- **No English patterns over what the developer means.** A guard that reads the developer's words
  (consent, take-back, misroute, mute, listening, a stop, words for a session not on screen, "For
  X?") asks the judge, after
  language-neutral fast paths in code: word counts, a closing `?`, verbatim spans, session names,
  option labels. What the kernel already reads while routing is a tool argument instead, at no extra
  call: `deliver`, `my_notes` (required, so it is always decided), `about_last_action`. The speech layer (`speech/turns.ts` stop words and "end of turn", `wake.ts`, filler)
  and typed keywords stay English on purpose. The languages Soniox expects are `state.languages`
  (`shared/languages.ts`, saved in `languages.json`), sent as `language_hints`.

### Remote machines

`src/remote/`: a remote runs the same binary as `voiceos remote serve`, a daemon that crew keeps in
tmux (`crew server remote`). It runs only the session manager (`host.ts`), behind a 0600 unix
socket. `voiceos remote attach` bridges an SSH login to it, and `crew voice _attach` execs it
(`ssh.ts` builds the SSH command, with `BatchMode=yes`). The main keeps the one reducer:

- Refs carry the machine (`vm1:store-front/main`, `src/shared/machine-ref.ts`).
- `mapping.ts` routes effects out and prefixes reports in.
- A reconnect is a snapshot the main reconciles (`resync.ts`), with one recap line, and never an
  event replay. Effects not yet acknowledged ride in the next hello and are applied once.
- `link-state.ts` turns an SSH exit into the reason the machine card shows.
- A remote on another release refuses the main. When the remote is behind, the main runs `crew update`
  there over SSH (`ssh.ts` `updateRemoteCrew`, `versions.ts` `decideVersionFix`), once per remote
  version per run, and reconnects; the daemon switches release on that connect, at once. A newer
  remote is never downgraded, and a `dev` build on either side updates nothing.
- Either side may run the other's crew with a `call` / `result` pair (`protocol.ts`). Calls are
  never effects: not queued in the outbox, not replayed after a reconnect. `pending-calls.ts` keeps
  the ids and timers on both ends, and rejects what is in flight when the link goes.
  - Main → remote: `dev …` and `fix --print` for the dev watch (`host.ts` `isAllowedCrewCall`),
    and Set up's typed commands: the call carries `command` (and the variant's timeout), the remote
    validates it with the same schema and builds the argv itself (`planCrewCall`; local-only
    variants refused). A remote too old to know `command` strips it and refuses the args with `not
    allowed`, which the main turns into `remote_outdated` with that remote's version.
  - Remote → main: `crew server logs|debug-notes|notes` run on a remote asks the daemon's second
    0600 socket, `query.sock` (`query-socket.ts`: one `{"args":[…]}` line in, one answer line out,
    shapes in `test/fixtures/shared/query-socket.json`, shared with crew's Go client). The host
    forwards it to the attached main, answering `no-main` at once when none is attached or the link
    drops, `timeout` after 30 s. The main admits only those read-only commands (`link.ts`
    `isAllowedQuery`, never `--local`), runs its own crew one query at a time with a 25 s deadline,
    and relays `{code, stdout, stderr}` as they are; output over 2 MB comes back as an error.

The machine list is `~/.crew/voiceos/machines.json`. It is written only by `crew server machines`
(the page and voice go through it) and watched while running (`cockpit-machines.ts`).

### Discord voice channel

`src/discord/`: a bot sits in one voice channel of the developer's own server; joining it from a
phone is like opening the page and talking. `crew server discord setup` takes only the bot token and
works out the server (the only one the bot is in), the owner (the server's owner) and the channel
("Voice OS", else the only voice one), writing `discord.json` and `discord.key`. Voice OS watches
`discord.json`, so setup and `off` apply without a restart.

- **One more client, `discord`.** `app.ts` `sendToClient` sends its messages to the bridge, the
  others to the gateway. While the owner is in the channel, Discord is the speaker and the one
  listener (`voiceIn.listen('discord', 48000, mode)`); a page's mic is refused and its audio stops,
  and the page shows "Voice via Discord", a badge for the mic and the live words in the composer.
  On leaving, the speaker goes back to the page used before (`seat.ts`). If speech-to-text gives up,
  the page says "not hearing" until a mode is picked again.
- **Only the owner is heard.** `link.ts` subscribes to the owner's stream alone; nobody else's audio
  is received or decoded. Discord sends nothing while they are quiet, so `bridge.ts` feeds silence
  frames: speech-to-text needs them to end a turn.
- **Speech out.** Each clip is cut into 20 ms frames (`audio.ts`: 24 kHz mono → 48 kHz stereo),
  encoded with opusscript (`codec.ts`, its wasm embedded by a `bun patch` in `patches/`) and streamed
  to one audio player; the player going idle after the last chunk is the clip's `audio_done`.
  `discord.ts` follows the setup; `link.ts` reconnects with backoff (a refused token is not retried), writes `discord-status.json` for
  `crew server discord status` and keeps the mode (on demand or hands-free) in `discord-mode.json`.
- **Sessions know.** While the developer is in the channel, every send carries a note
  (`voice-context.ts` `buildDiscordNote`): they hear spoken tags but see nothing on the page.
- DAVE end-to-end encryption is on (`@snazzah/davey`, a native package per platform).

### State on disk

Everything is under `~/.crew/voiceos/` (`src/config.ts`, `resolvePaths`):

| Path | What |
| --- | --- |
| `token` | The sign-in token (0600, tightened if looser). |
| `state.json` | Port, pid, start time and machine statuses, for crew (`VOICEOS_RECORD_STATE` only). |
| `sessions.json` | The registry: each ref's Claude Code session id and briefing version. |
| `view.json` | The last view shown — saved whenever the view moves (a switch, or an activation that opens its session). |
| `active.json` | Active refs, in activation order. `pinned.json` is read once, only when this file does not exist. |
| `names.json` | Session names by ref. |
| `languages.json` | The languages the developer speaks, sent to Soniox as hints. |
| `journal/<ref>.jsonl` | Append-only: every turn's ask, result, cost and HEAD, used by `read_history`. |
| `notes/<workspace>.md`, `notes/_general.md` | The developer's notes, one line each (`crew server notes`). |
| `media/` | Images by content hash, swept after 30 days. |
| `machines.json` | Other machines (crew writes it). |
| `discord.json`, `discord-status.json`, `discord-mode.json` | The Discord voice channel: its setup (crew writes it), whether Voice OS is in it, and the listening mode there. |
| `logs/voiceos.log` | The log (`crew server logs`). It contains what the developer said. Rotated at 20 MB into `voiceos.log.1` … `.5`, newest first (`log.ts`); `ts` stays the first key of each line, since crew compares it before decoding. |
| `logs/debug-notes.jsonl` | Debug notes, each with a state snapshot (`memory/debug-notes.ts`, `crew server debug-notes`). Never rotated. |
| `debug/` | WAVs, only with `VOICEOS_DEBUG_AUDIO=1`. |
| `remote/` | A remote daemon's own registry, media, sockets (`remote.sock` for the link, `query.sock` for crew's queries), `daemon.json` and log (rotated the same way). |

## Develop and test

```bash
bun install
bun run check                      # biome + eslint
bun run typecheck                  # native TypeScript (tsgo)
bunx tsc --noEmit                  # classic tsc
bun test src evals                 # unit specs, no network (bun run test)
bun test test/ui                   # browser tests (Playwright Chromium)
```

The live tests cost money, never run in CI, and run only when asked with `VOICEOS_LIVE=1`
(`bun run test:live` runs them all):

```bash
VOICEOS_LIVE=1 bun test test/live/session.test.ts   # real Claude sessions on Haiku
VOICEOS_LIVE=1 bun test test/live/audio.test.ts     # Soniox fixtures → STT; bills Soniox
VOICEOS_LIVE=1 bun test test/live/tts.test.ts       # Soniox streaming TTS: first-chunk latency, cancel then reuse; bills Soniox
```

Without `VOICEOS_LIVE=1` they skip, so a bare `bun test` costs nothing. The Soniox ones also need a
Soniox key (`~/.config/crew-voiceos/soniox.key` or `SONIOX_API_KEY`); each run costs a fraction of a
cent.

## Evals

The kernel and narrator prompts are tested against the real models. Every eval run bills your
Anthropic key, so work with `--only` and run the full suite once before review:

```bash
bun evals/run.ts kernel --only=start-by-topic,stop-by-topic     # just the cases your change touches: no scores, no baseline
bun evals/run.ts all                                   # narrator (Sonnet) + kernel (Haiku); fails below floors or baseline
bun evals/run.ts all --update-baseline                 # after an intended change, full run only
```

A full run is a few hundred cases and costs about $1–2. [CONTRIBUTING.md](../CONTRIBUTING.md) has
the current figure. `--kernel-model=` and `--narrator-model=` try another model without touching
the baseline. Cases live in `evals/kernel/cases.json` and `evals/narrator/cases.json`; kernel cases
with a `-de`, `-sl` or `-es` suffix are the same situations in another language. The judge has its
own eval over its questions in four languages (`evals/judge/cases.json`, a few cents a run):

```bash
bun evals/judge.ts --only=approves,take_back
```

The route suite is separate and never part of `all`: it measures only where words go on a session's
screen (for the session, or a Voice OS command), scoring today's kernel against a narrow classifier
on the 297 cases in `evals/route/cases.json`, plus the developer's own speech cases when
`~/.crew/voiceos/evals/route-speech.json` exists (real work, so never in the repo). Run it only for
that question; it prints its own cost, and has no baseline:

```bash
bun evals/run.ts route --system=both     # repo cases: kernel ~$0.85, classifier ~$0.20; with ~390 speech cases ~$2.40
```

The voice-lines suite, also outside `all` and never a gate, checks Haiku's worded follow-ups
against the app's own rules and for invented facts (`evals/voice-lines/cases.json`,
about 17 cases, two runs each, a few cents):

```bash
bun evals/run.ts voice-lines --only=sent-offer,queued
```

Speech fixtures:

```bash
bun scripts/gen-audio-fixtures.ts <id>…   # regenerate after editing evals/audio/cases.json (bills Soniox TTS)
```

Eval cases use crew's generic example names (store-front, store-api, checkout-api, signals, admin,
infra-ops) and are patterned on real sessions, never copied from them.

## Release

`scripts/build-release.ts <version>` builds `voiceos_<version>_<os>_<arch>.tar.gz` for
darwin and linux, arm64 and amd64. GoReleaser attaches the archives to the crew release
(`release.extra_files`), and crew downloads the one that matches its own version. The Linux builds
target glibc. All four are built on one runner, so dependencies are installed for every platform
(`bun install --os='*' --cpu='*'`: the Discord E2EE library is native), and `scripts/compile-flags.ts`
embeds opusscript's wasm and leaves out the optional codecs the Discord libraries fall back from.
