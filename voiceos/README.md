# Voice OS

A voice and web cockpit for crew. It runs one Claude Code session per worktree through the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk), streams their output to the
browser, and lets you answer permissions and questions, dictate, and hear "done" and
"waiting on you" — by voice or by click. crew starts it: `crew voice`.

## Use it

```bash
crew voice    # downloads Voice OS on first run, asks for its keys, starts it, opens the sign-in link
```

The download matches your crew version and `crew update` keeps it current. To run your own
build instead: `cd voiceos && bun install && bun run install-dev` (it compiles into
`~/.crew/bin/voiceos`; the next `crew update` replaces it with the release).

Open a link `crew voice` prints. Browsers grant the microphone only on localhost or HTTPS: the
localhost link works on this Mac, and the proxy link (`https://voice--os.<domain>`) works on any
device that trusts crew's CA — `crew dev proxy trust` shows how, once per device. Hold **Space** to
talk; type in the bar at the bottom otherwise. **Esc** goes back to Mission Control.

The first `crew voice` at a terminal asks for the two API keys it needs and checks each with its
service before saving it; `crew voice keys` shows which are set, and `crew voice keys set
<anthropic|soniox>` sets one from stdin. Keys live in files readable by you alone, never in your
shell environment (an exported `ANTHROPIC_API_KEY` would switch every Claude Code session to
per-token billing):

| File | For |
| --- | --- |
| `~/.config/crew-voiceos/soniox.key` | speech in and out (Soniox) |
| `~/.config/crew-voiceos/anthropic.key` | the kernel (Haiku) and narrator (Sonnet) |

The Claude sessions themselves run on your Claude Code login, with no API key in their
environment.

## How it is built

- `src/state/reducer.ts` — one pure reducer. Clicks, voice commands, worker events and
  speech all become inputs; it returns the next state and the effects to run. The store
  stamps every input, and each browser replays the same stamped inputs, so every tab and
  device shows the same thing.
- `src/sessions/` — one Agent SDK session per worktree: permissions and `AskUserQuestion`
  bridged to the UI, queued messages sent only after a turn ends, interrupt, resume by
  session id. On start, each resumed session's cockpit stream is rebuilt from Claude Code's
  own transcript (`history.ts`).
- `src/router/router.ts` — every utterance goes to the kernel, one at a time; text typed
  into a session's own box goes straight to that session.
- `src/gateway/` — HTTP and WebSocket on 127.0.0.1. Sign-in is a host-only cookie set from
  the token in `~/.crew/voiceos/token`; the WebSocket also requires an exact Origin.
- `src/web/` — React, bundled by Bun. Design: `design/mockups.html`.

- `src/narrator/` — after every turn a Sonnet narrator decides what to say and whether the
  session now waits on you; `src/speech/` queues it (alerts first, never over your voice)
  and streams it from Soniox TTS over one kept-open WebSocket; the browser plays the PCM
  chunks as they arrive (`src/web/use-speech-player.ts`). `src/router/kernel.ts` decides what each utterance does,
  with the tools in `src/tools/`.
- Sessions write their own spoken lines: each message for the developer opens with
  `<spoken>…</spoken>` (`<spoken asks>` for a question), said the moment the tag closes in the
  stream (`src/shared/spoken-tags.ts`). Work opens with a short ack line and ends with a report
  line; a final message without one is summarized by the narrator. Voice OS adds only what the
  session cannot know yet: "after its current work", "starting it up", a crash.
- `src/memory/` — each session's topic, and an append-only journal of every turn (asked,
  done, cost, HEAD) that the kernel reads for "what did checkout do yesterday".
- The pinned **setup** session runs in your home directory with the crew CLI, for crew setup
  only — workspaces, projects and worktrees: say "setup, make a worktree in store-front for
  the search fix". Dev servers and code belong to each worktree's own session.
- While a session works, a question to it is answered **aside** (`src/sessions/side-answer.ts`):
  a throwaway fork of its conversation, one turn, every tool denied, like Claude Code's `/btw`.
  Instructions still queue. "By the way" forces an aside, "queue it" forces the queue, and a
  question that needs tools or changes the work is queued after all. Asides are not saved:
  they are gone after a restart.
- `/clear` and `/compact` (typed or said) wait for an explicit yes (`src/state/commands.ts`).
- "Stop listening" / "hands-free on" switch hands-free in the tab you spoke from.
- The session screen lists running sub-agents with their current step, from the SDK's task
  events.

State lives in `~/.crew/voiceos/` (token, sessions, topics, journal, logs). `crew voice
logs` tails the log.

## Evals

```bash
bun evals/run.ts all          # narrator (Sonnet) + kernel (Haiku) against the real models; fails below floors or baseline
bun test test/live/audio.test.ts   # Soniox fixtures → STT
bun test test/live/tts.test.ts     # Soniox streaming TTS: first-chunk latency, cancel then reuse
bun scripts/gen-audio-fixtures.ts <id>…   # regenerate fixtures after editing evals/audio/cases.json
```

Eval cases use crew's generic example names and are patterned on real sessions, never
copied from them.

## Develop and test

```bash
bun test src                       # unit specs (no network)
bun test test/ui                   # browser tests (Playwright Chromium)
VOICEOS_LIVE=1 bun test test/live  # real Claude sessions on Haiku — costs a little
bunx tsc --noEmit
```
