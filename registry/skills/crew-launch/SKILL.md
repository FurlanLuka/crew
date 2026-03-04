---
name: crew-launch
description: >
  Interactively pick a workspace, launch a Happy Coder session,
  and optionally start dev servers with a reverse proxy so each workspace
  is accessible at {workspace}.{ip}.nip.io:{port}.
user-invocable: true
---

# Launch

All-in-one workspace launcher: Happy Coder session + dev servers.

## Instructions

When the user invokes `/crew-launch`, follow these steps:

### 1. Discover workspaces

Run `crew ls workspaces` to get the list of available workspaces.

### 2. Inspect each workspace

For each workspace, run `crew show <workspace>` to see its projects (name, path, role — tab-separated).

### 3. Let the user pick a workspace

Use **AskUserQuestion** to present the workspaces as options. For each option:
- **label**: workspace name
- **description**: list the project names and their roles (e.g. "api (lead), web-app (support)")

### 4. Launch Happy Coder session

**IMPORTANT:** The `crew happy` command must run **outside** of Claude Code — it spawns a tmux session that won't work if launched from within a Claude Code agent. Use Bash with `run_in_background` and `nohup` to detach it, or instruct the user to run it manually in a separate terminal.

Run (detached):
```bash
nohup crew happy <workspace> >/dev/null 2>&1 &
```

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
- Which workspace was selected
- That the Happy session is running
- Dev server URLs (if started), formatted as clickable links:
  ```
  Dev servers:
    http://<workspace>.<ip>.nip.io:<port>
  ```
- Useful commands:
  - `crew dev restart <workspace>` to restart dev servers
  - `crew dev stop <workspace>` to stop dev servers
  - `crew stop <workspace>` to stop the session
  - `crew kill` to stop everything
