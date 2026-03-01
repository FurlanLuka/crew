# crew

CLI + TUI workspace manager for Claude Code. Manages workspaces, worktrees, dev servers, agent/skill registry, and session launching.

## Architecture

- **Language:** Go
- **TUI framework:** Bubbletea (Elm architecture: Model → Update → View)
- **CLI output:** Tab-separated for scripting (`name\tpath\trole`)
- **Registry:** Fetches agents/skills from GitHub API, falls back to local installs on failure
- **Config:** Stored in `CLAUDE_CONFIG_DIR` (defaults to `~/.claude`, user overrides to `~/.claude-personal`)
- **Module path:** `github.com/FurlanLuka/crew/crew`

### Project structure

```
crew/
  main.go              # CLI entry point, command routing
  internal/
    app/               # Bubbletea app shell, styles, key bindings
    config/            # Config dir paths, registry base URL
    dev/               # Dev server management, reverse proxy, routing
    exec/              # Shell execution, tmux, editor detection
    help/              # CLI help system (structured CommandInfo tree)
    notify/            # Push notification setup TUI
    profile/           # Claude profile management TUI
    project/           # Project CRUD
    registry/          # Agent/skill registry (fetch, install, update, TUI)
    workspace/         # Workspace/worktree management, session launching
```

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
- **Fallback gracefully** — if GitHub API fails, use local data
- **Feature-based organization** — each package owns its types, logic, and view

## Development

```bash
# Build
cd crew && go build -o /tmp/crew .

# Test
cd crew && go test ./...

# Run locally
/tmp/crew help
/tmp/crew registry
```

## Release

- GoReleaser pipeline triggers on git tag push
- **Always create new version tags** — never delete and re-tag
- Install script is the sole distribution method

## Agents

Use the following agents when appropriate:

- **nodejs-code-reviewer** — after writing or modifying Node.js/TypeScript backend code, run this agent to review your changes for quality, security, and standards compliance.
- **reactjs-code-reviewer** — after writing or modifying React code, run this agent to review your changes for component design, hooks usage, and standards compliance.
- **pr-reviewer** — when asked to review a pull request, use this agent to analyze the diff and post review comments.
- **daily-chores** — read-only daily dashboard. Gathers GitHub PRs, Linear tasks, and project updates, then outputs a formatted summary with links.
- **web-designer** — award-winning web designer. Researches real award-winning sites for inspiration, then generates unique, distinctive designs through iterative conversation. Use when the user wants to design a website, create a visual theme, generate HTML mockups, or build a design system. Use proactively when design tasks are detected.
- **architect** — software architecture and system design agent. Use when designing new features, modules, APIs, database schemas, or system-level decisions. When entering plan mode for new features or architectural decisions, spawn this agent in the background during the design phase.
- **crew** — crew workspace expert. Use when the user wants to manage workspaces, list projects or worktrees, check dev server status, start/stop/restart dev servers, or launch a workspace session.
- **git-guardian** — git state checker. Use before starting implementation (after plan approval) and after completing implementation. Checks current branch, uncommitted changes, and whether working on main/master.

## Skills

The following skills are available:

- **js-ts-clean-code** — when writing, reviewing, or refactoring JavaScript/TypeScript code, follow these guidelines for readability, simplicity, formatting, naming, imports, assignment patterns, object construction, block formatting, type extraction, logical grouping, and iteration.
- **nodejs-clean-code** — when writing, reviewing, or refactoring Node.js/TypeScript backend code, follow these guidelines for error handling, async patterns, and backend-specific type conventions. Complements `js-ts-clean-code`.
- **reactjs-clean-code** — when writing, reviewing, or refactoring React code, follow these guidelines for component structure, state management, hooks, and composition. Complements `js-ts-clean-code`.
- **reactjs-new-project** — when scaffolding a new React project, follow these guidelines for project structure, tooling, and conventions.
- **web-designer** — design system knowledge base (universal components, layout techniques, design principles, CSS variables, markup rules). Support skill for the web-designer agent — not user-invocable.
- **pr-review-comments** — comment style guide for PR reviews. Ensures comments sound natural and human. Support skill for the pr-reviewer agent — not user-invocable.
- **crew-remote** — remote management reference for crew workspaces, worktrees, dev servers, and deployment URLs.
- **crew-launch** — interactive workspace launcher: discover workspaces, pick one, create worktree, launch session, start dev servers.
