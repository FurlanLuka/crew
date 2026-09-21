---
name: setup
description: >
  Guided crew workspace setup — which repos, what roles, which dev servers and bindings, then
  builds the workspace and checks the servers come up. Use when the user wants to set up,
  create or bootstrap a workspace, add several projects to one, register repos with crew, or
  says "get this project into crew" / "set up crew for X".
user-invocable: true
---

Set up a crew workspace with the user, one question at a time. $ARGUMENTS may name it.

1. `crew ls projects` and `crew ls workspaces` first — never re-add what exists.
2. Ask what the workspace is for and which repos belong in it (paths on disk). For each repo
   not in the pool: `crew add project <name> <path>` (name = the directory name unless they
   say otherwise; `a-z 0-9 -`). If it needs more than the lockfile to install (model weights,
   a `make` target), ask for the setup command: `--setup="…"`. If its README or Makefile
   mentions secrets, sops, 1Password or a `get-env` target, ask for the env command that
   writes the checkout's env files: `--env-cmd="make get-env"` — it runs before the install.
   Skip the question otherwise; most projects have none.
3. Dev servers, per project: `crew dev setup <project>` shows what `package.json` offers;
   confirm the port and command, then `crew dev setup <project> --apply --port=<p>` or
   `crew dev add <project> --name=<n> --port=<p> --cmd="<c>"`. Remind them the command must
   bind `$PORT`.
4. Bindings: `crew add binding <project> --scan` for each project; show the proposals; apply
   the unambiguous ones with `--apply`, ask about any marked ambiguous.
5. Roles: ask one line per project ("Backend API", "iOS app"). Then one call:
   `crew add workspace <ws> a:"role" b:"role" …`. It returns at once — one runner per
   project installs in the background. Poll `crew setup status <ws>/main` (exit 2 while
   running); a `✗` row is recorded the moment it fails — `crew fix <ws>/main --print` has
   the evidence, fix it, `crew verify <ws>/main <project>` — while the others still
   install. Relay the final table.
6. Check it works: `crew dev start <ws>/main`, relay the URLs and `!` lines, then
   `sleep 6; crew dev check <ws>/main`. Every row `running`? Hand them `crew claude
   <ws>/main` (or `crew launch <ws>/main`). Otherwise fix what the check names.

Ask with real options where they exist (which repos, which script, which port); free text
for names and roles. Never print binding values.
