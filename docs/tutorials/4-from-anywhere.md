# 4. From anywhere

crew's page lives on the machine that runs crew's server, and out of the box only that machine's
browser opens it, at a `localhost` link. That's fine at the desk. This tutorial is about the rest:
the page on another computer, on my phone, and Voice OS in a Discord voice channel, which is how I
talk to my sessions when I'm away from the desk.

It builds on [the first two tutorials](1-install-and-first-worktree.md), and works the same whether
the server runs on your laptop or on a VM. The details are in
[Other devices](../concepts.md#other-devices) and the [Voice OS guide](../guides/voice-os.md).

## Two ways in

There are two ways to reach the page from somewhere else. **crew's proxy** gives it a real
hostname on your network that any device can open. An **SSH tunnel** forwards the page's port to
the computer you're on, so it opens as `localhost` there. The proxy is the one for a phone; the
tunnel is the quick one from another computer that already has SSH.

The microphone matters for choosing. Browsers give it only to `localhost` and HTTPS pages. A tunnel
is `localhost`, so voice works at once. The proxy needs HTTPS, which crew serves with its own
certificate authority, and each device has to trust that once. Until it does, the proxy link works
for typing and clicking, not for voice.

## crew's proxy

The proxy is the same reverse proxy that serves dev servers with `crew dev start --proxy`. crew's
server starts it and puts the page on it at `voice--os.<domain>`. Two settings decide the domain:

- `server_ip` is how other devices reach this machine. crew detects it from the first network
  interface; set it when that's the wrong one, for example to the Tailscale address.
- `domain` defaults to `<server_ip>.nip.io`, a public DNS name that resolves to that IP with no setup.
  Set your own when you have one, with a wildcard record (`*.dev.example.com`) pointing at
  `server_ip`.

On the page they're **Server IP** and **Proxy domain** in Set up's Settings, under This machine.
From the terminal:

```bash
crew config set server_ip 100.65.54.14      # tailscale ip -4 prints yours
crew config set domain dev.example.com      # only with your own wildcard DNS
crew config show
```

A changed domain reaches the page's link when crew's server starts again (`crew server restart`,
which ends the running sessions until they start again), and the dev servers' links on the next
`crew dev restart <ref> --proxy`.

`crew server status` prints both links, the localhost one and the proxy one:

```bash
crew server status
```

The proxy has its own commands:

```bash
crew dev proxy status     # up or down, its domain and port, whether HTTPS answers
crew dev proxy trust      # the certificate and how to trust it on each kind of device
crew dev proxy stop       # stops the proxy alone; worktrees keep running on their ports
```

`crew dev proxy trust` prints the steps for a Mac, an iPhone and Android. On an iPhone you open
`http://<domain>/crew-ca.pem` in Safari, install the profile, then turn it on under Settings →
General → About → Certificate Trust Settings. On this Mac, `crew dev proxy trust --install` adds it
to the keychain. **Trust on other devices** in Set up's Settings shows the same thing. Check that
the SHA-256 on the device matches the one crew printed.

When a proxy link doesn't load on a phone, it's nearly always one of two things. If the page
doesn't load at all, the phone can't reach the machine (another network, guest Wi-Fi isolation, a
VPN, cellular). If `http://<server_ip>/` loads but the hostname doesn't, the phone's DNS is refusing
`nip.io`, which routers with rebind protection and iOS Private Relay do. Allow `nip.io` there, or use
a domain of your own. [Tailscale](https://tailscale.com) sidesteps both: put the machine and the
phone on it, set `server_ip` to the Tailscale address, and the links work off your home network
too.

On a Linux VM the proxy wants ports 80 and 443. If it can't have them, `crew config set proxy_port
8080` and `crew config set proxy_https_port 8443` move it.

## An SSH tunnel

Over SSH, bare `crew` prints the proxy link when the proxy reaches the page. When it doesn't, it
prints the tunnel to run instead:

```
crew is running on this machine, port 51234. From your computer:
  ssh -L 51234:localhost:51234 store-vm
then open http://localhost:51234/login?token=…
```

Run the `ssh -L` line on the computer you're sitting at, leave it open, and open the link it gives.
The link carries the sign-in token, so that browser is signed in from then on. The name in the
line is `ssh_host` from `crew config set ssh_host store-vm` (**SSH host** in Settings); without one
it says `<this machine>` and you put your own alias there.

## On a phone

The page fits a phone. Voice OS keeps the tabs in the top bar, scrolling sideways, and the
session's stream takes the screen with the spoken line and the input under it.

![Voice OS on a phone: store/main's stream adding a search box to the catalog, with a diff, its spoken line and the input](../images/voice-os/phone.png)

Set up works too: the toolbar, the problems strip and the forms stack, and tables scroll sideways.

![Set up's board on a phone: Setup with Claude stacked under the tabs and the projects table scrolling sideways](../images/setup/board-phone.png)

To sign the phone in, run `crew server status` on the machine and open the proxy link on the
phone, once, after trusting the certificate. Push to talk is the most reliable listening mode on a
phone, because phones pause the microphone when the tab goes to the background or the screen locks.
That's the main reason I use Discord when I'm out.

## Voice OS in Discord

With Discord set up, a bot of your own joins one voice channel of one Discord server while Voice OS
runs. You join that channel from the Discord app on your phone and talk, and Voice OS answers in
the channel. It only takes your voice: anyone else in the channel is ignored. It needs no
certificate and no open tab, and it keeps going with the screen off.

### Make the server and the bot

1. Make a Discord server of your own, private, with a voice channel. A channel named **Voice OS**
   is picked first; otherwise crew takes the only voice channel, or asks.
2. Open the [Discord Developer Portal](https://discord.com/developers/applications), create an
   application, open **Bot**, and press **Reset Token** to get the bot's token. Keep it for the next
   step. The bot needs no privileged intents, so you can leave those switches off.
3. Invite the bot to your server: **OAuth2** → **URL Generator**, tick the `bot` scope, and the
   permissions **View Channel**, **Connect** and **Speak**. Add **Send Messages** and **Attach
   Files** if you'll post to a text channel (below). Open the generated URL and pick your server.

### Hand crew the token

```bash
pbpaste | crew server discord setup
```

Or run `crew server discord setup` and paste the token when it asks; it's hidden at a terminal and
never taken as an argument. crew checks it with Discord first, and a rejected token saves nothing.
Then it decides, one line each, which server (the only one the bot is in), whose voice to take (the
server's owner, which is you), and which channel, and checks the bot may View Channel, Connect and
Speak there. The token goes to `~/.config/crew-voiceos/discord.key`, readable by you only, and the
rest to `~/.crew/voiceos/discord.json`, which the running Voice OS watches, so no restart.

When it can't decide, it lists the options and you rerun with the one you mean. The saved token is
reused, so there's nothing to paste the second time:

```bash
crew server discord setup --guild=<id> --channel="Voice OS"
crew server discord setup --user=<your id>      # when the server's owner isn't you
```

Without a token and with nothing saved, the command prints these same steps and stops.

### Join the channel

Open Discord, join the voice channel, and talk. Voice OS's Settings has a **Discord** section that
shows whether the bot is connected and whether you're in the channel, with **Turn off** to leave
Discord and remove the token.

![Voice OS Settings, Discord section: connected to Voice OS with you in the channel, Turn off, and Messages going to #general](../images/tutorials/discord.png)

While you're in the channel, Discord is the microphone. Only two listening modes mean anything
there: on demand, where only what follows "Voice OS" is taken, and hands-free, where every turn is
acted on. Pick one from the menu by the mic on the page, or say it. Any open tab still shows the
conversation and takes typing.

`crew server discord status` says the same from a terminal, and `crew server discord off` is
**Turn off**. Voice off on the page takes the bot out of its channel too, until you turn voice on
again.

### Sending things there

Sessions can post to Discord when you ask them to ("send that screenshot to Discord", "post the
summary in Discord"). They run `crew server discord send`, which you can run yourself:

```bash
crew server discord send --text="The search fix is in" --file=screenshot.png
git log -5 --oneline | crew server discord send
```

It works from the main and from any remote: a remote hands the message to the main, which posts it
with the bot. Up to 10 files of 10 MB each, and text over 2000 characters goes as a `message.md`
attachment. Everything is checked before anything is sent, so a message posts whole or not at all,
and mentions in it never ping anyone.

Messages go to the voice channel's own chat. To use a text channel instead, pick it under
**Messages** in Settings' Discord section, or:

```bash
crew server discord channels                    # where a message can go
crew server discord setup --text-channel=builds
```

`--text-channel=voice` puts it back on the voice channel's chat.

That's the whole tour. From here, [Voice OS commands](../guides/voice-os-commands.md) lists
everything you can say, and [every command](../commands.md) has the CLI.
