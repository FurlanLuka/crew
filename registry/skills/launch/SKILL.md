---
name: launch
description: >
  Interactively pick a workspace and worktree, launch a Happy Coder session,
  and optionally start dev servers with a reverse proxy so each worktree
  is accessible at {worktree}.{ip}.nip.io:{port}.
user-invocable: true
---

# Launch

All-in-one workspace launcher: Happy Coder session + dev servers.

## Instructions

When the user invokes `/launch`, follow these steps:

### 1. Discover workspaces

Run `crew ls workspaces` to get the list of available workspaces.

### 2. Inspect each workspace

For each workspace, run `crew show <workspace>` to see its projects (name, path, role — tab-separated).

### 3. Let the user pick a workspace

Use **AskUserQuestion** to present the workspaces as options. For each option:
- **label**: workspace name
- **description**: list the project names and their roles (e.g. "api (lead), web-app (support)")

### 4. Ask about worktree

Use **AskUserQuestion** to ask if they want to use a worktree:
- Existing worktrees (if any — look for `<workspace>--<name>` patterns in `crew ls workspaces`)
- **"Create new worktree"** — prompt for a name (short, kebab-case)
- **"No worktree"** — launch directly on the main branch

If creating a new worktree, the `crew happy` command handles creation automatically.

### 5. Launch Happy Coder session

Run:
```bash
crew happy <workspace>
```

Or with a worktree:
```bash
crew happy <workspace> --worktree=<name>
```

### 6. Check dev server config

Load the workspace JSON at `~/.crew/workspaces/<workspace>.json` and check if any projects have `dev_servers` configured.

**If dev servers are configured**, ask:
- **"Start dev servers"** — proceed to start them
- **"Skip dev servers"** — finish without starting dev servers

**If no dev servers are configured**, ask:
- **"Set up dev servers"** — auto-detect and configure (see step 6a)
- **"Skip dev servers"** — finish without dev servers

#### 6a. Auto-setup dev servers

For each project, read its `package.json` (at the project path) to detect scripts and likely ports:
- Look for `dev`, `start`, `storybook` scripts
- Common port conventions: Vite = 5173, CRA = 3000, Storybook = 6006, API = 3000/8080

For each detected server, run:
```bash
crew dev add <workspace> <project> --name=<n> --port=<p> --cmd="<c>" [--dir=<d>]
```

If multiple apps exist in subdirectories (monorepo), set `--dir` accordingly.

### 7. Start dev servers

Run:
```bash
crew dev start <workspace> --worktree=<name>
```

Or without worktree:
```bash
crew dev start <workspace>
```

### 8. Show summary

Print:
- Which workspace was selected
- The worktree name (if any)
- That the Happy session is running
- Dev server URLs (if started), formatted as clickable links:
  ```
  Dev servers:
    http://<worktree>.<ip>.nip.io:<port>
  ```
- Useful commands:
  - `crew dev restart <workspace> --worktree=<name>` to restart dev servers
  - `crew dev stop <workspace> --worktree=<name>` to stop dev servers
  - `crew kill` to stop everything
