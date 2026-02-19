# homebrew-tap

Homebrew tap for Claude Code power tools. Manage multi-agent teams across projects and install community agents & skills — all from the command line.

```bash
brew tap FurlanLuka/tap
```

## Tools

### crew — Agent team launcher

Coordinate multiple Claude Code agents across projects in a single workspace. Define projects with roles and dev servers, then launch everything with one command.

```bash
brew install FurlanLuka/tap/crew
```

```bash
crew workspace create my-app          # Create a workspace
crew project add my-app               # Add projects (interactive)
crew my-app                           # Launch agents + dev servers
crew kill                             # Tear down everything
```

Agents run in tmux. Dev servers open in Cursor or VS Code with auto-starting tasks. Detaching tears down the full session cleanly.

[Full documentation →](crew/)

### ccm — Claude Code Manager

Package manager for Claude Code agents and skills. Browse a shared registry, install globally or per-project, and keep everything up to date.

```bash
brew install FurlanLuka/tap/ccm
```

```bash
ccm agents list                       # Browse available agents
ccm agents install code-reviewer      # Install globally
ccm skills install e2e-test-writer -p # Install to current project
ccm agents installed                  # See what's installed
```

Agents are `.md` files with YAML frontmatter. Skills are directories with a `SKILL.md` and optional references/scripts. Everything installs into `$CLAUDE_CONFIG_DIR` (default `~/.claude`) or `.claude/` in your project.

Also supports push notifications via [ntfy.sh](https://ntfy.sh) — get alerted on your phone when Claude needs attention (idle, permission needed, input requested):

```bash
ccm notification setup                # One-time setup (no account needed)
```

[Full documentation →](ccm/)

## Registry

Community agents and skills live in [`registry/`](registry/). No manifest files — metadata is parsed directly from YAML frontmatter.

```
registry/
├── agents/
│   └── <name>.md
└── skills/
    └── <name>/
        └── SKILL.md
```

To contribute, add your agent or skill and open a PR.

## Requirements

- macOS
- `python3` on your PATH
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude`)
- `tmux` (installed automatically with crew)
