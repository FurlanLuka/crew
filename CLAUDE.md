# crew

CLI + TUI workspace manager for Claude Code. Workspaces hold projects; worktrees are isolated
working copies of them, each with stable dev-server ports and env bindings that point projects
at each other. Go, Bubbletea, module `github.com/FurlanLuka/crew/crew`, source under `crew/`.

## Model

- **Project** — a repo in the global pool (`~/.crew/projects.json`): name, path, dev servers,
  **bindings**, and an optional **setup** command.
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
  overrides. `crew import` applies each card as `y` is pressed; `--all` never guesses a
  path and never clones. An existing workspace is skip-only; a project can be replaced.
  `transfer` sits above `project` and `workspace`; only `main` imports it.
- **Removal never deletes inline.** `cleanupWorktree` is the one teardown primitive: it
  renames the checkout into `~/.crew/trash` (`trash.Put`, which refuses anything outside
  `WorkspacesDir`), prunes git, and a detached `rm -rf` clears the trash — a full build in a
  checkout can be 100+ GB. `main` sweeps leftovers on every start; Settings shows the size and
  can empty it. The TUI walks worktree sizes asynchronously and keeps them for the view's life.
- A workspace with no `worktrees` predates 2.0. It keeps flat paths and a bare slug until
  `crew migrate` runs; `crew add worktree` is the one thing that refuses it.

## Structure

```
crew/
  main.go              dispatch, mustResolve, the add|rm|ls noun trio
  cmd_dev.go           crew dev …          cmd_worktree.go   worktree/binding/override/setup cmds
  cmd_run.go           crew env, crew run  cmd_migrate.go    crew migrate
  cmd_procs.go         crew ps, crew kill  cmd_uninstall.go  crew uninstall
  cmd_transfer.go      crew export, crew import
  cmd_launch.go        crew launch, claude, edit          cmd_trash.go  crew trash
  internal/
    app/        Bubbletea shell, styles, MoveCursor/RowPrefix/RowName
    config/     ~/.crew paths, settings.json
    debug/      debug.log + its TUI view
    dev/        ports, routes, proxy, binding resolution, conflicts, scan proposals, formatters
    dirsize/    bytes under a directory (pure)
    exec/       git, tmux, editor, ShellQuote, setup steps (mise + lockfile detection)
    help/       structured command tree (help_test pins every command)
    procs/      process inventory and reclaim
    project/    pool CRUD, bindings, setup; project TUI incl. the binding editor
    settings/   settings TUI, trash size + empty, uninstall entry
    transfer/   export/import bundle: Collect, Covered, Inspect, Clone, Import*; picker + wizard TUIs
    trash/      removed checkouts: rename into ~/.crew/trash, detached rm, sweep on start
    uninstall/  crew uninstall
    workspace/  Ref/Resolved, worktree CRUD, migration, base branches, smoke start, TUI
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
`b` bindings (scan-first editor with live preview), `t` setup command.

### New worktree

`AddWorktree`: base-branch table with behind-origin counts (fetches in parallel; `ctrl+p` /
`--pull` fast-forwards local bases without touching a checked-out feature branch) → git
worktree per project, all-or-nothing with rollback → `.env` copied from the canonical repo or
a sibling worktree → recorded → installs per project (`mise trust && mise install`, then
lockfile-detected package manager or the project's `Setup`; failures keep what passed,
`crew setup <ref>` re-runs) → smoke start: servers up six seconds, which panes still run,
last log lines for the dead ones, stop.

## Conventions

- **Every feature is a command.** The TUIs compose commands; nothing is TUI-only. A new
  command goes in `help.go`, and `help_test` requires its usage line verbatim in
  `skills/crew/SKILL.md` — the skill is what an agent reads.
- **Tab-separated output** for CLI list commands; `--json` everywhere via the global flag
  stripper (`extractFlag` stops at `--` so `crew run … -- child --json` keeps the child's flag).
- **Bubbletea** for every interactive view; arrows/enter/esc; letters as accelerators.
- **Show status after every action.**
- **Warn, never block, at dev-server start.** Crew asserts only facts it owns — ports it
  allocated, projects it placed. A value pointing at a sibling in the same worktree is normal;
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
`t.TempDir()`; nothing touches `~/.crew`. Real git via `initRepo` (`workspace_test.go`) and
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

`.claude-plugin/` at the repo root ships the `crew` skill and agent for Claude Code:
`/plugin marketplace add FurlanLuka/crew`, then `/plugin install crew@crew`. Keep
`skills/crew/SKILL.md` in step with the CLI — it is what an agent reads to drive crew.
