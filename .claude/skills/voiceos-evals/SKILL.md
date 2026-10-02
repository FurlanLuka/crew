---
name: voiceos-evals
description: Running Voice OS's prompt evals (kernel, narrator, judge, route, voice-lines) — which suite answers which question, the exact commands, what each costs, and the spending rules. Use before running, adding to or reading any eval in voiceos/evals, or when a routing or narration change needs measuring.
---

# Voice OS evals

The evals run the real prompts against the real models. **Every run bills the developer's Anthropic
key.** Unit specs (`bun test src evals`, typecheck, lint) are free — lean on them first.

## Spending rules (the developer's)

- Say the cost before any paid run, and name the cases. A "yes" covers that one run; ask again before
  the next full one.
- Iterate with `--only=<id,id>` on the cases a change touches. Never start a full run on your own,
  not even at the end of a feature.
- Nothing paid ever runs in GitHub CI: no evals, no live tests, no API keys in workflows.
- When unsure of a cost, measure: run ~30 cases and multiply out from the usage line the route suite
  prints (the API's own token counts), before asking for the full run.

## Suites

All from `voiceos/`, `export PATH=$HOME/.bun/bin:$PATH` first.

| Suite | Answers | Command | Cost (full) |
|---|---|---|---|
| kernel | Does the kernel call the right tools for these words? Floors + baseline, ~320 cases | `bun evals/run.ts kernel [--only=…]` | ~$1–2 |
| narrator | Does the narrator say the right line? (Sonnet) | `bun evals/run.ts narrator [--only=…]` | ~$1 |
| all | kernel + narrator, the pre-review run | `bun evals/run.ts all [--update-baseline]` | ~$2–3 |
| judge | Do the judge's narrow questions read words right, in four languages? | `bun evals/judge.ts [--only=key,key]` | a few cents |
| voice-lines | Does Haiku word Voice OS's follow-ups ("Sent to X. Switch there?") and progress lines within the app's rules (label kept, question only when offered, ≤ 25 words) without inventing facts? ~20 cases × 2 runs, never in `all`, never a gate | `bun evals/run.ts voice-lines [--only=…]` | a few cents |
| route | **Classification only.** On a session's screen, is a line for that session or a Voice OS command — today's kernel vs a narrow classifier | `bun evals/run.ts route [--system=kernel\|classifier\|both] [--only=…]` | 297 repo cases: kernel ~$0.85, classifier ~$0.20; with the ~390 local speech cases ~$2 + ~$0.45 |

- `--update-baseline` only after an intended change, only on a full `all` run.
- `--kernel-model=` / `--narrator-model=` try another model without touching the baseline.
- Results land in `evals/results/<suite>-<ms>.json` (per case: calls, reply, verdict).

## The route suite

Not part of `all` and never a gate: it measures routing, it does not pass or fail. Run it when the
question is "where do these words go" — a routing change, a kernel prompt change that could move
forward-vs-command, or a classifier idea.

- Cases in the repo: `evals/route/cases.json` — `{id, utterance, context (FixtureContext), label:
  session|voiceos, source}`. Sources: `kernel` (kernel cases with a `view`, labelled from their
  expected calls; pending asks left out; a spec keeps them in step with `kernel/cases.json`), `pairs`
  (authored look-alikes, with German and Slovenian).
- The developer's own speech cases (~390, labelled by reading each with its moment: earlier words on
  the screen, what was said aloud, open offers) hold real work, so they **never go in the repo**: they
  live in `~/.crew/voiceos/evals/route-speech.json` (or `VOICEOS_ROUTE_SPEECH`) on the developer's
  machine and are added to a run when present. Names in them are generic anyway. Their heard lines are
  the log's ~80-character previews (the kernel sees 140 live).
- Scores print overall and per source: `kernel` cases are what the kernel prompt was tuned on, so the
  `pairs` and `speech` splits are the honest ones.
- Output per system: accuracy, **leaked** (a command that reached the session), **swallowed** (session
  work Voice OS kept), unclear (classifier), latency, and a usage line with the real cost. Leaks are
  the worse mistake: the developer cares most that Voice OS commands never reach a session.
- `evals/route.ts` `decideFromKernel`: session only when every call that changes something reached
  the screen's session (forward, send_to the view); reads decide nothing, and a turn with no effective
  call (a spoken reply, words ignored) counts as voiceos — Voice OS kept the words.
- No baseline and no gate: `--update-baseline`, `--kernel-model` and `--narrator-model` are refused
  (its cost line prices Haiku). An unknown `--only` id is refused before any call.
- To add speech cases: pull `crew voice logs --cat=router,kernel,voice-out,conversation --machine=main`
  in windows (`--since/--until`, `--lines` caps at 1000), build each line's context, label with
  several agents in parallel, read every line — never keyword rules — and skip what can't be told. New
  speech cases go in the local file, never `cases.json`; look-alikes written by hand go in `cases.json`
  as `pairs`.

## The voice-lines suite

A measurement like route: not part of `all`, no baseline, `--update-baseline` and the model flags are
refused. Cases in `evals/voice-lines/cases.json`: `kind: follow_up` (`facts` as the reducer sends
them, the `fixedText` it would say, the `lastAck` said before it) or `kind: progress` (`step` in its
spoken form, `agents`, `lastProgress`), with optional `includes` (stems, `a|b`), `not_includes`
(whole words that would be invented) and `not_starts`. A run fails a line on the app's own rejection
rules (`findFollowUpProblem` / `findProgressProblem` in `src/voice-lines/prompt.ts`) or the case's
checks; it prints the pass rate, median latency and a usage line with the real cost. `bun test evals`
(free) checks every case is one the app could send — the fixed line itself keeps the rules.

## Adding cases

- Kernel: `evals/kernel/cases.json` — expected `calls` (`ref`, `input`, `text_includes`), `allow`,
  `forbid_calls`, `forbid_mutation`, `answer`, `no_reply`; context from `test/support/state.ts`
  (`createFixtureState`). A `-de` / `-sl` / `-es` suffix is the same case in another language.
- After editing a cases file: `bunx biome format --write <file>` and `bun test evals` (free) before
  any paid run.
