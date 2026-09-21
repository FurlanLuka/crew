---
name: proxy
description: >
  Why a crew --proxy URL opens on this machine but not on a phone or another device — checks
  the proxy here and walks the other-device test. Use when a nip.io / proxy / LAN hostname
  from crew fails elsewhere, or the user wants to open a dev server on their phone.
user-invocable: true
---

The user's dev-server URL works on this machine but not on another device. You can only see
this side; say so, then work it in this order.

1. `crew dev status $ARGUMENTS` and `crew config show` — is the worktree proxied at all
   (URLs carry `<domain>`, not `localhost`)? If not: `crew dev restart <ref> --proxy`.
2. Give the user the proxy's own page to open on the other device:
   `http://<server_ip>/` (add `:<proxy_port>` when it is not 80).
3. Branch on what they see, per the `crew` skill's "Proxy on other devices":
   loads → DNS refuses `nip.io` (router rebind protection, NextDNS/Pi-hole, iOS Private
   Relay); does not load → the device cannot reach this machine (other network, guest/AP
   isolation, VPN, cellular).
4. Offer Tailscale when either bites: `crew config set server_ip $(tailscale ip -4)`, then
   `crew dev restart <ref> --proxy`. Never change settings without confirming.
