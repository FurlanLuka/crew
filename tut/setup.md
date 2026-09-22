# Crew VM Setup Guide

Complete setup for running crew on a GCP VM: dev servers, Claude Code (or any agent with a shell), and remote editor access.

---

## 1. SSH Access

On your **local machine**, generate a key and register it with your VM:

```bash
ssh-keygen -t ed25519 -C "jsmith" -f ~/.ssh/store_dev_vm

echo "jsmith:$(cat ~/.ssh/store_dev_vm.pub)" > /tmp/ssh-keys.txt
gcloud compute instances add-metadata jsmith-dev-vm \
  --metadata-from-file=ssh-keys=/tmp/ssh-keys.txt \
  --project=store-2-dev-vms --zone=us-west1-b
rm /tmp/ssh-keys.txt
```

> Replace `jsmith` with your username, `jsmith-dev-vm` with your VM name, and update the project/zone to match your GCP setup.

Add to `~/.ssh/config`:

```
Host store-vm
  HostName jsmith-dev-vm
  User jsmith
  IdentityFile ~/.ssh/store_dev_vm
  ProxyCommand gcloud compute start-iap-tunnel %h %p --listen-on-stdin --project=store-2-dev-vms --zone=us-west1-b
```

Verify the connection:

```bash
ssh store-vm
```

---

## 2. Install Crew

On the **VM**:

```bash
curl -fsSL https://raw.githubusercontent.com/FurlanLuka/crew/main/install.sh | sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

Authenticate GitHub and log into Claude:

```bash
gh auth login
claude login
```

---

## 3. A checkout you already have

crew clones each project itself when you give it a URL. One repo in this tutorial is adopted
from a checkout that is already on disk, to show both forms:

```bash
gh repo clone your-org/store-app ~/projects/store-app
```

> Replace with your actual org and project names. crew installs each worktree's dependencies
> itself (mise, then the lockfile's package manager or the project's setup command), so no
> `npm install` here.

---

## 4. Set Up Crew

Everything is a command; `crew project` / `crew workspace` are the same things as TUIs.

### Register projects and their dev servers

```bash
crew add project store-api git@github.com:example/store-api.git   # cloned into ~/.crew/projects/store-api
crew add project store-app --path=~/projects/store-app            # or adopt a checkout already on the VM
crew dev add store-api --name=store-api --port=3000 --cmd="npm run dev"
crew dev add store-app --name=store-app --port=3001 --cmd="npm run dev"
crew check project store-api --wait                               # proves a fresh checkout installs and runs
```

A project is its git remote; a bare path is refused. In the TUI, `crew project` → `a` walks
the same steps one card at a time and explains each.

The `--port` is a reference; crew allocates a real port per worktree and runs the command
with `PORT=<n>` set — the dev command must bind `$PORT`.

### Bindings

Tell crew which env vars point at siblings, so every worktree gets the right URLs:

```bash
crew add binding store-app --scan          # proposes from store-app's .env
crew add binding store-app --scan --apply  # adds the unambiguous ones
```

### Create a workspace

```bash
crew add workspace store-front store-api store-app
```

That records the members and returns at once: one runner per project checks it out,
installs it and smoke-starts its servers in the background. `crew setup status
store-front/main --wait` watches them; `crew ls worktrees` lists what you have, and a
recorded failure shows in the row.

### Configure settings

```bash
crew config set ssh_host store-vm            # used by crew code
crew config set domain jsmith-dev.ngrok.app  # after step 5
crew config show
```

`server_ip` is auto-detected; override it with `crew config set server_ip <ip>` if the VM has
several interfaces.

---

## 5. Public Access

With `crew dev start <ref> --proxy`, dev servers are reachable at
`http://<server>--<workspace>--<worktree>.<vm-ip>.nip.io` without extra setup. Services that
use Firebase Auth block `.nip.io` origins (not in the authorized domains list), so use a
stable domain.

### ngrok (recommended)

Reserve a wildcard domain on [dashboard.ngrok.com](https://dashboard.ngrok.com) (e.g.
`*.jsmith-dev.ngrok.app`), then run in a detached tmux session:

```bash
tmux new -s ngrok
ngrok http 80 --url=jsmith-dev.ngrok.app
# Ctrl+B D to detach
```

> Replace `jsmith-dev.ngrok.app` with your reserved domain.

Then `crew config set domain jsmith-dev.ngrok.app`. The proxy picks the domain up on the next
`crew dev start … --proxy`.

### Firebase Auth

Add your ngrok domain to Firebase's authorized domains so auth flows work:

1. Open [Firebase Console](https://console.firebase.google.com) → your project → Authentication → Settings
2. Under **Authorized domains**, add `jsmith-dev.ngrok.app`

---

## 6. Using Crew

```bash
crew dev start store-front/main --proxy      # servers on stable ports, LAN hostnames
sleep 6; crew dev check store-front/main     # which server died or never listened
crew dev logs store-front/main store-api --lines=50
crew dev stop store-front/main
```

`crew dev start` prints the URLs and any `!` lines — an env value pointing at the wrong
port is caught there, before it fails at runtime.

### Launch Claude

```bash
crew claude store-front/main     # Claude Code in this terminal, in the worktree
crew edit store-front/main       # local Cursor / VS Code with the prompt and Claude wired
crew launch store-front/main     # the worktree page (TUI): status, launch, logs
```

Claude opens with the orientation prompt — the projects, their paths, and a `## crew` section that
tells it to drive the servers through crew.

### Open in Cursor / VS Code from your laptop

```bash
crew code store-front/main
```

Prints clickable links that open the worktree via Remote-SSH. You can also connect manually:
`Remote-SSH: Connect to Host` → `store-vm`.

### A second working copy

```bash
crew add worktree store-front/wrk2 --pull    # own branches, own ports, own .env
crew claude store-front/wrk2
```

### When something fails

`crew ls worktrees` shows what was recorded (`install failed: …`, `server died: …`, `server
not listening: …`). `crew fix <ref>` opens Claude with the evidence; `crew fix <ref> --print`
prints it; `crew verify <ref>` finishes what is missing and re-checks.

---

## Optional: the Claude Code plugin

On your laptop, in Claude Code:

```
/plugin marketplace add FurlanLuka/crew
/plugin install crew@crew
```

Claude can then drive crew over SSH for you — see the README's plugin section.
