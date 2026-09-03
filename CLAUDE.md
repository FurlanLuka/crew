# crew

CLI + TUI workspace manager for Claude Code. Manages workspaces, worktrees, dev servers, env bindings, and session launching.

## Architecture

- **Language:** Go
- **TUI framework:** Bubbletea (Elm architecture: Model → Update → View)
- **CLI output:** Tab-separated for scripting (`name\tpath\trole`)
- **Config:** Stored in `CLAUDE_CONFIG_DIR` (defaults to `~/.claude`, user overrides to `~/.claude-personal`)
- **Module path:** `github.com/FurlanLuka/crew/crew`

### Model

- **Project** — a registered repo in the global pool (`projects.json`). Owns its dev servers and its **bindings**.
- **Workspace** — membership: which projects, with which roles. Pure config, nothing on disk of its own.
- **Worktree** — one working copy of a workspace's projects, at `~/.crew/workspaces/<ws>/<wt>/<project>`, on branch `crew/<ws>/<wt>/<project>`. Owns **overrides**. Every artifact crew keys per running unit (route file, log dir, tmux session, prompt, `.code-workspace`) is keyed by the worktree's **slug** `<ws>--<wt>`.
- **Ref** — how the user names a worktree: `<ws>/<wt>`, or bare `<ws>` when there is one. `/` is the user-facing separator; `--` appears only in identifiers crew doesn't render (hostnames, filenames, tmux). Anything printed for a human goes through `dev.DisplayRef`.
- **Binding** — `{var, value}` on a project; `value` is a template over `{{url:proj[/server]}}`, `{{port:proj[/server]}}`, `{{worktree}}`, `{{workspace}}`. Resolved at `crew dev start` after ports are allocated and injected into the process env as exports. Precedence: worktree override > binding > left alone. A template that only partly expands is discarded whole. Env files are read (for the conflict warning and the scan), never written.
- A workspace with no `worktrees` predates this model. It keeps flat paths and a bare slug until `crew migrate` runs; `crew add worktree` is the one thing that refuses it.

### Project structure

```
crew/
  main.go              # CLI entry point, command routing
  internal/
    app/               # Bubbletea app shell, styles, key bindings
    config/            # Config dir paths, settings
    dev/               # Dev server management, reverse proxy, routing, binding resolution
    exec/              # Shell execution, tmux, editor detection
    help/              # CLI help system (structured CommandInfo tree)
    project/           # Project CRUD
    workspace/         # Workspace/worktree management, Resolved context, migration, session launching
```

`dev` cannot import `workspace` (cycle). `dev` declares its own input types (`DevProject`,
`ResolveParams`) and `workspace.Resolved` builds them. `project` cannot import `workspace`
either; the binding editor's live preview is a function `main` wires in (`project.Previewer`).

## UX philosophy

crew is a power-user tool. It should feel fast, intuitive, and polished:

- **Instant feedback** — show status after every action, never leave the user wondering
- **Beautiful terminal output** — use lipgloss styles consistently, align columns, use icons
- **No unnecessary prompts** — smart defaults, flags over interactive Q&A for CLI
- **Clickable URLs** — always print full URLs so terminals can make them clickable
- **Graceful errors** — clear message, suggest the fix, exit non-zero
- **TUI for browsing, CLI for scripting** — same features available both ways

## Key conventions

- **Tab-separated output** for all CLI list commands (pipe-friendly)
- **Bubbletea** for all interactive views (consistent navigation: arrows, tab, esc)
- **Always show status** after install/remove/update actions
- **Feature-based organization** — each package owns its types, logic, and view
- **Debug logging** — every external command execution (tmux, git, editor, npm, osascript) must include a `debug.Log(category, ...)` call. Log the command before running it; log errors inline. Use categories matching the package: `"tmux"`, `"git"`, `"editor"`, `"dev"`. Import from `github.com/FurlanLuka/crew/crew/internal/debug`.
- **Never log binding values** — names, sources and targets only. Bindings and overrides carry service URLs and can carry credentials.
- **Resolve once** — commands take a ref, call `mustResolve` / `workspace.Resolve`, and work from the `*Resolved`. Don't call `project.Get` inside loops; that is the pattern `Resolved` replaced.
- **Warn, never block, at dev-server start** — crew asserts only facts it owns (ports it allocated, projects it placed). It is not a schema validator for every project.

## Development

```bash
# Build
cd crew && go build -o /tmp/crew .

# Test
cd crew && go test ./...

# Run locally
/tmp/crew help
/tmp/crew workspace
```

## Release

- GoReleaser pipeline triggers on git tag push
- **Always create new version tags** — never delete and re-tag
- Install script is the sole distribution method

## Agents

Use the following agents when appropriate:

- **nodejs-code-reviewer** — after writing or modifying Node.js/TypeScript backend code, run this agent to review your changes for quality, security, and standards compliance.
- **reactjs-code-reviewer** — after writing or modifying React code, run this agent to review your changes for component design, hooks usage, and standards compliance.
- **web-designer** — award-winning web designer. Researches real award-winning sites for inspiration, then generates unique, distinctive designs through iterative conversation. Use when the user wants to design a website, create a visual theme, generate HTML mockups, or build a design system. Use proactively when design tasks are detected.
- **architect** — software architecture and system design agent. Use when designing new features, modules, APIs, database schemas, or system-level decisions. When entering plan mode for new features or architectural decisions, spawn this agent in the background during the design phase.
- **clean-code-architect** — clean code architecture agent. Use when reviewing code for refactoring opportunities, planning extractions, identifying tangled logic, or designing clean patterns for existing code.
- **test-architect** — test architecture and strategy agent. Use when planning what to test, designing test structure, identifying coverage gaps, or deciding how to test a new feature.
- **crew** — crew workspace expert. Use when the user wants to manage workspaces, list projects, check dev server status, start/stop/restart dev servers, or launch a workspace session.

## Skills

The following skills are available:

- **js-ts-clean-code** — when writing, reviewing, or refactoring JavaScript/TypeScript code, follow these guidelines for readability, simplicity, formatting, naming, imports, assignment patterns, object construction, block formatting, type extraction, logical grouping, and iteration.
- **nodejs-clean-code** — when writing, reviewing, or refactoring Node.js/TypeScript backend code, follow these guidelines for error handling, async patterns, and backend-specific type conventions. Complements `js-ts-clean-code`.
- **reactjs-clean-code** — when writing, reviewing, or refactoring React code, follow these guidelines for component structure, state management, hooks, and composition. Complements `js-ts-clean-code`.
- **reactjs-new-project** — when scaffolding a new React project, follow these guidelines for project structure, tooling, and conventions.
- **web-designer** — design system knowledge base (universal components, layout techniques, design principles, CSS variables, markup rules). Support skill for the web-designer agent — not user-invocable.
- **crew-remote** — remote management reference for crew workspaces, dev servers, and deployment URLs.
- **code-documenting** — code documentation and commenting guidelines. Covers when, where, and how to write comments that explain business context, domain rules, external dependencies, and non-obvious decisions. Use when writing, reviewing, or refactoring code that involves business logic or system integrations. Complements `js-ts-clean-code`.
- **crew-launch** — interactive workspace launcher: discover workspaces, pick one, launch session, start dev servers.
