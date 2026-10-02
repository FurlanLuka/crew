# Security

## Supported versions

Only the latest release gets security fixes. `crew update` installs it, together with the
matching Voice OS.

## Reporting a vulnerability

Please report security issues privately: use **GitHub's private vulnerability reporting** on this
repository (Security → Report a vulnerability), not a public issue. You'll get a reply as soon as
possible, and a fix before anything is disclosed.

## What's worth reporting

crew runs on your machine, but a few parts are reachable from other places or act on your behalf:

- **crew's web server** (Voice OS and Set up, started by `crew`). It listens on 127.0.0.1 and is
  reachable from other devices, for example your phone, through crew's dev proxy. Sign-in is a
  cookie set from the token in `~/.crew/voiceos/token` (owner-only, 64 hex characters); the
  WebSocket and `POST /api/crew` (Set up's typed crew commands) also require an exact Origin.
  Anything that gets around the sign-in, reads files through `/media`, runs a crew command the
  schema does not allow, or drives sessions without it matters.
- **Remote machines.** A main drives another machine's sessions by running
  `ssh <host> … crew voice _attach` there, with `BatchMode=yes`: SSH is the only authentication,
  and the list of hosts is `~/.crew/voiceos/machines.json`. On the remote, `_attach` bridges that
  login to the `voiceos remote serve` daemon over a unix socket in `~/.crew/voiceos/remote/`
  (socket 0600, directory 0700). Another local user reaching that socket, or anything that makes a
  main connect to a host it wasn't told about, matters.
- **Sessions act on their own.** crew's server runs every Claude Code session, Set up's
  chat included, in Claude Code's auto permission mode: routine actions run without asking, and Claude
  Code's safety check blocks risky ones. "Allow it" approves only the one call that was blocked.
  A way to get a session to act beyond that, or to approve something by voice that you didn't
  say, matters.
- **The dev proxy and its HTTPS certificate authority** (`crew dev proxy trust`).
- **Downloads:** `install.sh`, `crew update`, and the Voice OS binary fetched on the first
  `crew` (or `crew server start`).
- **API keys**, stored in `~/.config/crew-voiceos/*.key` (owner-only), and anything that could leak
  them.
- **Commands run on your behalf:** setup commands, env commands and dev server commands from a
  project's configuration.
