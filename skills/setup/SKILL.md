---
name: setup
description: >
  Guided crew workspace setup — which repos (paths on disk, git URLs, or picked from `gh repo
  list`), which dev servers and bindings, then proves each project runs from a
  fresh checkout, builds the workspace and checks the servers come up. Use when the user
  wants to set up, create or bootstrap a workspace, add several projects to one, register
  repos with crew, clone repos into crew, bootstrap from GitHub, or says "get this project
  into crew" / "set up crew for X".
user-invocable: true
---

Set up a crew workspace with the user, one question at a time. $ARGUMENTS may name it.
(crew's page — bare `crew`, Set up — does the same with forms; this is the conversation.)

1. `crew ls projects` and `crew ls workspaces` first — never re-add what exists.
   `crew add project --scan` lists the checkouts already on this machine (`known` ones are in
   the pool) — offer the `new` ones.
2. Ask what the workspace is for and which repos belong in it: a path on disk, a git URL,
   or a pick from GitHub — `gh auth status`, then `gh repo list <owner> --json
   name,url,description --limit 100` and offer the names (no `gh`: ask for URLs). For each
   repo not in the pool: `crew add project <url>` (cloned into
   `~/.crew/projects/<name>`, named by the repo; `crew add project <name> <url>` for another
   name; `a-z 0-9 -`),
   or `crew add project <name> --path=<dir>` for a checkout they already have (a bare path
   is refused; the repo's own origin becomes its identity). Then read the repo — README, Makefile,
   package.json, pyproject.toml, mise.toml — for how it installs and runs. If it needs more
   than the lockfile to install (model weights, a `make` target), propose the setup command:
   `--setup="…"`. If the README or Makefile mentions secrets, sops, 1Password or a
   `get-env` target, propose the env command that writes the checkout's env files:
   `--env-cmd="make get-env"` — it runs after the install. Skip otherwise; most projects
   have none. Both land with `crew add project <name> --setup=… --env-cmd=…` on an existing
   project.
3. Dev servers, per project: `crew dev setup <project>` shows what `package.json` offers;
   confirm the port and command, then `crew dev setup <project> --apply --port=<p>` or
   `crew dev add <project> --name=<n> --port=<p> --cmd="<c>"` (no `--port` for a worker
   that does not listen). Remind them the command must
   bind `$PORT`. A server under the wrong name: `crew dev add <project> --name=<new>
   --rename=<old>` keeps its scoped bindings.
4. Bindings: `crew add binding <project> --scan` for each project; show the proposals; apply
   the unambiguous ones with `--apply`, ask about any marked ambiguous. A monorepo — one
   project with several dev servers — binds per server when its servers want different
   siblings: `crew add binding <project>/<server> --var=… --url=…`, and `crew add binding
   <project>/<server> --scan` reads the env files under that server's `--dir`. A fresh clone has no
   env files to scan, so propose from the README instead (`crew add binding <project>
   --var=X --url=<proj[/server]>`) and run `--scan` again once a worktree exists. Before
   adding one by hand, `--dry-run` shows the value it gets in every worktree — show it.
5. Prove it: `crew check project <name> --wait` per project — a fresh checkout through
   install, env command and a smoke of its servers, then removed. `✗`: `crew setup logs
   check/<name> <name>` (or `crew fix check/<name> --print`) says what failed; fix the
   config (`--setup`, `--env-cmd`, the `dev add` command, `$PORT`), check again. Do not go
   on to the workspace with a failing check — every worktree would hit the same wall.
6. One call: `crew add workspace <ws> a b …`. It returns at once — one runner per
   project installs in the background. Poll `crew setup status <ws>/main` (exit 2 while
   running); a `✗` row is recorded the moment it fails — `crew fix <ws>/main --print` has
   the evidence, fix it, `crew verify <ws>/main <project>` — while the others still
   install. Relay the final table.
7. Check it works: `crew dev start <ws>/main`, relay the URLs and `!` lines, then
   `sleep 6; crew dev check <ws>/main`. Every row `running`? Hand them `crew claude
   <ws>/main` (or `crew launch <ws>/main`). Otherwise fix what the check names.

Ask with real options where they exist (which repos, which script, which port); free text
for names. Never print binding values.
