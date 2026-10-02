# crew

CLI workspace manager for coding agents, with a web page for setting it up and talking to its
sessions (Claude Code gets the launch extras and the plugin; the CLI is agent-agnostic — docs
say "agent" unless the thing is literally Claude).
Workspaces hold projects; worktrees are isolated working copies of them, each with stable
dev-server ports and env bindings that point projects at each other. Go, Bubbletea, module `github.com/FurlanLuka/crew/crew`, source under `crew/`.
Agent-first: every action is a command with a non-interactive form and `--json`; crew's page
(Set up, served by `voiceos/`) composes them, and the one TUI left launches Claude. Example names in code, tests and docs are the generic store-front / store-api /
checkout-api / signals / admin / infra-ops set — never a real product.

## Model

- **Project** — a repo in the global pool (`~/.crew/projects.json`): name, path, dev servers,
  **bindings**, an optional **setup** command and an optional **env command** (`EnvCmd`,
  `--env-cmd`): `exec.SetupSteps(dir, setup, envCmd)` = `mise install?` → the install →
  `env: <cmd>`, so the env command is one more setup step with the same streaming, evidence
  and failure rules; the `.env` copy at checkout is the baseline it overwrites. **The git
  remote is the identity, the path is where crew keeps the clone.** `add project <name>
  <url>` (`exec.IsGitURL`: full URLs only) clones under `config.ProjectsDir`
  (`~/.crew/projects/<name>`, `project.CrewOwned`); `--path=<dir>` adopts a checkout the
  user already has (a bare path is refused — `addProjectTarget`). The remote is never
  stored: `project.RemoteOf(p)` = `exec.OriginURL(p.Path)`, read when asked (`ls projects`
  third column, export, import matching), so it cannot drift from the clone; equality is by
  `exec.RepoKey` (transport, `user@`, `.git`, trailing `/` stripped, scp form folded, host
  lower-cased). `project.CloneAllowed(name)` is the one clone-dir rule for add and import.
  `rm project` is `workspace.RemoveFromPool(name, TrashClone|KeepClone)` (`pool.go`):
  `PoolRemovalAllowed` (not a member anywhere, no check kept — always, `--keep-clone`
  included) → `project.Remove` → a crew-owned clone to the trash unless kept, an adopted
  path never moved; `PoolRemovalLine` is the one wording, printed by the CLI (the page shows it).
  `--purge` still parses (a note, then the default). `trash.Put` accepts `WorkspacesDir`
  or `ProjectsDir`.
- **Workspace** — membership: which projects, each `worktree` (default) or `direct`
  (`WorkspaceProject{Name, Mode}`, `ModeLabel`; a `role` key in a pre-4.0 file is ignored
  and dropped on the next save). Pure config, nothing of its own on disk.
  `~/.crew/workspaces/<ws>.json`. `CreateWith(name, specs, opts)` = `Create` +
  `AddProjects` with the empty workspace taken back on a pre-flight failure — the CLI
  and an import both create through it. `directRefusal` (pure) is the one reading of why
  a project cannot join `ws` directly (held elsewhere, >1 worktree, not a repo);
  `validateSpecs` reads it.
- **Worktree** — one working copy of a workspace's projects, at
  `~/.crew/workspaces/<ws>/<wt>/<project>`, branch `crew/<ws>/<wt>/<project>`. Owns its
  **overrides** and its reserved **ports**. Everything crew keys per running unit — route
  file, log dir, tmux session, prompt, `.code-workspace` — is keyed by the worktree's
  **slug** `<ws>--<wt>` (`dev.Slug`, a distinct type so a bare workspace name cannot reach
  those helpers). `RenameWorktree` (`rename.go`) is the one way a name changes: under the
  workspace file's lock, `renameAllowed` (shape, records, no branch collision, nothing of
  crew's alive, the resume rule) → `moveCheckouts` (the migration's move generalized to
  any from/to ref: git worktree move, the crew branch renamed in place or in the repo,
  venv relocation, mise trust) → `moveSlugArtifacts` (setup and dev logs move, never
  merge; routes/prompt/.code-workspace dropped for both slugs) → the record last.
- **Ref** — how the user names a worktree: `<ws>/<wt>`, or bare `<ws>` when it has one.
  `/` is user-facing; `--` appears only where crew does not render (hostnames, filenames,
  tmux). Anything printed for a human goes through `dev.DisplayRef`.
- **Binding** — `{var, value, server?}` on a project. `value` is a template over `{{proj[/server]}}`
  (`http://localhost:<port>`), `{{proj[/server].host}}` (`localhost:<port>`),
  `{{proj[/server].port}}`, `{{worktree}}`, `{{workspace}}`; the server is optional when the
  target has one. `{{url:X}}` / `{{port:X}}` is the pre-2.1 spelling — still parsed, never
  written; `dev.TokenFor` is the one place that spells a token. `dev.ParseTokens` is the one
  grammar (a malformed token is an error there, not a kind nobody expands), used by both
  the validator (`project.ValidateBinding`) and the resolver. `server` is the **scope**:
  empty = project-wide (every server of the project; old files read unchanged), set = that
  server alone (`crew add binding <p>/<server> …`; `ValidateBinding` checks it through
  `project.FindServer`). Identity is `dev.BindingKey{var, server}` (`Binding.Key()`,
  `Resolution.Key()`): a scoped and a project-wide binding coexist on a var, `AddBinding`
  replaces by key (`upsertBinding`), `RemoveBinding(proj, key)` (`dropBinding` names the
  scoped siblings when the bare form misses). `ResolveBindings` stays one row per binding
  (`Resolution.Server`; a scope naming a server the project no longer has resolves as
  unresolved "no dev server"); `dev.EnvFor(rows, ProjectServer)` is the pure effective set
  for one window — a scoped row replaces the project-wide row of the same var in place,
  unresolved included (no fallback); `Server == ""` is the project-wide set. Both start
  sites inject `EnvFor` per window; `crew env|run <ref> <p>[/<server>]` go through
  `resolveTarget` (`cmd_run.go`) — bare `<p>` stdout is the project-wide set, the stderr
  table labels rows `VAR (server)` (`Resolution.Label()`, the one label rule) and names
  the per-server form. Conflicts count a var as injected only when every server gets it
  (`injectedEverywhere`). `crew dev rm <p> <s>` drops the server's scoped bindings; `dev add --rename`
  (`project.RenameDevServer`) keeps the server's place, re-scopes them and rewrites every
  pool binding whose tokens name it (`retarget`, through `ParseTokens`/`TokenFor`). Precedence
  per variable: worktree override > scoped binding (its server) > project-wide binding >
  left alone; overrides stay per var (`VAR`, `proj.VAR` — no scoped keys). A template that
  only partly expands is discarded whole. Resolved values are injected as `export`s ahead
  of `PORT=` in the tmux command; env files are read (scan — under the server's `Dir` for a
  scoped scan; conflict warning), never written.
- **Ports** are always allocated by crew and remembered per worktree (`Worktree.Ports`), so a
  restart lands on the same ones. The configured `--port` is reference only; a server with
  none (`DevServer.Port == 0`, `Listens()`, `PortLabel()`) is a process that does not
  listen: `AllocatePorts` gives it 0, `ServerCommand` sets no `PORT`, the route has no URL
  and is never proxied (`Route.Listens`), `IndexPorts` leaves it out so a token aimed at it
  is unresolved (`has no port`, `TemplateContext.Portless`), and the smoke's `reached`
  takes alive as the verdict. `--proxy` is
  opt-in; default URLs are `localhost:<port>`.
- **Bundle** (`Version` 2) — `crew export` writes projects by remote (`Exported{Project
  with Path blanked, Remote}` — no path; `WithoutRemote` names the config-only ones, said
  through `human` and as `no_remote` in `--json`) and workspace *membership* (projects
  and modes) to one JSON file; never worktrees, ports or overrides. A v1 bundle still
  reads (its path is only a hint in a `missing` row); a v1 crew refuses a v2 bundle.
  `crew import --plan` (and bare `import`) prints `transfer.PlanRows` — `exists` (same
  remote by `RepoKey`, or nothing to compare) · `other remote` · `clone` (into `ClonePath(name)`) · `blocked` (that dir is taken) ·
  `missing` (no remote) · `ready`/`needs`. `Inspect` reads the pool once
  (`ProjectStatus{Exists, Local, LocalRemote, CloneDirTaken}`). **One decision for every
  import:** `decide(p, remote, st, opts)` (pure, `decide.go`) → `Keep | Record |
  Clone | Adopt` — exists without `--replace` keeps; a given `--path` adopts; same remote
  records on the local path (config sync, no clone); no remote refuses; else clone under
  the imported name — and `applyDecision` runs it: name validated first, `CloneAllowed`,
  an other-remote replace refused while `WorkspacesWith` is non-empty, then clone, then
  record. `ApplyProject(b, plan, name, ProjectOptions{Path, Replace, Name, Setup, EnvCmd})`
  goes through them (Set up's import page passes the same flags); `classify(st, remote)
  situation` (`decide.go`) is the one reading behind the plan row and `decide`'s
  config-sync rule (a config-only export — no remote in the bundle —
  of a project here records like a same-remote one). `Inspect` also records each local
  project's workspaces (`membership()`, the workspace files read once); `--all` refuses up
  front on `Refusals(b, plan, o)` — blocked or missing rows, and under `--replace` an
  `other remote` row for a project in a workspace — and clones nothing until the list is
  clean; `AllRows` is its loop, a failed row exits 1. A workspace import
  (`ImportWorkspace(m, CheckoutOptions) (ref, started, err)`) is `workspace.CreateWith`
  — the add-worktree pipeline, runners started on `main`, a pre-flight failure takes the
  empty workspace back; `WorkspaceRow(name, started, health, waited, err)` is the row;
  `BaseStatuses`/`UpdateBases` give the callers the base table and `--pull` (`crew ls
  bases <ws> [--json]` is the table alone, `FormatBaseStatuses` its text). `crew export -` /
  `crew import -` are the bundle on stdout / stdin (`transfer.Encode`/`Decode`), bare
  `import` is `--plan`, and `RenameWarning` names the bindings an `--name` import leaves
  behind. `transfer` sits above `project` and `workspace`; only `main` imports it.
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
  finished its rc files; nothing it runs meanwhile counts as the server, and both the
  grace and the `SmokeCeiling` run from that moment, with a shell still quiet at twice
  the ceiling given up on),
  referenced-not-listening → `SmokeUnreached` at `SmokeCeiling` (60 s, a var tests
  shorten). `waitRoutes(session, routes, window, logFor, ceiling)` is the I/O around it —
  the dev session (`waitDevRoutes`) and a runner's smoke lay windows and logs out
  differently. `CheckServers` = one look; `WaitServers` = the loop over what runs (`dev
  check --wait`). `exec.TmuxPaneBusy` reads `pane_current_command`, so a server whose
  command is `sh -c …` reads as an idle shell.
  `portOpen` dials 127.0.0.1 then [::1].
- **Orientation prompt** — `RenderPrompt` is injected on every launch (`crew claude`, `crew
  edit`, the page, `FixCommandFor`), single project or not; it ends with `renderCrewSection`
  (the ref, the `crew dev/env/run/fix` lines). `CREW_REF=<ws>/<wt>` is exported in both launch
  paths (`buildClaudeParts`, `exec.ClaudeTask.Ref`).
- **Proxy** — one tmux session `dev.ProxySessionName` (a var: tests use their own name), its
  launch settings in `~/.crew/dev-proxy.json` (`proxyState{domain, port, error}`);
  `EnsureProxy` relaunches on a settings mismatch, a recorded exit error, or no record, and
  says whether it launched: only a launched proxy gets `ProxyTLSWarning`'s `tlsStartWait`
  (8 s) to bind HTTPS — `crew server` runs that wait beside its health loop, never ahead of it;
  `crew dev _proxy` records its exit error (`RecordProxyError`). `proxyAnswers` is an HTTP
  GET that must return crew's own status page (`proxyPageMarker`) — a bare dial passes
  against a foreign server on the port; macOS lets two SO_REUSEADDR listeners share one.
  `StartResult.Warnings` carries "not answering" (warn, never block). `crew dev proxy
  status|stop`, `InspectProxy`.
- **Non-interactive everywhere.** `crew fix --print`, `dev setup [--apply --port]` (no
  prompts), `migrate --yes`, `uninstall --yes`, `debug --tail=N`, `dev logs --lines=N`,
  `dev check`, `import --plan|project|workspace|--all` (`-` = stdin), `setup status [--wait]`, `setup
  logs --lines=N`, `add project --scan`, `add binding … --dry-run`, `ls bindings --preview`,
  `ls bases`, `rm worktree|workspace … --dry-run`, `check project --status`, `update --check`,
  `export -` (stdout); every creating command returns at once and takes `--wait`. `human` (`main.go`) is where
  progress and narration go: stdout normally, stderr under `--json` (and under `fix
  --print`) so the document on stdout stays parseable. Empty lists marshal as `[]`, never
  null. `add workspace <ws> <p>…` creates the workspace when missing (`CreateWith`).
- **Removal never deletes inline.** `cleanupWorktree` is the one teardown primitive: it
  renames the checkout into `~/.crew/trash` (`trash.Put`, which refuses anything outside
  `WorkspacesDir`), prunes git, deletes the `crew/<ws>/<wt>/<project>` branch (crew's
  namespace; commits not on the base are counted into the debug log and stay in the reflog),
  and a detached `rm -rf` clears the trash — a full build in a checkout can be 100+ GB. `main` sweeps leftovers on every start; Settings shows the size and
  can empty it.
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
  setup tmux session is alive — `liveSessions`, which for the voice slug adds the server's
  `voice.SessionName`/legacy name — never parsed back from the name), `lock` (no record behind
  it, older than an hour — creation holds the lock before the file exists), `trash`,
  `prune` (`crew clean` only). `SweepOnStart(args)` in `main` runs it at most hourly
  (stamp `~/.crew/housekeeping.json`), never for `_setup`, `dev _proxy`, `clean`,
  `update` — those, and a start within the hour, get `trash.Sweep` alone; `uninstall`
  gets nothing. `crew clean
  [--dry-run]` prints `RenderReport` rows.
- **crew's server** — bare `crew` (`cmdBare`, `cmd_server.go`) starts it when it does not answer
  and opens its page: tmux only (`bareRequirements` — a missing `claude` is the page's to say),
  never a key prompt, `shouldOpenBrowser(openEnv)` (pure: tty, not `--json`, not SSH, a display
  on Linux) decides the browser for bare / `start` / `restart`, `serverLinkLines` prints the
  link (over SSH: the proxy's when `domain`/`server_ip` is set, else the `ssh -L` line), and a
  machine running `remote serve` gets `remoteMachineLine`, exit 0. `crew server …`
  (`cmdServer` → `serverDispatch`, bare = status) is the lifecycle and everything below;
  `crew voice …` (`cmdVoiceAlias`, bare = start) is the alias forever — Voice OS and older
  machines call it (`voice _attach`, `voice _restart`, `voice logs --local`, the query
  socket) — with one stderr note only at a tty (`showAliasNote`). tmux sessions
  `crew-server` / `crew-server-remote` (`voice.SessionName`, `RemoteSessionName`), outside
  `crew-dev-*` so `crew dev stop` / `crew kill` never stop the page that asked;
  `LegacySessionName` (`crew-dev-os[-remote]`) is still read by `Inspect`/`Stop`/
  `EnsureRemote`, and `dev.IsServerSession` keeps all of them out of `sessionsToStop` and
  marks them `Kept` in `procs`; uninstall stops them by name. `voice.PageURL()` is the page
  without its sign-in token — what a terminal line may print.
- **Voice OS** — `voiceos/` (Bun/TypeScript, its own README and tests) is crew's server: Home,
  Set up (every config form, each running one crew command, plus a Setup with Claude chat per
  machine) and Voice OS, the voice and web cockpit — one Claude Code session per worktree, a
  Haiku kernel routing speech, Soniox for speech in and out. Set up's `--json` reads are
  pinned by Go-written goldens in `voiceos/testdata/` (`cmd_golden_test.go`, `-update-golden`;
  `crew-lines.json` is crew's own mutation and refusal lines), and every argv it builds
  (`voiceos/test/fixtures/shared/setup-argv.json`) must walk `help.Root`
  (`TestSetupArgvWalkTheTree`). `crew server` owns its lifecycle like the proxy's
  (`internal/voice`); the binary is
  `~/.crew/bin/voiceos`, downloaded on the first start from the release of the same
  version (`internal/release.InstallBinary`, shared with `crew update`: staged beside, ad-hoc
  signed on macOS, then renamed over — never rewritten in place) with a `.version` stamp beside
  it; `crew update` refreshes it when the stamp differs and never restarts it.
  `voiceos/scripts/build-release.ts` builds the per-platform archives GoReleaser attaches
  (`release.extra_files`); `bun run install-dev` builds from source into the same path and drops
  the stamp. **Dev push** (`cmd_server_dev.go`, `internal/voice/devpush*.go`): `crew server dev push`
  from a checkout on any machine builds crew + Voice OS per target (`DevPushTargets`: the main plus
  `ssh uname -sm` per remote; a remote asks the main through its query socket, `voice dev _targets`)
  as `dev-<sha>[-dirty-<hash>]`, then hands off to the main (`voice dev _handoff <version>` — no path; the main's link appends
  `--source=<id>`, never the remote; the main fetches `.crew/dev-push/<version>` from it) where `RunDevPush` runs detached in tmux `crew-voice-push`: gather a
  remote source's build over scp → stage + sha256 on every machine (a failure installs nothing) →
  `InstallScript` (chmod 755, codesign on macOS, and the new crew's `--version` must be this push's before the rename, else nothing is replaced; scp runs with `-p`) + restart in `RestartOrder` (other remotes, the main, the source last). Status in
  `~/.crew/voiceos/dev-push.json`. `release.IsDevBuild` (`dev`, `dev-*`) is the one dev rule; a
  `dev-<sha>` stamp is exact in `DecideDaemon`. `crew server start` checks tmux and `claude` first (`UnmetRequirements`) and hands the
  `claude` it found to Voice OS (`VOICEOS_CLAUDE_BIN`): the tmux server's PATH is not the
  caller's. **Remote machines:** the same binary is a remote with `voiceos remote serve` (a
  daemon in tmux `crew-server-remote`, its own `~/.crew/voiceos/remote/`, a 0600 unix socket) that
  runs only the session manager; `crew server remote` starts it, `crew voice _attach` (hidden, stdout
  is the link) is what a main runs over `ssh <host>`. The main keeps the one reducer: refs carry the
  machine (`vm1:store-front/main`, `shared/machine-ref.ts`), `remote/mapping.ts` routes hands
  effects and prefixes reports, and a reconnect is a snapshot the main reconciles (`remote/resync.ts`),
  never an event replay; unacked effects ride in the next hello. A remote behind the main's release is
  updated by the main (`crew update` over SSH, once per version; never a downgrade). `~/.crew/voiceos/machines.json` is
  the machine list (`crew server machines`, the page, voice), watched by the running Voice OS.
  **Discord** (optional): `crew server discord setup` (`cmd_server_discord.go`,
  `internal/voice/discord.go`) takes only the bot token (stdin), checks it against Discord REST
  v10, saves it as `discord.key` beside the other keys (not in `KeyNames`, so the first `crew
  server start` never asks) and writes `~/.crew/voiceos/discord.json` (guild, channel, owner) atomically,
  which the running Voice OS watches; Voice OS reports back in `discord-status.json`.
  **Queries** (`cmd_server_query.go`, `internal/voice/query*.go`, `remote_query.go`): `crew server
  logs|debug-notes [show <n>]|notes` are read-only, `parseQueryArgs` pure (unknown flags fail,
  times made absolute UTC where typed, `--lines` 1–1000), the path by `DecideRole` (`--local` →
  cockpit = main → daemon = remote → machines.json = main → alone). The main reads its own
  rotated log (`RotatedFiles`: base, `.1`…`.5`, all opened before any is read; `ts` prefix compared
  before decoding) and asks each remote `voice logs --local --json …` over SSH in parallel
  (`RemoteCrewCommand` quotes twice, same crew fallback as `remote/ssh.ts`; 20 s each;
  `classifyRemote` answered / older crew / unreachable), merged by time (`GatherLogs`). A remote
  asks the main through `~/.crew/voiceos/remote/query.sock` (`AskMain`: one line each way, 35 s),
  relays its stdout, stderr and code verbatim; with no main, logs fall back to its own files and
  notes fail. `main` is a reserved machine id. The notes key rule (`ToNotesKey`) and the socket
  lines are pinned by `voiceos/test/fixtures/shared/`.
  **Conversations:** words go to the session on screen, or to a session named in them — never
  guessed (a `send_to` whose session is not named in the words is forwarded to the screen in code,
  and the judge's `spoken_to` tells speaking to a named one from mentioning it:
  `tools/send-guard.ts`). State keeps a five-view `viewHistory` for "go
  back", a `switchOffer` ("Sent to checkout. Switch there?", or the meanwhile line about one
  session), a `targetAsk` ("For checkout?" for words that only mention it) and a `meanwhile` list of
  other sessions' updates said together once it is quiet — how an off-screen session's long
  answer is heard; `voiceos/test/support/conversation.ts` runs whole spoken
  conversations (real store, kernel with a scripted model, router, voice) for the tests. Its keys
  live in `~/.config/crew-voiceos/*.key` (0600), never in the environment: the page asks for
  them, `crew server keys set` takes one on stdin, and `crew server start` at a tty asks for
  missing ones — each checked (`CheckKey`: 401/403 is a rejection, anything
  else saves with a warning). Its prompt evals cost money: never in CI, run locally when asked —
  the `voiceos-evals` project skill (`.claude/skills/voiceos-evals/`) has the suites, commands,
  costs and rules; the `route` suite is classification-only and never part of `all`.
  **Any language:** a guard that reads what the developer means asks the judge
  (`voiceos/src/judge/`, one narrow Haiku question, `unclear` on timeout = the safe side), never an
  English regex; the speech layer (stop words, "end of turn", the wake word) stays English.
  **Active sessions and names** are Voice OS's own preferences, with no crew command. Only an
  active session exists for voice: its Claude runs and it is in the kernel's turn; an inactive one
  has no process, says nothing (gates in `speech/connect.ts`, `dev/watch.ts`, the reconnect
  recap, `addMeanwhile`) and is browsed and activated on the page. `shared/active.ts` is the one
  reading of `state.active` outside the reducer and its persistence: `isActive` (what voice says
  and hears — never a setup session, this Mac's `setup` or a remote's `vm1:setup`: those live in
  Set up's chat, never spoken to), `canRun` (what may have a running Claude — an active session or
  any machine's setup session; only the lifecycle sites ask it: `startWorker` in
  `state/helpers.ts` refuses a ref it rejects — every implicit start: send, "now", reconnect —
  and start, stop, resync and delivery go by it), `listActiveRefs` (the active set in the
  developer's order, setup sessions never in it). `state/active.ts` reduces
  `activate` ("Activated X. Switch there?" by voice, silent from the page), `deactivate` (out of
  the set first, then `stopWorker` — the machine-removal clean-up; "X is working. Deactivate
  anyway?" first) and `active_loaded` (starts actives present and stopped); `machine_resynced`
  (`state/machines.ts`) runs `matchMachine` on every connect: active+stopped starts,
  inactive+running stops ("Stopped N sessions on X that aren't active"). Words to an inactive
  session wait in its queue (nothing starts it) behind `switchOffer` kind `activate` ("X isn't
  active. Activate it?"); activating starts it and its start sends them; a remote's setup session runs for its own Set up
  chat, never replaced by the main's. Kernel tools
  `activate`, `deactivate`, `list_sessions` (counts first) are Voice OS commands even on a
  session's screen; "Voice OS, …" always reaches the kernel. `state.names` (full ref → name,
  unique; an empty name clears). Persisted in `~/.crew/voiceos/active.json` (`pinned.json` read
  only when it is missing, then migrated) / `names.json`, the screen in `view.json`. An active
  session opens as `{kind:'session', from:'active'}` (`toShownView`), so its tabs are the active
  set and Esc goes back to Active (`parentView`); `readSessionLabel` (`shared/machines.ts`) is the
  one label rule — a name, else the crew label — and a named session is never prefixed with its
  machine. The always-present **setup** session flag is still `Session.isPinned` (cwd home, crew
  setup only): the name stays because it is on the wire to remotes. Every session runs in Claude
  Code's `auto` permission mode.
  **Plain sessions** (`internal/chat`, `cmd_chat.go`): `crew chat add [--dir] [--name]` / `chat rm` /
  `ls chats` keep `~/.crew/chats.json` per machine (the folder must exist; `chat` is a reserved
  workspace name). Voice OS lists each as `chat/<id>` beside the worktrees (`CrewAdapter.listWorktrees`
  appends them, so remotes report theirs), `isChat` on the session: no crew orientation, no
  `CREW_REF`, no dev-server reads; the crew name is its given name (`readGivenName`). Made and removed
  through Set up's door (`chat_add`/`chat_rm`, the kernel's `new_session`/`remove_session` via
  `runCrewOn`); a new ref's activation is held until it is listed.
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
  cmd_housekeeping.go  crew clean          cmd_server*.go  bare crew, crew server (+ the crew voice alias), keys
  cmd_scan.go          crew add project --scan             cmd_binding_preview.go  add binding --dry-run, ls bindings --preview
  cmd_rm_cost.go       rm workspace|worktree --dry-run     cmd_update.go  crew update [--check]
  cmd_golden_test.go   the Go-written goldens in voiceos/testdata/ the web's Set up reads
  cmd_setup_runner.go  crew _setup — the hidden per-project runner (exempt from help/SKILL)
  internal/
    app/        Bubbletea shell, styles, MoveCursor/RowPrefix/RowName
    config/     ~/.crew paths, settings.json
    debug/      debug.log, its tail and parser
    dev/        ports, routes, proxy, binding resolution, conflicts, scan proposals, formatters
    dirsize/    bytes under a directory (pure)
    exec/       git, tmux, editor, ShellQuote, setup steps (mise + lockfile detection)
    help/       structured command tree (help_test pins every command)
    housekeeping/ the sweep: collect → plan (pure) → apply; SweepOnStart, crew clean
    procs/      process inventory and reclaim
    project/    pool CRUD, bindings, setup, NameFromURL, checkouts.go (the --scan walk) — data only
    transfer/   export/import bundle: Collect, Uncovered, Inspect, Clone, Import*, Encode/Decode;
                cli.go (PlanRows, ApplyProject, RenameWarning, CountPhrase)
    trash/      removed checkouts: rename into ~/.crew/trash, detached rm, sweep on start
    uninstall/  crew uninstall
    release/    crew's GitHub release assets: AssetURL, InstallBinary (crew update and Voice OS)
    voice/      Voice OS lifecycle (tmux session, remembered port, proxy route, login link), its
                install (install.go), requirements (requirements.go) and API keys (keys.go)
    workspace/  Ref/Resolved, worktree CRUD, migration, base branches, smoke start, the launch picker
                and the worktree (launch) page; check.go (the check target, VerdictFor), setup_job.go
                (the runner), store.go (loadFor/updateFor), pool.go (RemoveFromPool, WorkspacesWith),
                direct.go (directRefusal), wires.go (BindingWires), removal_cost.go (rm --dry-run)
```

Import boundaries that shape the packages: `dev` cannot import `workspace` (it declares its own
inputs — `DevProject`, `ResolveParams` — and `workspace.Resolved` builds them). `project` cannot
import `workspace`; what needs both sides (a binding's preview, a removal's cost) is in
`workspace` or `main`. `workspace` cannot import `voice`: the page URL the worktree page
prints is passed in by `main` (`openWorktreePage`).

### Resolved

`workspace.Resolve(ref)` does the I/O once — one workspace read, one pool read — and returns
every project with its path decided and its pool config attached. Commands go
`mustResolve(arg)` → `*Resolved` → work. Don't call `project.Get` inside loops; that is what
`Resolved` replaced. `res.DevProjects()`, `res.ResolveEnv()`, `res.ResolveParams(ports)`.

### TUI

The terminal keeps one interactive view, for launching; configuration is crew's page (Set up).
`crew launch` bare is the **launch picker** (`workspace/view_picker.go`: every worktree from
`ListSummaries`, `[dev]` / `installing…` / `! health`, enter pushes the page). `crew launch
<ref>`, `crew dev tui <ref>` and the `crew <ref>` shortcut open the **worktree page**
(`workspace/view_worktree.go`): launch rows only (Editor + Claude, Claude in terminal, the
remote editor, Shell here — one cursor), its servers read-only (running with URL, or stopped),
the anomaly block `crew dev start` prints, the health block and the runners' table while they
install (launch rows wait, the shell and `l` stay live), `l` for the logs view
(`view_dev_logs.go`, runner logs while installing), and `manageLine` — "manage it in crew:
<page URL without the token> · crew dev start <ref>". It starts, stops, verifies and fixes
nothing. `renderWorktreePage` and `renderPicker` are pure and snapshot-tested. The removed
entry points keep a non-interactive meaning: `crew workspace` / `crew project` print the `ls`
table and "configure in the browser: run crew" (`cmdRemovedTUI`), bare `crew config` is
`config show`, bare `crew export` is everything to the default file, `crew import <file>` is
the plan; creation (`landOn`) prints the runners' table and the page URL, never a TUI.

### New worktree

`AddWorktree`: base-branch table with behind-origin counts (fetches in parallel; `--pull`
(Set up's "Pull" button) fast-forwards local bases without touching a checked-out feature branch — in the
foreground, before the runners) → the worktree recorded, ports reserved → one runner per
project in the background. Each: git worktree (`git -c core.hooksPath=/dev/null worktree
add`, the error is git's last stderr line, `mise trust` when there is a `mise.toml`) →
`.env` copied from the canonical repo or a sibling worktree → install (`mise trust && mise
install`, then the lockfile-detected package manager (uv.lock, pnpm-lock.yaml, yarn.lock, bun.lock[b], package-lock.json, in that order) or the project's `Setup`; a failure ends
that runner, `crew setup <ref> <project>` re-runs) → smoke of its own servers: which panes
still run and which listen on their port, last log lines for the failed ones, stop. The
command prints the table as it stands and returns (`landOn`); `crew setup status` and crew's
page follow it. The worktree page shows the table every 2 s and holds its launch rows until
the runners are done; `l` opens the runner logs (`NewSetupLogsView`).

## Conventions

- **Every feature is a command.** crew's page composes commands (each form shows the argv
  it runs); nothing is page-only, and nothing needs a tty except the launch view, `claude`
  and `open` (their no-tty error names the data alternative). A read the page uses gets a
  `--json` shape pinned by a golden in `voiceos/testdata/`. A new command goes in `help.go`
  (the launch TUI's entries carry a `Notes` line naming the CLI equivalent), and `help_test` requires its usage line and output format
  verbatim in `skills/crew/SKILL.md` — the skill is what an agent reads. `docs/commands.md` is
  generated from the same tree (`help.RenderMarkdown`; `TestCommandsDocIsCurrent` fails when it
  is stale — `UPDATE_DOCS=1 go test ./internal/help -run TestCommandsDocIsCurrent`). The guides
  (`docs/guides/`), `docs/concepts.md`, the README and the plugin files (`agents/crew.md`,
  `skills/*/SKILL.md`) follow by hand. A change to a Voice OS kernel tool
  (`voiceos/src/tools/definitions.ts`: a new or renamed tool, new words that reach it, or what it
  does) updates its section in `docs/guides/voice-os-commands.md` in the same change, examples
  included; `voiceos/src/tools/definitions.spec.ts` fails when a tool has no section.
- **Tab-separated output** for CLI list commands; `--json` everywhere via the global flag
  stripper (`extractFlag` stops at `--` so `crew run … -- child --json` keeps the child's flag).
- **Bubbletea** for the launch view; arrows/enter/esc; letters as accelerators. Every other
  interactive surface is crew's page.
- **Show status after every action.**
- **Warn, never block, at dev-server start.** Crew asserts only facts it owns — ports it
  allocated, projects it placed, URLs it handed out (hence `SmokeUnreached` vs `SmokeIdle`).
  The CLI prints a recorded failure and proceeds; the worktree page shows it and still
  launches. The one carve-out, CLI included: while a setup runner is alive on a worktree, `dev start`,
  `verify`, `setup`, `duplicate` and `rm workspace <p>` refuse (`ErrSetupRunning`) — crew
  owns the fact that it started an install, and a server on top of it is corruption, not a
  warning. `status` and `logs` (and the noun words) are reserved workspace names
  (`ValidateName`). A value pointing at a sibling in the same worktree is normal;
  one pointing into another worktree, or at a sibling's configured port while it runs
  elsewhere, is a conflict.
- **Debug logging** — every external command (tmux, git, editor, package managers, mise)
  goes through `debug.Log(category, …)`: `"tmux"`, `"git"`, `"editor"`, `"dev"`, `"setup"`,
  `"procs"`, `"trash"`, `"uninstall"`, `"voice"`, `"release"`, `"requirements"`, `"chat"`. Log the command before running it; log errors inline.
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
