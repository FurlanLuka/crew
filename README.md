# homebrew-tap

Homebrew tap for Claude Code power tools. Manage multi-agent teams across projects and install community agents & skills — all from a polished interactive TUI.

```bash
brew tap FurlanLuka/tap
```

## crew — Agent team launcher & registry

Coordinate multiple Claude Code agents across projects in a single workspace. Define projects, assign roles, then launch everything with one command. Manage agents, skills, profiles, and notifications — all from one interactive CLI.

```bash
brew install FurlanLuka/tap/crew
```

### Commands

| Command | Description |
|---------|-------------|
| `crew` | Main menu — pick any domain |
| `crew workspace` | Manage workspaces, projects, worktrees, and launch |
| `crew project` | Global project pool — add/remove projects |
| `crew registry` | Install and manage agents & skills |
| `crew profile` | Manage Claude profile |
| `crew notify` | Push notification setup |
| `crew kill` | Kill all crew sessions |
| `crew <name>` | Launch workspace directly |
| `crew --version` | Print version |

### Quick start

```bash
crew project              # Add your projects (name + path)
crew workspace            # Create a workspace, add projects, launch
crew kill                 # Tear down everything
```

### Registry

```bash
crew registry             # Browse and install agents & skills
```

Push notifications via [ntfy.sh](https://ntfy.sh) — get alerted when Claude needs attention:

```bash
crew notify               # One-time setup (no account needed)
```

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
| `js-ts-clean-code` | JS/TS clean code guidelines (readability, formatting, naming, imports, structure, patterns). |
| `nodejs-clean-code` | Node.js/backend-specific guidelines (error handling, async). Extends `js-ts-clean-code`. |
| `reactjs-clean-code` | React-specific guidelines (components, state, hooks, composition). Extends `js-ts-clean-code`. |
| `reactjs-new-project` | Recommended React project architecture and setup conventions. |
| `pr-review-comments` | Comment style guide for PR reviews. Support skill for pr-reviewer. |
| `web-designer` | Design system knowledge base for web design generation. Support skill for web-designer. |

To contribute, add your agent or skill and open a PR.
