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

### 1. Discover workspaces

Run `crew ls workspaces` to get the list of available workspaces.

If no workspaces exist, offer to create one:
1. Ask for a workspace name
2. Run `crew workspace` (TUI) or guide through CLI: `crew` → Workspace → New

### 2. Inspect each workspace

For each workspace, run `crew show <workspace>` to see its projects (name, path, role — tab-separated).

### 3. Let the user pick a workspace

Use **AskUserQuestion** to present the workspaces as options. For each option:
- **label**: workspace name
- **description**: list the project names and their roles (e.g. "api (lead), web-app (support)")

### 4. Launch session

Instruct the user to run `crew launch <workspace>` in their terminal. This opens the TUI launch view with two modes:
- **Editor + Agents** — opens the workspace in Cursor/VS Code with Claude agent teams
- **Claude** — launches Claude Code directly with all project directories

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

### 6. Start dev servers

Run:
```bash
crew dev start <workspace>
```

### 7. Show summary

Print:
- Which workspace was launched
- Dev server URLs (if started), formatted as clickable links:
  ```
  Dev servers:
    http://<server>--<workspace>.<ip>.nip.io
  ```
- Useful commands:
  - `crew dev restart <workspace>` to restart dev servers
  - `crew dev stop <workspace>` to stop dev servers
  - `crew git <workspace>` to launch lazygit
  - `crew rm <workspace>` to remove the workspace
