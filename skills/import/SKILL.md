---
name: import
description: >
  Guided import of a crew export onto this machine — asks where the bundle file is, walks the
  plan and decides each project (existing path, clone, replace) and workspace with the user.
  Use when the user mentions a crew export/bundle/JSON from another machine, wants to move or
  copy their crew setup here, or says "import my workspaces" / "set crew up on this Mac".
user-invocable: true
---

Bring a crew export ($ARGUMENTS is the file, if given) onto this machine, one decision at a
time. Never guess a path or clone without asking.

1. No file given: ask where it is (`~/Desktop/crew.json`? a path they pasted?). Confirm it
   reads: `crew import <file> --plan --json`.
2. Show the plan as a short table: project / status / detail. Explain the statuses in one
   line each: `exists` (already in the pool), `path exists` (import as is), `suggested` (a
   sibling found beside a repo crew knows — taken automatically), `clone` (not here; would
   clone beside a known repo at the path shown), `missing` (not here and nowhere obvious).
3. For each project that is not `path exists`/`suggested`, ask one question with the real
   options: for `clone` — clone there, clone elsewhere (ask the path), or point at an
   existing checkout (ask the path); for `missing` — an existing path or a clone target;
   for `exists` — keep local or `--replace` with the bundle's servers and bindings. Run
   `crew import <file> project <name> [--path=…] [--clone[=…]] [--replace]` per answer and
   show the row it prints.
4. Workspaces: for each `ready` one, `crew import <file> workspace <name> --pull` — this
   makes the `main` worktree the way `crew add worktree` does (fetches and fast-forwards the
   local bases, checks out, installs, smoke-starts; minutes, not seconds — say so first).
   Relay the base table and the result row; a `created … N issue(s) recorded` row means
   `crew fix <name>/main --print` has the evidence. A `needs …` one: name what is missing
   and skip.
5. Finish with `crew ls worktrees` and the next step: `crew add worktree <ws>/<name>` for
   a working copy, or `crew dev start <ws>/main`.

Paths the user types may contain `~`; pass them through as given. Never print binding
values. If a command fails, show the error and the option that remains.
