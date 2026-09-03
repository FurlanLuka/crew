---
name: crew-launch
description: >
  Interactive workspace launcher: discover workspaces, pick one,
  launch session, start dev servers.
user-invocable: true
---

# Launch

All-in-one workspace launcher: session + dev servers.

## Instructions

When the user invokes `/crew-launch`, follow these steps:

### 1. Discover worktrees

Run `crew ls worktrees` to get every working copy, one row per `<workspace>/<worktree>`
(tab-separated: ref, path, and `dev` when its servers are running). A workspace is
membership; a worktree is what you actually launch.

If no workspaces exist, offer to create one:
1. Ask for a workspace name
2. Run `crew workspace` (TUI) or guide through CLI: `crew` → Workspace → New

### 2. Inspect each worktree

For each worktree, run `crew show <workspace>/<worktree>` to see its projects (name, path, mode, role — tab-separated).

### 3. Let the user pick a worktree

Use **AskUserQuestion** to present the worktrees as options. For each option:
- **label**: `<workspace>/<worktree>`
- **description**: list the project names and their roles (e.g. "api (lead), web-app (support)")

A bare workspace name works everywhere when the workspace has exactly one worktree.

### 4. Launch session

Instruct the user to run `crew launch <workspace>/<worktree>` in their terminal. This opens the TUI launch view with two modes:
- **Editor + Claude (Skip permissions)** — opens the workspace in Cursor/VS Code with Claude wired up
- **Claude (Skip permissions)** — launches Claude Code directly with all project directories

**Note:** `crew launch` replaces the current process (`syscall.Exec`), so it cannot be run from within Claude Code. The user must run it in a separate terminal.

### 5. Check dev server config

Run `crew dev show <project>` for each project in the workspace to check if dev servers are configured.

**If dev servers are configured**, ask:
- **"Start dev servers"** — proceed to start them
- **"Skip dev servers"** — finish without starting dev servers

**If no dev servers are configured**, ask:
- **"Set up dev servers"** — auto-detect and configure (see step 5a)
- **"Skip dev servers"** — finish without dev servers

#### 5a. Auto-setup dev servers

For each project, read its `package.json` (at the project path) to detect scripts and likely ports:
- Look for `dev`, `start`, `storybook` scripts
- Common port conventions: Vite = 5173, CRA = 3000, Storybook = 6006, API = 3000/8080

For each detected server, run:
```bash
crew dev add <project> --name=<n> --port=<p> --cmd="<c>" [--dir=<d>]
```

If multiple apps exist in subdirectories (monorepo), set `--dir` accordingly.

### 5b. Check bindings

Projects that talk to each other over localhost should declare bindings, so crew injects the
right URL for the ports it allocated instead of the project reading a stale one from its
`.env`. Run `crew ls bindings <project>` for each project. If a project has none, offer
`crew add binding <project> --scan` — it reads the project's `.env` and proposes bindings for
every value already pointing at a port crew allocates. Add with `--apply` once the user agrees.

### 6. Start dev servers

Run:
```bash
crew dev start <workspace>/<worktree>
```

The output ends with a resolution summary. Any line under it is something to relay verbatim:
`left alone` means a binding could not resolve in this worktree; a `!` block means an env file
points at a port crew gave to a *different* project — the server will still start, but that
variable is talking to the wrong service.

### 7. Show summary

Print:
- Which worktree was launched
- Dev server URLs (if started), formatted as clickable links:
  ```
  Dev servers:
    http://<server>--<workspace>--<worktree>.<ip>.nip.io
  ```
- Useful commands:
  - `crew dev restart <workspace>/<worktree>` to restart dev servers
  - `crew dev stop <workspace>/<worktree>` to stop dev servers
  - `crew env <workspace>/<worktree> <project>` to see every resolved variable
  - `crew run <workspace>/<worktree> <project> -- <cmd>` to run a script or eval with the same env
  - `crew add worktree <workspace>/<name>` for a second working copy
  - `crew rm worktree <workspace>/<worktree>` to remove this one
