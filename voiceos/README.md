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
talk; type in the bar at the bottom otherwise. **Esc** goes up a level: a session → its machine →
Mission Control, where each machine has a card and **+ Add machine** adds another one over SSH.

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
- "Stop listening" / "hands-free on" / "on demand" switch the listening mode (push to talk, on demand
  after "Voice OS", hands-free) in the tab you spoke from.
- The session screen lists running sub-agents with their current step, from the SDK's task
  events.

- `src/remote/` — other machines. A remote runs the same binary as `voiceos remote serve` (a
  daemon crew keeps in tmux, `crew voice remote`), which runs only the session manager behind a
  0600 unix socket; `voiceos remote attach` bridges an SSH login to it (`crew voice _attach` execs
  it). The main keeps the one reducer: refs carry the machine (`vm1:store-front/main`,
  `src/shared/machine-ref.ts`), `mapping.ts` routes effects out and prefixes reports in, and a
  reconnect is a snapshot the main reconciles (`resync.ts`) with one recap line — never an event
  replay; effects not yet acknowledged ride in the next hello and are applied once. The machine
  list is `~/.crew/voiceos/machines.json`, written only by `crew voice machines` (the page and
  voice go through it) and watched while running.

## Voice gate (dry run)

The goal is that only your voice reaches Soniox: the TV, a call, and Voice OS's own speech through
the open mic would be silenced before transcription. This first step only **measures**. Nothing is
silenced, and what Soniox gets is untouched.

- **Automatic, every run.** The first start downloads one pack for the platform (about 90 MB: the
  Silero VAD and SpeechBrain ECAPA models and the onnxruntime library) into
  `~/.crew/voiceos/voice-gate/<pack id>/`. It is checked against the sha256 pinned in
  `src/voice-gate/pack.ts`. There is no pack for Intel Macs, where the gate stays off.
- **Learning.** Voice OS learns your voice from turns that are provably yours: push-to-talk
  presses, and listened turns that became a command. Speech heard while Voice OS was talking is left
  out. After about 30 s, once 80% of the 3 s chunks agree, their mean is your voiceprint.
- **It keeps learning.** Each later turn is measured the same way (3 s chunks, averaged) and folded
  in when it is clearly you: a push-to-talk turn scoring at least 0.4, a listened one at least 0.6,
  and always within 0.5 of the enrollment, so a partner or a video can't pull it away. It counts as
  **trained** once your last 10 turns all reach 0.6 and average 0.8; from then on it learns more
  slowly, never stopping (`adaptation.ts`).
- **Saved.** The voiceprint (192 numbers, never audio) is kept in `~/.crew/voiceos/voiceprint.json`,
  readable by you alone, so a restart resumes. Clicking the chip offers **Forget my voice**, which
  deletes it and starts learning again.
- **Scoring.** From then on, every utterance any tab's mic hears is scored against it with the
  prototype's gate (`src/voice-gate/gate.ts`). Each delivered turn logs one `turn scored` line: its
  source, the tab's sample rate, every raw score, and what the gate would have done at 0.40 (`kept`,
  `silenced` or `unscored`). These lines are the data for picking the real threshold:
  `crew voice logs | grep 'turn scored'`.
- **The chip** beside the route chip shows `voice 12/30 s` until lock-in, then your last turn's score
  as a whole (the last short window when the turn was too short to measure):
  `voice 0.86 · learning` until trained, `voice 0.88` after.
- `VOICEOS_VOICE_GATE=0` turns it off, as an escape hatch: the models run inside Voice OS's own
  process. `VOICEOS_VOICE_GATE_PACK_DIR=<dir>` uses a pack already unpacked there instead of
  downloading one.

### Recording for testing (`VOICEOS_RECORD_VOICE=1`)

Short windows are where the model is weakest, and comparing other voiceprints, decision rules or
models needs your real voice. With `VOICEOS_RECORD_VOICE=1 crew voice restart`, every stretch of speech
the mic hears is kept in `~/.crew/voiceos/voice-recordings/` (0700, files 0600, never uploaded):

- a 16 kHz WAV plus a JSON beside it: the label, the VAD probability of each 32 ms frame, whether
  Voice OS was speaking, the gate's scores and, for turns, the transcript;
- labelled `turn` when a delivered turn overlaps it, `other` when none did within the two minutes a
  turn can take to be delivered — a TV, people nearby, or you talking to someone else;
- capped at 400 turn and 200 other recordings, 300 MB in all, oldest first. **Forget my voice** deletes
  them too.

It records everyone the mic hears: it is off unless the variable is set, and a start with it off but
recordings left says so in the log. A restart asked for by voice keeps the setting; one from a plain
shell without the variable turns it off.

`bun scripts/voice-gate/eval-recordings.ts [dir] [--pack <dir>] [--candidates <dir>]` replays the
recordings through the real gate, once per speaker model: ECAPA from the pack, plus every model in
`~/.crew/voiceos/voice-gate-candidates/`. The earlier half of your turns builds the voiceprint; the later
half and the `other` recordings are judged. Per model and variant (3 s / 1.5 s / 0.8 s voiceprint pieces,
a median of three windows, a window growing to 3 s, deciding at 1.2 s), it prints:

- your first-decision scores against others', and the equal error rate;
- how much of your speech would be silenced;
- the highest-scoring `other` files, to listen to.

Each model scores on its own scale, so each is judged at its own threshold: the point where it turns
you away as often as it lets others in. That point is picked on the same recordings, which makes it
fair for ranking the models but not a threshold to run live. The run ends with one row per model: its
best variant, its error rate, and how long it takes to embed a 0.8 s window and a 3 s piece.

The candidates are CAM++ (3D-Speaker) and WavLM speaker verification. They are local only, never
packed. Export them once, which checks each against its original at three lengths:

```bash
uv run --python 3.12 --with torch==2.14.0 --with torchaudio==2.11.0 --with onnx==1.23.0 \
  --with onnxscript==0.7.2 --with onnxruntime==1.30.0 --with transformers==5.17.0 \
  python scripts/voice-gate/export_candidates.py
```

The packs are built by `scripts/voice-gate/export_models.py` (the ONNX export and the reference
numbers) and `scripts/voice-gate/build-packs.ts`, and hosted on the `voice-gate-pack-1` release.

State lives in `~/.crew/voiceos/` (token, sessions, topics, journal, logs; a remote's own under
`remote/`). `crew voice logs` tails the log.

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
VOICEOS_VOICE_GATE_PACK_DIR=<pack dir> bun test test/live/voice-gate.test.ts  # the gate's real models, free
bunx tsc --noEmit
```
