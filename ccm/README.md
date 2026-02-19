# ccm

Claude Code Manager — package manager for Claude Code agents and skills.

Install agents and skills from a shared registry into your global Claude Code config or into a specific project.

## Install

```bash
brew install FurlanLuka/tap/ccm
```

## Quick start

```bash
# Browse what's available
ccm agents list
ccm skills list

# Install globally (available in all projects)
ccm agents install code-reviewer
ccm skills install e2e-test-writer

# Install into current project only
ccm agents install code-reviewer -p
ccm skills install e2e-test-writer -p

# See what you have
ccm agents installed
ccm skills installed
```

## Usage

### Agents

Agents are single `.md` files with YAML frontmatter that define a persona or behaviour for Claude.

```bash
ccm agents list                    # List available agents from registry
ccm agents install <name>          # Install agent globally
ccm agents install <name> -p       # Install agent to current project
ccm agents installed               # List installed agents
ccm agents remove <name>           # Remove an agent
ccm agents update [name]           # Update one or all agents
```

### Skills

Skills are directories containing a `SKILL.md` and optional supporting files (`references/`, `scripts/`). They extend Claude with specialized knowledge or workflows.

```bash
ccm skills list                    # List available skills from registry
ccm skills install <name>          # Install skill globally
ccm skills install <name> -p       # Install skill to current project
ccm skills installed               # List installed skills
ccm skills remove <name>           # Remove a skill
ccm skills update [name]           # Update one or all skills
```

## Install locations

| Flag | Agents | Skills |
|------|--------|--------|
| *(default)* | `$CLAUDE_CONFIG_DIR/agents/<name>.md` | `$CLAUDE_CONFIG_DIR/skills/<name>/` |
| `-p` | `.claude/agents/<name>.md` | `.claude/skills/<name>/` |

`CLAUDE_CONFIG_DIR` defaults to `~/.claude`.

## Registry

The registry lives in this repo under [`registry/`](../registry/):

```
registry/
├── agents/
│   └── <name>.md
└── skills/
    └── <name>/
        ├── SKILL.md
        └── ...
```

Agent and skill metadata (name, description) is parsed from YAML frontmatter in the `.md` files — no separate manifest needed.

### Contributing agents or skills

1. Add your agent `.md` file to `registry/agents/` or your skill directory to `registry/skills/`
2. Include YAML frontmatter with at least a `description` field
3. Open a PR

## Environment

| Variable | Description |
|----------|-------------|
| `CLAUDE_CONFIG_DIR` | Where agents and skills are installed globally. Defaults to `~/.claude`. |

## Requirements

- `python3` (for JSON parsing)
- `curl` (for registry downloads)
