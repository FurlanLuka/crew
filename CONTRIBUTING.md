# Contributing

Thanks for looking. crew is two programs in one repo:

- **`crew/`**: the Go CLI and TUI. It manages projects, workspaces and worktrees, dev servers on stable
  ports, and env bindings between services.
- **`voiceos/`**: Voice OS, the Bun/TypeScript voice and web cockpit that runs a Claude Code session per
  worktree on top of crew.

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

**Voice OS** (Bun 1.4+):

```bash
cd voiceos
bun install
bun test src evals        # unit tests (no network, no keys)
bunx playwright install chromium   # once, for the browser tests
bun test test/ui          # browser tests
bunx tsc --noEmit && bun run check
bun run install-dev       # build into ~/.crew/bin/voiceos, then: crew voice restart
```

### Evals cost money

`bun evals/run.ts` runs the voice router and narrator against real models with your own Anthropic
key. A full run costs about $1–2. Run only the cases your change touches (`--only=id,id`), and never
add evals or anything else that spends API credit to CI.

## How changes are expected to look

- **Every feature is a command.** The TUIs and Voice OS compose crew commands, and nothing is TUI-only.
  A new command goes in `crew/internal/help/help.go`, and its usage line and output format go in
  `skills/crew/SKILL.md` (a test checks this). Regenerate the command reference with
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
- CI must be green: Go tests, the Voice OS unit and UI tests, and lint.
