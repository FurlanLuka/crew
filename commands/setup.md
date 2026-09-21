---
description: Guided workspace setup — which repos, what roles, which dev servers, then build and check it
---

Set up a crew workspace with the user, one question at a time. $ARGUMENTS may name it.

1. `crew ls projects` and `crew ls workspaces` first — never re-add what exists.
2. Ask what the workspace is for and which repos belong in it (paths on disk). For each repo
   not in the pool: `crew add project <name> <path>` (name = the directory name unless they
   say otherwise; `a-z 0-9 -`). If it needs more than the lockfile to install (model weights,
   a `make` target), ask for the setup command: `--setup="…"`.
3. Dev servers, per project: `crew dev setup <project>` shows what `package.json` offers;
   confirm the port and command, then `crew dev setup <project> --apply --port=<p>` or
   `crew dev add <project> --name=<n> --port=<p> --cmd="<c>"`. Remind them the command must
   bind `$PORT`.
4. Bindings: `crew add binding <project> --scan` for each project; show the proposals; apply
   the unambiguous ones with `--apply`, ask about any marked ambiguous.
5. Roles: ask one line per project ("Backend API", "iOS app"). Then one call:
   `crew add workspace <ws> a:"role" b:"role" …`. Relay the rows; a `failed` row is recorded
   on the worktree — `crew fix <ws>/main --print` has the evidence.
6. Check it works: `crew dev start <ws>/main`, relay the URLs and `!` lines, then
   `sleep 6; crew dev check <ws>/main`. Every row `running`? Hand them `crew claude
   <ws>/main` (or `crew launch <ws>/main`). Otherwise fix what the check names.

Ask with real options where they exist (which repos, which script, which port); free text
for names and roles. Never print binding values.
