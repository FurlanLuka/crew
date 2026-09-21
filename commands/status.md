---
description: What crew has checked out and what is running — worktrees, servers, recorded issues
---

Run `crew ls worktrees <workspace> --json` and `crew dev status $ARGUMENTS --json` — the
argument is a workspace or `ws/wt`; `ls worktrees` takes only the workspace half; both bare
when none. For every worktree with servers running, also `crew dev check <ref>`.
Summarize readably: recorded issues first (`checkout failed`, `install failed`, `server died`,
`server not listening`, `N issues` — with the `crew fix <ref> --print` / `crew verify <ref>`
line), then each worktree with its running servers, their check verdict and clickable URLs,
then the ones with nothing running. Refs as `ws/wt`. Do not guess; if a command fails, show
the error.
