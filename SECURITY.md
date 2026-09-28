# Security

## Reporting a vulnerability

Please report security issues privately: use **GitHub's private vulnerability reporting** on this
repository (Security → Report a vulnerability), not a public issue. You'll get a reply as soon as
possible, and a fix before anything is disclosed.

## What's worth reporting

crew runs on your machine, but a few parts are reachable from other places:

- **Voice OS's web server.** It's signed in with a token cookie, and it's reachable over crew's dev
  proxy from other devices on your network, for example your phone. Anything that gets around the
  sign-in, reads files through `/media`, or drives sessions without it matters.
- **The dev proxy and its HTTPS certificate authority** (`crew dev proxy trust`).
- **Downloads:** `install.sh`, `crew update`, and the Voice OS binary fetched on the first
  `crew voice`.
- **API keys**, stored in `~/.config/crew-voiceos/*.key` (owner-only), and anything that could leak
  them.
- **Commands run on your behalf:** setup commands, env commands and dev server commands from a
  project's configuration.
