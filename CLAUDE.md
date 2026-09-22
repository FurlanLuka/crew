# crew

CLI + TUI workspace manager for coding agents (Claude Code gets the launch extras and the
plugin; the CLI is agent-agnostic — docs say "agent" unless the thing is literally Claude).
Workspaces hold projects; worktrees are isolated working copies of them, each with stable
dev-server ports and env bindings that point projects at each other. Go, Bubbletea, module `github.com/FurlanLuka/crew/crew`, source under `crew/`.
Agent-first: every action is a command with a non-interactive form and `--json`; the TUIs
compose them. Example names in code, tests and docs are the generic store-front / store-api /
checkout-api / signals / admin / infra-ops set — never a real product.

## Model

- **Project** — a repo in the global pool (`~/.crew/projects.json`): name, path, dev servers,
  **bindings**, an optional **setup** command and an optional **env command** (`EnvCmd`,
  `--env-cmd`): `exec.SetupSteps(dir, setup, envCmd)` = `mise install?` → the install →
  `env: <cmd>`, so the env command is one more setup step with the same streaming, evidence
  and failure rules; the `.env` copy at checkout is the baseline it overwrites. The path is
  a repo the user has, or — `add project <name> <url>` (`exec.IsGitURL`: full URLs only) —
  a clone crew made under `config.ProjectsDir` (`~/.crew/projects/<name>`,
  `project.CrewOwned`); `rm project --purge` trashes only those (`purgeAllowed`: not a
  member anywhere, no check kept). `trash.Put` accepts `WorkspacesDir` or `ProjectsDir`.
- **Workspace** — membership: which projects, with which roles. Pure config, nothing of its
  own on disk. `~/.crew/workspaces/<ws>.json`.
- **Worktree** — one working copy of a workspace's projects, at
  `~/.crew/workspaces/<ws>/<wt>/<project>`, branch `crew/<ws>/<wt>/<project>`. Owns its
  **overrides** and its reserved **ports**. Everything crew keys per running unit — route
  file, log dir, tmux session, prompt, `.code-workspace` — is keyed by the worktree's
  **slug** `<ws>--<wt>` (`dev.Slug`, a distinct type so a bare workspace name cannot reach
  those helpers).
- **Ref** — how the user names a worktree: `<ws>/<wt>`, or bare `<ws>` when it has one.
  `/` is user-facing; `--` appears only where crew does not render (hostnames, filenames,
  tmux). Anything printed for a human goes through `dev.DisplayRef`.
- **Binding** — `{var, value}` on a project. `value` is a template over `{{proj[/server]}}`
  (`http://localhost:<port>`), `{{proj[/server].host}}` (`localhost:<port>`),
  `{{proj[/server].port}}`, `{{worktree}}`, `{{workspace}}`; the server is optional when the
  target has one. `{{url:X}}` / `{{port:X}}` is the pre-2.1 spelling — still parsed, never
  written; `dev.TokenFor` is the one place that spells a token. `dev.ParseTokens` is the one
  grammar (a malformed token is an error there, not a kind nobody expands), used by both
  the validator (`project.ValidateBinding`) and the resolver. Precedence per variable:
  worktree override > binding > left alone. A template that only partly expands is discarded
  whole. Resolved values are injected as `export`s ahead of `PORT=` in the tmux command;
  env files are read (scan, conflict warning), never written.
- **Ports** are always allocated by crew and remembered per worktree (`Worktree.Ports`), so a
  restart lands on the same ones. The configured `--port` is reference only. `--proxy` is
  opt-in; default URLs are `localhost:<port>`.
- **Bundle** — `crew export` writes projects (pool entries + origin remote) and workspace
  *membership* (projects, roles, modes) to one JSON file; never worktrees, ports or
  overrides. `crew import` bare is the wizard (one card per item); `--plan` prints
  `transfer.PlanRows`; `project <name> [--path|--clone[=dir]|--replace|--name|--setup]` and
  `workspace <name>` are `transfer.ApplyProject` / `ApplyWorkspace` — the card's decision as
  flags; `--all [--clone] [--replace]` takes the bundle. A sibling `Suggest` found beats a
  bare `--clone` (an explicit `--clone=<dir>` is honoured); the existence check runs before
  any clone so a refusal leaves nothing behind; `--all` never guesses. A workspace import
  (`ImportWorkspace(m, CheckoutOptions) (ref, started, err)`) is `Create` + `AddProjects`
  — the add-worktree pipeline, runners started on `main`, a pre-flight failure takes the
  empty workspace back; `WorkspaceRow(name, started, health, waited, err)` is the row; `BaseStatusesFor`/`PullBasesFor` give the callers (CLI, wizard card
  with `ctrl+p`) the base table and `--pull`. `transfer` sits above `project` and
  `workspace`; only `main` imports it.
- **Setup runners** (`setup_job.go`) — a worktree is made one project at a time, each by
  its own runner: `StartSetup(ref, []ProjectJob{project, install, smoke})` pre-flights
  (members, no live runner for those projects), reserves every server's port
  (`reservePorts`), clears those projects' recorded issues, writes a stub result per
  project and spawns one runner each through `SpawnRunner` (a var; default
  `spawnTmuxRunner` = a window of `crew-setup-<slug>` created *with its command*, so it
  closes when the runner exits and the session goes with the last one; tests swap in an
  in-process run). The window runs `HOME=<quoted> <exec.CrewBinary> _setup <ref>
  <project> [--no-install] [--no-smoke]` (`runnerCommand`, pure) — HOME explicit because
  the tmux server's env is not the caller's. `crew _setup` (`cmd_setup_runner.go`) is
  `NewRunner` + a SIGHUP/SIGTERM trap → `Runner.Abort` + `Runner.Run`: checkout (skipped
  when present / direct) → install (`exec.RunSetup` streaming to the runner log) → smoke of
  *its own* servers → `recordMerged` its project's issues. A stage that fails ends the run.
  Result file `~/.crew/setup/<slug>/<project>.json` (`RunResult{pid, started_at, done,
  aborted, steps[{name, status, took_ms, detail}], issues}`, atomic writes) after every
  step; runner log `<project>.log`; smoke logs `<project>-<server>.log` (never the dev log
  path). `SetupStatus` derives `ProjectState` (`starting|running|ok|failed|interrupted`)
  from file + pid (`deriveProjectState`, pure; liveness is `kill(pid, 0)`, never the pane)
  and records a vanished runner as interrupted (`markInterrupted`). `Status.ExitCode()`: 2
  while any runner is alive, 1 stopped with a failure, 0. `WaitSetup`/`WatchSetup` poll.
  Smoke per project: `dev.StartProjectServers` (windows `<project>/<server>` of the setup
  session on the reserved ports, env resolved as `dev.Start` does, no routes file) →
  `waitRoutes(session, …)` → `dev.StopWindows` (pane sweep, idle session killed). Each
  server is smoked alone — a sibling's URL resolves but nothing answers; docs say so.
  Pre-2.0 flat refs take `runFlat` (synchronous, no smoke, nothing recorded).
- **Health** — `Worktree.Health {at, issues[{stage, project, server, reason, detail}]}` is
  what the last check found wrong: stages `checkout`, `install` (30-line `StepError` tail),
  `smoke` (`evidenceTail` log lines) with `reason` `died` or `not listening`. Absent =
  verified. `AddWorktree` = `addWorktreeRecord` (validate, record the worktree with its
  overrides) + `StartSetup(all)`; `DuplicateWorktree` records the source's overrides first;
  `Verify(res, opts, only)` = `StartSetup(verifyJobs(...))` (install only where the checkout
  is missing or its install failed, smoke everywhere; `only` filters); `Setup` = installs
  forced. `AddProjects` (the `add workspace <ws> <p>…` path) validates every spec, records
  the members under `Update`, then `StartSetup(new)` per worktree (smoke off where servers
  run) and returns the refs. All return once the runners are spawned; the CLI's `--wait`
  is `watchSetup`. Every read-modify-write of a workspace file goes through `store.Update`
  (flock on `<ws>.json.lock` + atomic rename; `updateWorktree` narrows it) — the runners of
  one worktree record concurrently. `recordMerged` replaces one project's issues, nil when
  nothing remains. Cleared only by a passing runner — never by `dev start`;
  `RemoveProject` drops the removed project's issues (and refuses while a runner is alive).
  `crew fix` = `FixCommandFor(res, health, anomalies)`: the orientation prompt plus
  `RenderFixPrompt`, always passed, from the worktree root when a checkout is missing;
  `--print` (or no tty) writes the prompt to stdout; with servers running, `MergeHealth`
  adds what `CheckServers` finds.
- **Smoke / check** — `SmokeResult{alive, listening, referenced, port, took_ms}` →
  `State()`: `SmokeOK`, `SmokeDied`, `SmokeUnreached` (runs, nothing listens, a binding
  points at it — a failure), `SmokeIdle` (same but nobody points at it — a note).
  `referencedIn` walks the pool's bindings through `dev.ParseTokens`. `waitForServers` is
  the loop, pure over a `look`: every tick each undecided server is looked at; listening or
  idle-alive → done, dead → done (a pane never seen busy only after a 4 s `deadGrace`
  counted from the shell accepting the command — `shellNotReady`: fewer than two
  newlines in the pane log means the pty has echoed the sent keys but the shell has not
  finished its rc files, judged never, however slow the machine),
  referenced-not-listening → `SmokeUnreached` at `SmokeCeiling` (60 s, a var tests
  shorten). `waitRoutes(session, routes, window, logFor, ceiling)` is the I/O around it —
  the dev session (`waitDevRoutes`) and a runner's smoke lay windows and logs out
  differently. `CheckServers` = one look; `WaitServers` = the loop over what runs (`dev
  check --wait`). `exec.TmuxPaneBusy` reads `pane_current_command`, so a server whose
  command is `sh -c …` reads as an idle shell.
  The page: `startedAt` → `Settling` window; `recheckMsg` every 2 s while a row is
  `SmokeUnreached`; those rows render `starting…` and are left out of `CheckHealth` until
  the window closes. `portOpen` dials 127.0.0.1 then [::1].
- **Orientation prompt** — `RenderPrompt` is injected on every launch (`crew claude`, `crew
  edit`, the page, `FixCommand`), single project or not; it ends with `renderCrewSection`
  (the ref, the `crew dev/env/run/fix` lines). `CREW_REF=<ws>/<wt>` is exported in both launch
  paths (`buildClaudeParts`, `exec.ClaudeTask.Ref`).
- **Proxy** — one tmux session `dev.ProxySessionName` (a var: tests use their own name), its
  launch settings in `~/.crew/dev-proxy.json` (`proxyState{domain, port, error}`);
  `EnsureProxy` relaunches on a settings mismatch, a recorded exit error, or no record;
  `crew dev _proxy` records its exit error (`RecordProxyError`). `proxyAnswers` is an HTTP
  GET that must return crew's own status page (`proxyPageMarker`) — a bare dial passes
  against a foreign server on the port; macOS lets two SO_REUSEADDR listeners share one.
  `StartResult.Warnings` carries "not answering" (warn, never block). `crew dev proxy
  status|stop`, `InspectProxy`.
- **Non-interactive everywhere.** `crew fix --print`, `dev setup [--apply --port]` (no
  prompts), `migrate --yes`, `uninstall --yes`, `debug --tail=N`, `dev logs --lines=N`,
  `dev check`, `import --plan|project|workspace|--all`, `setup status [--wait]`, `setup
  logs --lines=N`; every creating command returns at once and takes `--wait`. `human` (`main.go`) is where
  progress and narration go: stdout normally, stderr under `--json` (and under `fix
  --print`) so the document on stdout stays parseable. Empty lists marshal as `[]`, never
  null. `add workspace <ws> <p>[:<role>]…` creates the workspace when missing.
- **Removal never deletes inline.** `cleanupWorktree` is the one teardown primitive: it
  renames the checkout into `~/.crew/trash` (`trash.Put`, which refuses anything outside
  `WorkspacesDir`), prunes git, and a detached `rm -rf` clears the trash — a full build in a
  checkout can be 100+ GB. `main` sweeps leftovers on every start; Settings shows the size and
  can empty it. The TUI walks worktree sizes asynchronously and keeps them for the view's life.
- **Check** — `crew check project <name>` proves a project reproduces from nothing: the
  target `check/<name>` (`CheckWorkspace` is reserved in `Create` only, so `ParseRef`
  passes), checkout at `~/.crew/workspaces/check/<name>/<name>`, slug `check--<name>`,
  record `~/.crew/checks/<name>.json` = `Check{project, at, worktree}` with the `Worktree`
  struct embedded (ports, health, overrides for free). One store seam: `loadFor(ref)` /
  `updateFor(ref, fn)` return the workspace file or, for a check ref, the record shaped as
  a one-project, one-worktree `Workspace` — every ref-keyed path (`Resolve`, the runner,
  `ReadStatus`, `clearIssues`, `updateWorktree`, `Setup`, `Verify`) goes through them, so
  the runner, `setup status|logs`, `fix`, `verify`, the page and overrides work on a check
  unchanged; name-keyed CRUD and lists stay on `Load`/`Update` and never see one
  (`cmdLsWorktrees` appends `ListChecks` rows itself). `StartCheck` replaces a kept check
  from nothing (checkout trashed, scratch branch deleted); `checkVerdict`, run by
  `SetupStatus`, applies a clean verdict: `FinishCheck` (idempotent under the record's
  lock, waits ≤2 s for the runner pid) trashes the checkout, deletes the branch, removes
  the record and **keeps** `setup/check--<name>` so a later poll still sees ✓. A failure
  keeps the target locked with its evidence; `RemoveWorktree("check", name)` →
  `RemoveCheck`. `Addressable(ref)` is what the `crew <ref>` shortcut asks.
- **Housekeeping** — `internal/housekeeping`: `collect` → `plan(state, now, keep)` (pure)
  → `apply`; every path under `ConfigDir` or refused. Kinds `check` (failed, older than
  `KeepChecks` = 7 d, or passed and never looked at), `setup`/`logs`/`routes` of slugs with
  no worktree and no check (live slugs come from the records plus any slug whose dev or
  setup tmux session is alive — never parsed back from the name), `lock` (no record behind
  it, older than an hour — creation holds the lock before the file exists), `trash`,
  `prune` (`crew clean` only). `SweepOnStart(args)` in `main` runs it at most hourly
  (stamp `~/.crew/housekeeping.json`), never for `_setup`, `dev _proxy`, `clean`,
  `update` — those, and a start within the hour, get `trash.Sweep` alone; `uninstall`
  gets nothing. `crew clean
  [--dry-run]` prints `RenderReport` rows.
- A workspace with no `worktrees` predates 2.0. It keeps flat paths and a bare slug until
  `crew migrate` runs; `crew add worktree` is the one thing that refuses it.

## Structure

```
crew/
  main.go              dispatch, mustResolve, the add|rm|ls noun trio
  cmd_dev.go           crew dev …          cmd_worktree.go   worktree/binding/override/setup cmds
  cmd_run.go           crew env, crew run  cmd_migrate.go    crew migrate
  cmd_procs.go         crew ps, crew kill  cmd_uninstall.go  crew uninstall
  cmd_transfer.go      crew export, crew import (parseImportArgs: --plan | project | workspace | --all)
  cmd_launch.go        crew launch, claude, edit          cmd_trash.go  crew trash
  cmd_housekeeping.go  crew clean
  cmd_setup_runner.go  crew _setup — the hidden per-project runner (exempt from help/SKILL)
  internal/
    app/        Bubbletea shell, styles, MoveCursor/RowPrefix/RowName
    config/     ~/.crew paths, settings.json
    debug/      debug.log + its TUI view
    dev/        ports, routes, proxy, binding resolution, conflicts, scan proposals, formatters
    dirsize/    bytes under a directory (pure)
    exec/       git, tmux, editor, ShellQuote, setup steps (mise + lockfile detection)
    help/       structured command tree (help_test pins every command)
    housekeeping/ the sweep: collect → plan (pure) → apply; SweepOnStart, crew clean
    procs/      process inventory and reclaim
    project/    pool CRUD, bindings, setup; project TUI incl. the binding editor
    settings/   settings TUI, trash size + empty, uninstall entry
    transfer/   export/import bundle: Collect, Covered, Inspect, Clone, Import*; cli.go (PlanRows,
                ApplyProject, ApplyWorkspace); picker + wizard TUIs
    trash/      removed checkouts: rename into ~/.crew/trash, detached rm, sweep on start
    uninstall/  crew uninstall
    workspace/  Ref/Resolved, worktree CRUD, migration, base branches, smoke start, TUI;
                check.go (the check target), setup_job.go (the runner), store.go (loadFor/updateFor)
```

Import boundaries that shape the packages: `dev` cannot import `workspace` (it declares its own
inputs — `DevProject`, `ResolveParams` — and `workspace.Resolved` builds them). `project` cannot
import `workspace`; the binding editor's live preview and checkout list are functions `main`
wires in (`project.Previewer`, `project.CheckoutDirs`).

### Resolved

`workspace.Resolve(ref)` does the I/O once — one workspace read, one pool read — and returns
every project with its path decided and its pool config attached. Commands go
`mustResolve(arg)` → `*Resolved` → work. Don't call `project.Get` inside loops; that is what
`Resolved` replaced. `res.DevProjects()`, `res.ResolveEnv()`, `res.ResolveParams(ports)`.

### TUI

`crew workspace` → workspaces → enter → that workspace's worktrees (+ new) → enter → the
**worktree page** (`view_worktree.go`): servers with live status and URLs, the same anomaly
block `crew dev start` prints, launch and open rows, one cursor. `crew project` → `s` servers,
`b` bindings (scan-first editor with live preview), `t` setup command, `e` env command.

### New worktree

`AddWorktree`: base-branch table with behind-origin counts (fetches in parallel; `ctrl+p` /
`--pull` fast-forwards local bases without touching a checked-out feature branch — in the
foreground, before the runners) → the worktree recorded, ports reserved → one runner per
project in the background. Each: git worktree (`git -c core.hooksPath=/dev/null worktree
add`, the error is git's last stderr line, `mise trust` when there is a `mise.toml`) →
`.env` copied from the canonical repo or a sibling worktree → install (`mise trust && mise
install`, then lockfile-detected package manager or the project's `Setup`; a failure ends
that runner, `crew setup <ref> <project>` re-runs) → smoke of its own servers: which panes
still run and which listen on their port, last log lines for the failed ones, stop. The
page (`Setup *Status`, `installing()`) shows the table every 2 s and gates start/launch
until the runners are done; `l` opens the runner logs (`NewSetupLogsView`).

## Conventions

- **Every feature is a command.** The TUIs compose commands; nothing is TUI-only, and
  nothing needs a tty except the TUIs, `claude` and `open` (their no-tty error names the
  data alternative). A new command goes in `help.go` (TUI entries carry a `Notes` line
  naming the CLI equivalent), and `help_test` requires its usage line and output format
  verbatim in `skills/crew/SKILL.md` — the skill is what an agent reads. README's command
  tables and the plugin files (`agents/crew.md`, `skills/*/SKILL.md`) follow by hand.
- **Tab-separated output** for CLI list commands; `--json` everywhere via the global flag
  stripper (`extractFlag` stops at `--` so `crew run … -- child --json` keeps the child's flag).
- **Bubbletea** for every interactive view; arrows/enter/esc; letters as accelerators.
- **Show status after every action.**
- **Warn, never block, at dev-server start.** Crew asserts only facts it owns — ports it
  allocated, projects it placed, URLs it handed out (hence `SmokeUnreached` vs `SmokeIdle`).
  The one carve-out: the worktree **page** locks its start and launch rows while a failure
  is *recorded* (`f fix`, `v verify`, logs and shell stay live); a live check never locks,
  it marks rows and offers `f`. The CLI prints the issues and proceeds. The second
  carve-out, CLI included: while a setup runner is alive on a worktree, `dev start`,
  `verify`, `setup`, `duplicate` and `rm workspace <p>` refuse (`ErrSetupRunning`) — crew
  owns the fact that it started an install, and a server on top of it is corruption, not a
  warning. `status` and `logs` (and the noun words) are reserved workspace names
  (`ValidateName`). A value pointing at a sibling in the same worktree is normal;
  one pointing into another worktree, or at a sibling's configured port while it runs
  elsewhere, is a conflict.
- **Debug logging** — every external command (tmux, git, editor, package managers, mise)
  goes through `debug.Log(category, …)`: `"tmux"`, `"git"`, `"editor"`, `"dev"`, `"setup"`,
  `"procs"`, `"trash"`, `"uninstall"`. Log the command before running it; log errors inline.
- **Never log binding values** — names, sources and targets only. Values carry URLs and can
  carry credentials.
- **Comments say why, not what.** A comment earns its place with a constraint, a product
  reason, or a non-obvious decision — never a restatement of the next line.

## Tests

`*_test.go` beside the source. `setupTestConfig(t)` points `config.ConfigDir` at a
`t.TempDir()`; nothing touches `~/.crew`. tmux tests use a per-process proxy session name
(`dev.ProxySessionName` set in `setupTestConfig` / `isolateProxy`) so `go test ./...` never
kills a live proxy and packages do not race on the shared tmux server; the proxy pane runs
`/usr/bin/true` via `exec.CrewBinary` (the test binary would re-run the package). Setup
runners: `setupTestConfig` installs `inlineRunners` (each job runs in-process, in order,
before `StartSetup` returns — the old synchronous semantics); `backgroundRunners(t)` runs
them as goroutines for the early-visibility and refusal tests; `realRunners(t)` restores
the tmux spawn with `runnerArgv` pointed at the test binary's helper process (`TestMain`
with `CREW_TEST_CONFIG_DIR`) for the one real-spawn test and the killed-window test.
`recorded(t, ref)` / `stepsOf(t, ref)` read the verdict off disk. Real git via `initRepo` (`workspace_test.go`) and
`remoteAndClone` (`base_test.go`) — worktree creation, migration moves, branch renames and
fetch counts run against actual repositories. Exact full-string comparison is the snapshot
convention (`FormatResolutions`, `RenderPrompt`, `renderWorktreePage`, `ServerCommand`).
tmux-dependent tests `t.Skip` without tmux and tolerate a live user proxy.

```bash
cd crew && go build -o /tmp/crew . && go test ./...
```

Live checks go against a fake HOME (`HOME=/tmp/x crew …`), never the real `~/.crew`, unless
the point is to verify real state.

## Release

GoReleaser on tag push. Always a new tag, never delete and re-tag. `install.sh` is the
distribution method; `crew update` pulls the latest release. Replacing `~/.local/bin/crew`
in place gets SIGKILLed on macOS (signature) — `rm` then `cp`, then `codesign --sign -`.

## Claude Code plugin

`.claude-plugin/` at the repo root ships the `crew` skill, the agent and four guided skills
(`skills/{setup,import,status,proxy}` — auto-invoked from their descriptions, or
`/crew:<name>`) for Claude Code: `/plugin marketplace add FurlanLuka/crew`,
then `/plugin install crew@crew`. Keep `skills/crew/SKILL.md` in step with the CLI — it is
what an agent reads to drive crew; bump `plugin.json` when the plugin's surface changes.
