# Pear server — Pear in a browser, and on an iPad

Pear has native apps for Windows, Linux and Android. For everything else — an iPad, a
Chromebook, a borrowed laptop — there is `pear-server`: a small headless process that
runs Pear's engine on a machine you control and serves the interface as a web app you
can add to your home screen.

```
iPad / any browser  ──https──▶  pear-server  ──ssh──▶  your hosts
   (UI only)                    (SSH sessions, secrets,
                                 terminals, Claude CLI)
```

A browser cannot open TCP sockets, so something has to speak SSH on its behalf. That
something holds your host list and credentials — which is why it is a server *you* run,
not a service.

What you get that the native apps cannot give you: **sessions live on the server.**
Close the tab, let the iPad sleep, switch devices — your shells, their scrollback and a
running Claude turn are still there when you come back.

## Quick start

On any Debian or Ubuntu machine (a VM, an LXC container, a Raspberry Pi), as root:

```sh
curl -fsSL https://raw.githubusercontent.com/dmytro-kryvyi/pear-ssh/main/server/install.sh | bash
```

It installs Node.js if missing, creates a `pear` system user, unpacks the prebuilt server
(a 5 MB download — nothing is compiled on your machine), sets it up as a systemd service
and prints a generated password. That gives you Pear on `http://127.0.0.1:7327`.

The installer sets up Pear and nothing else. **HTTPS, and who may connect, are your
infrastructure's job** — a reverse proxy, a VPN, Tailscale — and the next section has a
recipe for each. With a reverse proxy on another machine, the usual case in a homelab:

```sh
curl -fsSL …/server/install.sh | bash -s -- \
  --public-url https://pear.example.com --host 0.0.0.0 --trusted-proxy 192.168.1.2
```

- `--public-url` is the address people type; `--host 0.0.0.0` lets the proxy reach Pear
  over the LAN; `--trusted-proxy` is the proxy's own address, so login throttling counts
  real clients instead of locking out the proxy.
- Settings live in `/etc/pear-server.env`. `bash install.sh --help` lists the options;
  `--uninstall` removes the program and keeps your data.
- **Updating** is the same command again — see [Updates](#updates).

### Proxmox, from nothing

On the Proxmox **host**, as root — creates a small unprivileged Debian container
(2 cores, 1 GB RAM, 4 GB disk) and runs the installer inside, listening on the
container's LAN address:

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/dmytro-kryvyi/pear-ssh/main/server/proxmox-lxc.sh)"
```

Options such as `--storage local-zfs` or `--bridge vmbr1` go before a `--`; anything
after it is passed to the installer (`-- --public-url https://… --trusted-proxy …`).
It ends by printing the address to point your reverse proxy at; give the container a
DHCP reservation or a static IP so that address stays put. `--tun` passes `/dev/net/tun`
into the container, for running a VPN client inside it.

### From source

```sh
git clone https://github.com/dmytro-kryvyi/pear-ssh.git && cd pear-ssh
npm ci
npm run server          # builds both UIs + the server, then starts it
```

Needs Node 22.22.3 or newer (Angular's build insists) and a couple of GB of RAM.
`npm run pack:server` turns a checkout into the same `release/pear-server.tar.gz` the
installer takes with `--bundle <file>`. `pear-server --help` lists every option; each
also has a `PEAR_*` environment variable or a key in `~/.config/pear-server/config.json`.

### Docker

```sh
docker build -f server/Dockerfile -t pear-server .
docker run -d --name pear -p 127.0.0.1:7327:7327 -v pear-data:/data pear-server
docker logs pear        # the generated password is printed here, once
```

Everything stateful (hosts, encrypted secrets, known host keys, logins, the config file)
is under `/data`. Note that in a container the Claude integration needs the `claude` CLI
installed and logged in *inside* that container; running from source as your own user
(see `server/pear-server.service`) is the easier path if you use it.

## Putting it on the network

Two rules shape everything here:

1. **An iPad needs HTTPS.** Without a secure context Safari gives a web app no service
   worker and no clipboard. Plain `http://192.168.x.x` "works" but is a degraded
   experience, and sends your password in the clear.
2. **Whoever gets in has your SSH hosts and keys.** Ideally the network decides who gets
   in, and the password is the second line, not the first.

### Caddy (or nginx, Traefik) and your own DNS

The homelab classic: a name in your local DNS (Pi-hole, AdGuard, your router) pointing at
the proxy, and the proxy forwarding to Pear.

```caddyfile
pear.example.com {
    reverse_proxy 192.168.1.30:7327      # 127.0.0.1:7327 if Caddy runs on the Pear machine
}
```

```sh
# on the Pear machine (or as installer flags)
pear-server --public-url https://pear.example.com --host 0.0.0.0 --trusted-proxy 192.168.1.2
```

The proxy must forward the `Host` header unchanged and support WebSocket upgrades. Caddy
does both by default; for nginx add the usual `Upgrade`/`Connection` headers and
`proxy_set_header Host $host`. Pear then answers only to that name — a request for the
bare IP gets a 421 — and marks its login cookie `Secure`.

**The certificate is the part that decides whether the iPad works.** Safari gives a
home-screen app a service worker and clipboard access only on HTTPS it *trusts*:

- **A real domain, even for a private address — recommended.** Own `example.com`, let
  Caddy get a Let's Encrypt certificate through the
  [DNS challenge](https://caddyserver.com/docs/automatic-https#dns-challenge) (no open
  ports needed), and have your local DNS answer `pear.example.com` with the proxy's LAN
  address. Every device trusts it with no setup. A wildcard (`*.home.example.com`)
  covers the rest of your homelab too.
- **Caddy's internal CA** (`tls internal`, or any name that is not publicly resolvable,
  like `pear.lan`): works, but each device must trust Caddy's root certificate first. On
  iOS that is two steps people miss — install the profile, *then* switch it on under
  Settings → General → About → **Certificate Trust Settings**. Until then the app
  installs but behaves as if it were on plain HTTP.

A LAN-only name is not an access boundary by itself: anyone on the network can reach it,
so keep `--auth password` (the default), or put the proxy's own authentication in front
and use `--auth proxy`.

### Tailscale

```sh
pear-server --public-url https://mybox.my-tailnet.ts.net
tailscale serve --bg 7327
```

Pear stays on loopback; Tailscale terminates TLS with a real certificate and only your
tailnet can reach it. Use the MagicDNS name, **not** the raw `100.x.y.z` address — the
certificate (and therefore the secure context) belongs to the name. In an unprivileged
LXC container Tailscale needs `/dev/net/tun` (the Proxmox script's `--tun`).

Since Tailscale already knows who is connecting, you can drop the password entirely:

```sh
pear-server --auth proxy --proxy-user-header Tailscale-User-Login \
            --allow-user you@example.com \
            --public-url https://mybox.my-tailnet.ts.net
```

or, if every device on your tailnet is yours: `--auth none`.

### Cloudflare Access, oauth2-proxy, Authelia …

Anything that authenticates users and passes their identity in a header works with
`--auth proxy --proxy-user-header <header>`. Make sure the server is reachable **only**
through that proxy: the header is trusted from `--trusted-proxy` peers and ignored from
everyone else, so the default (loopback) is right when the proxy or tunnel daemon runs
on the same box.

## Access control

| `--auth` | Who gets in | Use when |
|---|---|---|
| `password` (default) | Anyone with the password. scrypt-hashed, failed logins throttled per address and globally, 30-day sliding session in an `HttpOnly; SameSite=Strict` cookie (also `Secure`, `__Host-` over HTTPS). | Behind a plain reverse proxy, or on a LAN. |
| `proxy` | Whoever your reverse proxy says, optionally narrowed with `--allow-user`. | The proxy already does SSO / device identity. |
| `none` | Anyone who can reach the port. | The network itself is the gate: Tailscale, a VPN, a private container network. |

`--auth none` refuses to start on a non-loopback address unless you add
`--allow-unauthenticated-network` — an acknowledgement, not a hurdle: a published Docker
port on a VPN-only interface is a legitimate setup; a server on `0.0.0.0` by accident is
not.

Set or change the password with `PEAR_PASSWORD=… pear-server`, or let the server mint a
new one: `pear-server --reset-password`.

Independent of the mode, the server always:

- checks the `Origin` of every WebSocket handshake and every state-changing request
  (browsers attach cookies to cross-site WebSocket handshakes, and no CORS preflight
  stands in the way — this is what stops another website from driving your Pear);
- answers only to expected `Host` names — loopback, `--public-url`, `--allow-host` —
  whenever there is no password to fall back on (the defence against DNS rebinding);
- serves a strict Content-Security-Policy, and sends files downloaded from your hosts as
  sandboxed attachments so they can never execute in Pear's origin.

## What lives on the server, and how well protected

| | Where | Protection |
|---|---|---|
| Hosts, workspaces, history | `<data-dir>/*.json` | File permissions. |
| Host passwords, passphrases, pasted keys | inside `hosts.json` | AES-256-GCM under `<data-dir>/secret.key` (0600), or under `PEAR_SECRET_KEY` (32 bytes, base64) so the key can live in a systemd credential or Docker secret. |
| Known SSH host keys | `<data-dir>/known_hosts.json` | — |
| Logins | `<data-dir>/sessions.json` | Only token hashes are stored. |

Be clear-eyed about the encryption: it makes a leaked backup or a copied `hosts.json`
useless. It does **not** protect against someone who can run code as the server's user —
that person can simply ask the running server. If that trade is not acceptable, start
with `--no-store-secrets`: nothing secret is written to disk and Pear prompts when it
connects (key files in the server user's `~/.ssh`, and its SSH agent, still work).

**An authenticated client is equivalent to a shell as the server's user.** That is
inherent — Pear's job is to run commands on machines — and it is why access control
above matters more than anything on this page. Two features make it literal, and both
can be weighed separately:

- *The server as a host* ("Add this computer") is **off** unless you start with
  `--enable-local-host`.
- *Claude Code* runs the `claude` CLI on the server as the server's user, on that user's
  Claude login. It is on when the CLI is installed.

**SSH host keys are verified** (trust on first use). The first connection to a host
shows its key fingerprint and asks; a key that later *changes* is refused with a louder
warning showing both fingerprints. The desktop app has historically accepted any key;
a network service that forwards stored passwords should not, so here it is on by
default (`--no-verify-host-keys` turns it off).

SSH private key *files* are read from the server's filesystem — a path in the host editor
means a path on the server. From the touch UI you can paste a key instead; it is stored
encrypted like a password.

## Sessions that outlive the browser

Terminals belong to the server, not to the tab that opened them.

- When the connection drops — iPadOS freezes a web app seconds after you switch away —
  the shell keeps running. On return the app reconnects and receives exactly the output
  it missed; you see a brief "Reconnecting…" strip at most.
- If the page itself was discarded (or you reload), opening the host picks the running
  shell back up, scrollback included, instead of starting a second one.
- Two devices can watch the same terminal; either can type. The PTY takes the size of
  whichever device you touched last.
- Shells with nobody attached are closed after `--session-grace` (default `12h`; `0`
  restores close-on-disconnect, `inf` keeps them until they exit). `--term-buffer`
  (default `2m` characters per terminal) is how much scrollback can be replayed.
- A Claude turn keeps running while you are away; the transcript, and any permission
  card still waiting for an answer, are there when you come back. A card answered on one
  device resolves on the others.

What does **not** survive is a restart of the server itself: its terminals end with the
process. If you need shells that survive even that, run `tmux` in them.

## Updates

**Finding out.** Once a day the server asks GitHub what the latest release is. When
there is a newer one, every connected device shows it — a dot on the settings gear and a
line in Settings → General → *Pear server* on the desktop workspace, a note under the
host list on the touch interface — with a link to the release notes. It is a single
anonymous request, it never installs anything, and `--no-update-check` (or
`PEAR_UPDATE_CHECK=0`) turns it off.

**Updating by hand** is the install command again. Hosts, keys, known host keys, logins
and `/etc/pear-server.env` are kept. The server restarts, so **terminals it is holding
end** — pick your moment.

**Updating automatically** is opt-in:

```sh
curl -fsSL …/server/install.sh | bash -s -- --auto-update      # --no-auto-update turns it off
```

This adds a systemd timer that, once a day, runs the installed copy of the installer
with `--if-newer --when-idle`: it does nothing unless a newer release exists, and nothing
while anything is running on the server — an open terminal (including one you walked
away from and that is waiting out its `--session-grace`), or a Claude turn. Busy today
means it tries again tomorrow; it never forces a restart. What it did, and why not:
`journalctl -u pear-server-update`.

The server never updates *itself*: it runs as an unprivileged user that cannot write its
own program files, and that stays true. The timer is a separate root job that runs the
same installer you would.

With Docker, updating is pulling/building the new image and recreating the container
(`/data` carries everything over); from source, `git pull && npm ci && npm run build:web`
and a restart. The in-app notice works in both.

## Installing on an iPad or iPhone

1. Open the server's HTTPS address in **Safari** and sign in.
2. Share → **Add to Home Screen**.
3. Launch Pear from the home screen and **sign in once more** — a home-screen app keeps
   its own storage, separate from Safari's.

Touch devices get the touch interface (the same one as the Android app; an iPad gets its
tablet layout), everything else the desktop workspace. Either can be switched — *Desktop
interface* under the host list, or Settings → General → *Pear server* — and the choice is
remembered per device. With a hardware keyboard, ⌘C / ⌘V work in terminals alongside
Ctrl+Shift+C / V.

Files: **Upload** opens the Files picker; downloads arrive in Files → Downloads. Several
files or a folder come as one `.tar`, which Files opens natively.

On Android, Chrome offers *Install app* for the same result — though the native Android
app needs no server at all.

## Running it as a service

The installer does this for you (a system unit running as the `pear` user; settings in
`/etc/pear-server.env`, logs with `journalctl -u pear-server`). For a from-source
checkout under your own account, `server/pear-server.service` is a ready-made systemd
**user** unit — remember `loginctl enable-linger`. Either way, shells on "this computer"
and the Claude CLI run as the service's user, and restarting the service ends the
terminals it holds.

## Limits, honestly

- One user. Everyone who can sign in shares the same hosts, sessions and Claude
  conversation; there are no per-user accounts.
- The desktop workspace is built for a mouse. It works on an iPad with a trackpad or
  Magic Keyboard; with fingers alone, use the touch interface.
- A host list edited on one device shows up on another after that one reloads.
- Claude's `read_terminal` / `reveal_in_app` tools need a connected screen; while every
  device is asleep they fail with a message saying so, and Claude carries on without.
