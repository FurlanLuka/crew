# Contributing

Thanks for looking. crew is two programs in one repo:

- **`crew/`**: the Go CLI (and the one TUI left, for launching Claude). It manages projects,
  workspaces and worktrees, dev servers on stable ports, and env bindings between services.
- **`voiceos/`**: crew's web server, Bun/TypeScript: the page (Home, Set up, and Voice OS, the voice
  cockpit that runs a Claude Code session per worktree) on top of crew.

Bug reports, fixes and ideas are all welcome. For anything bigger than a small fix, open an issue
first so we can agree on the shape before you spend time on it.

## Building and testing

**crew** (Go 1.25+, git, tmux):

```bash
cd crew
go build -o /tmp/crew . && go test ./...
```

Tests never touch your real `~/.crew`. Live checks go against a throwaway home:
`HOME=/tmp/x /tmp/crew …`.

**Voice OS** (Bun 1.4+; CI uses 1.4.2):

```bash
cd voiceos
bun install
bun test src evals                 # unit tests and the offline eval checks (no network, no keys)
bunx playwright install chromium   # once, for the browser tests
bun test test/ui                   # browser tests
bun run check                      # lint: Biome and ESLint (bun run format fixes what it can)
bunx tsc --noEmit && bun run typecheck
```

Name the folders: a bare `bun test` also picks up `test/live`, whose tests skip unless `VOICEOS_LIVE=1` (below).

### Running Voice OS from source

Try a change against a throwaway home so it never touches your real `~/.crew`, your keys or the
Voice OS you use every day. Give it its own tmux server too: crew finds Voice OS by its tmux
session name, and on your usual tmux server a `crew server stop` would stop your real one.

```bash
(cd crew && go build -o /tmp/crew .)  # before switching HOME: Go keeps its caches there
export HOME=/tmp/voice-dev TMUX_TMPDIR=/tmp/voice-dev/tmux && unset TMUX
mkdir -p "$TMUX_TMPDIR"
(cd voiceos && bun run install-dev)   # compiles into $HOME/.crew/bin/voiceos
claude auth login                     # Claude Code is signed out under a new HOME
/tmp/crew server start                # asks for the two API keys, starts it, prints the links
```

Use the localhost link: while your real crew proxy holds port 80, the throwaway one can't start.
After a change, run `bun run install-dev` again, then `/tmp/crew server restart`; `/tmp/crew server
logs` shows the log. To keep each utterance's audio under `$HOME/.crew/voiceos/debug/` while you
chase a speech problem, export `VOICEOS_DEBUG_AUDIO=1` before the first `/tmp/crew server start` (Voice OS
takes its environment from the tmux server, which that first start launches).

### What costs money

Nothing in CI spends API credit, and it stays that way: never add evals, live tests or anything
else that needs a key to a workflow.

- **Evals** (`bun evals/run.ts [kernel|narrator|all]`) run the voice router and narrator against
  the real models on your own Anthropic key. The suite has 294 cases: 245 for the kernel (Haiku,
  one call each) and 49 for the narrator (Sonnet, three runs each, each judged by Sonnet). A full
  run has cost around $1–2. While you iterate, run only the cases your change touches:
  `bun evals/run.ts kernel --only=<id>,<id>` costs a few cents. Run the full suite once before
  review, and `--update-baseline` only when the scores moved on purpose.
- **Soniox live tests** (`VOICEOS_LIVE=1 bun test test/live/audio.test.ts`, `…/tts.test.ts`)
  need `VOICEOS_LIVE=1` and a Soniox key (`~/.config/crew-voiceos/soniox.key` or
  `SONIOX_API_KEY`), and bill by audio time. `VOICEOS_AUDIO=0` skips the audio one.
- **Live Claude sessions** (`VOICEOS_LIVE=1 bun test test/live/session.test.ts`) run real Claude
  Code sessions on Haiku.

## How changes are expected to look

- **Every feature is a command.** The page (Set up and Voice OS) and the launch TUI compose crew
  commands, and nothing is page-only. A new command goes in `crew/internal/help/help.go`, and its
  usage line and output format go in `skills/crew/SKILL.md` (a test checks this). Regenerate the command reference with
  `UPDATE_DOCS=1 go test ./internal/help -run TestCommandsDocIsCurrent` (from `crew/`).
- **Tests beside the source**, real git and tmux where it matters, and exact full-string comparison
  for rendered output.
- **Example names** in code, tests and docs are the generic `store-front` / `store-api` /
  `checkout-api` / `signals` set, never a real product.
- **Comments say why, not what.**
- **No secrets in logs.** Binding values and API keys are never logged.

`CLAUDE.md` is the detailed map of the codebase, and it's worth a read before a bigger change.

## Pull requests

By opening a pull request you agree that your contribution is licensed under this repository's
[license](LICENSE) (FSL-1.1-MIT).

- One feature or fix per PR, with its tests.
- Say what you verified and how (commands run, what you saw).
- CI must be green. Every PR runs `go build`, `go vet` and `go test ./...`; a PR that touches
  Voice OS also runs its lint (`bun run check`), `tsc --noEmit`, the unit tests and the browser
  tests. A release tag runs the Go and Voice OS unit tests again before anything is published.
