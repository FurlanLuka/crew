---
name: import
description: >
  Guided import of a crew export onto this machine — asks where the bundle file is, walks the
  plan and decides each project (clone, adopt a checkout already here, replace) and workspace
  with the user.
  Use when the user mentions a crew export/bundle/JSON from another machine, wants to move or
  copy their crew setup here, or says "import my workspaces" / "set crew up on this Mac".
user-invocable: true
---

Bring a crew export ($ARGUMENTS is the file, if given) onto this machine, one decision at a
time. A project is its git remote: the default is a clone into `~/.crew/projects/<name>`;
never adopt a path without asking.

1. No file given: ask where it is (`~/Desktop/crew.json`? a path they pasted?). Confirm it
   reads: `crew import <file> --plan --json`.
2. Show the plan as a short table: project / status / detail. Explain the statuses in one
   line each: `exists` (here under the same remote — nothing to do), `other remote` (the
   name is here but points at another repo), `clone` (not here; would clone into the dir
   shown), `blocked` (that dir is already taken), `missing` (no remote in the bundle — a
   path is the only way; an old bundle's path is shown as the hint).
3. For each project, ask one question with the real options: for `clone` — clone there,
   or point at a checkout they already have (ask the path — a repo already on disk would
   otherwise be cloned twice); for `blocked` — adopt the dir that is there, or delete it
   first; for `missing` — the path of the checkout; for `exists` — keep local or
   `--replace` with the bundle's servers and bindings (checkout kept); for `other remote`
   — which repo is right (`--replace` clones the bundle's; refused while a workspace still
   has the project). Run `crew import <file> project <name> [--path=…] [--replace]` per
   answer and show the row it prints.
4. Workspaces: for each `ready` one, `crew import <file> workspace <name> --pull` — this
   makes the `main` worktree the way `crew add worktree` does: fetches and fast-forwards
   the local bases, then one runner per project in the background (checkout, install,
   smoke) and returns. Relay the base table, then poll `crew setup status <name>/main`
   (exit 2 while running); a `✗` row is on the worktree the moment it fails — `crew fix
   <name>/main --print` has the evidence — act on it while the rest install. Relay the
   final table. A `needs …` one: name what is missing and skip.
5. Finish with `crew ls worktrees` and the next step: `crew add worktree <ws>/<name>` for
   a working copy, or `crew dev start <ws>/main`.

Paths the user types may contain `~`; pass them through as given. Never print binding
values. If a command fails, show the error and the option that remains.
