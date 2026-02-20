# homebrew-tap

Homebrew tap for Claude Code power tools. Manage multi-agent teams across projects and install community agents & skills — all from the command line.

```bash
brew tap FurlanLuka/tap
```

## crew — Agent team launcher & registry

Coordinate multiple Claude Code agents across projects in a single workspace. Define projects with roles, then launch everything with one command. Manage agents, skills, profiles, and notifications — all from one CLI.

```bash
brew install FurlanLuka/tap/crew
```

```bash
crew workspace create my-app          # Create a workspace
crew project add my-app               # Add projects (interactive)
crew my-app                           # Launch agents in Cursor
crew kill                             # Tear down everything
```

```bash
crew agents install code-reviewer     # Install an agent
crew skills install e2e-test-writer   # Install a skill
crew agents list                      # See what's installed
crew update                           # Update everything
```

Push notifications via [ntfy.sh](https://ntfy.sh) — get alerted when Claude needs attention:

```bash
crew notify setup                     # One-time setup (no account needed)
```

[Full documentation →](crew/)

## Registry

Community agents and skills live in [`registry/`](registry/).

### Agents

| Agent | Description |
|-------|-------------|
| `architect` | Software architecture and system design agent. |
| `daily-chores` | Read-only daily dashboard. Gathers GitHub PRs, Linear tasks, and project updates. |
| `nodejs-code-reviewer` | Reviews Node.js/backend TypeScript code for quality, security, and standards. |
| `pr-reviewer` | Reviews GitHub pull requests using the gh CLI. |
| `reactjs-code-reviewer` | Reviews React code for quality, security, and standards. |
| `web-designer` | Award-winning web designer. Generates unique designs through iterative conversation. |

### Skills

| Skill | Description |
|-------|-------------|
| `nodejs-clean-code` | Node.js and backend TypeScript clean code guidelines. |
| `pr-review-comments` | Comment style guide for PR reviews. Support skill for pr-reviewer. |
| `reactjs-clean-code` | React clean code guidelines. |
| `reactjs-new-project` | Recommended React project architecture and setup conventions. |
| `web-designer` | Design system knowledge base for web design generation. Support skill for web-designer. |

No manifest files — metadata is parsed directly from YAML frontmatter.

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
