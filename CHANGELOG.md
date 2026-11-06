# Changelog

All notable changes to Pear are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions come from git tags
(`vX.Y.Z`) — see [CONTRIBUTING.md](CONTRIBUTING.md#releases-maintainers).

## [Unreleased]

### Added
- **Pear server** (`server/`, [docs/SERVER.md](docs/SERVER.md)) — Pear as a self-hosted,
  installable web app, for devices with no native build (iPad, iPhone, any browser).
  Serves the desktop workspace and the touch UI under one origin and routes each
  device to the right one. Access control in the code-server mould: `--auth password`
  (default), `proxy` (identity header from Tailscale Serve, Cloudflare Access, …) or
  `none` for network-gated setups; loopback by default, Origin/Host checks always.
- **Sessions that outlive the client** — on the server, terminals keep running when the
  browser disconnects; output is sequence-numbered so a returning client receives
  exactly what it missed, and a reloaded page re-adopts its shells with scrollback.
  Claude conversations resync the same way, without interrupting a running turn.
- **SSH host key verification** (trust on first use) in core; on by default in the
  server. The desktop app's behaviour is unchanged for now.
- Browser file transfer: uploads from a file picker or drag-and-drop, downloads through
  the browser (folders and multi-selections as `.tar`).
- One-command server install (`server/install.sh`: Node, service user, systemd unit;
  `--host`/`--trusted-proxy` for a reverse proxy on another machine; re-run to update) from a prebuilt 5 MB bundle that releases
  now carry (`npm run pack:server`), plus `server/proxmox-lxc.sh` to create the
  container on a Proxmox host.
- Server updates: a daily release check shows "update available" in both UIs
  (`--no-update-check` disables it), and the installer's opt-in `--auto-update` timer
  updates only while no terminals or Claude turns are running.
- Dockerfile and a systemd user unit for the server; PWA icons from the brand master.

### Changed
- The logic behind `PearApi` moved out of Electron's main process into core's
  `PearService`, shared by the desktop app and the server. No behaviour change on
  desktop; the IPC channel names are now a typed table (`core/src/rpc/channels.ts`).
- Desktop UI bundles Inter and JetBrains Mono instead of loading them from Google
  Fonts — the app no longer needs the network to render correctly.
- Pane dividers and dock resizers use pointer events (they now work by touch).

### Fixed
- Multi-byte characters split across SSH packets no longer turn into `�` in terminals.
- Simultaneous first calls to a host (files + orchestration + vitals) dialed one SSH
  connection each and leaked all but the last; they now share a single dial.
- A connection still dialing during shutdown was never closed.
- The start-up sweep of transfer staging directories deleted the live staging of any
  other Pear running on the same machine; it now removes only stale ones.
- Mobile build broke on the `hosts.sshConfigEntries` API member added for the desktop
  SSH-config import.
- **Pear server parity for this batch** — copy works over plain http (no secure
  context) via a fallback; `uuid()` no longer needs `crypto.randomUUID`, so the host
  editor opens on LAN origins; the browser keeps its native menu on text fields;
  terminals opened for logs/consoles are tagged `orch` so a reloaded page never
  adopts one as its shell; the mobile UI's model list comes from the server's CLI.
- **Claude dock: stays signed in** — the chat CLI process is retired after a
  minute idle and resumed on the next message, so it no longer races your
  terminal `claude` for the rotating OAuth refresh token (the cause of the
  "logged out" loop). Auth failures now surface as a Sign in card, the dock
  shows a "Not signed in" state (from `claude auth status`), and Sign in runs
  the CLI's own `claude auth login` inside the pane; `/login` works in chat.
- **Right-click menus everywhere** — swarm tasks drawer (task rows: copy full
  id/node/image/error, logs and inspect commands; log pane: copy line, selection,
  visible or all lines, select all), every orchestration card in the sidebar and
  the full view (the row's actions plus copy name/id/image/ports/address/VMID and
  the exact `docker`/`pct`/`qm` command), host rows (open, new shell, edit, copy
  address or a ready `ssh -J …` line, close shells, remove), workspace and dock
  tabs (close others/right, split, move, copy path or `user@host:path`, open
  terminal here), file-list rows and breadcrumbs (copy name/path/host:path), the
  editor tab, transfers, vitals, SSH import rows and toasts. Every text field now
  has Cut/Copy/Paste/Select all. Copies confirm with a toast; menus and toasts
  render above drawers and modals, and Escape closes only the menu.
- **Claude dock: copy button on code blocks** — fenced blocks in Claude's
  answers get a header with the language tag and a Copy control.
- **Claude dock: right-click everywhere** — composer (Cut/Copy/Paste/Select all),
  transcript (copy selection, code block, message as Markdown, tool output,
  command, error), header and context bar.
- **Claude dock: AskUserQuestion done right** — every question in a prompt is
  answerable, multi-select and the "Other…" free-text choice are supported,
  headers are shown, one Submit sends all answers, Dismiss replies cleanly,
  and the duplicate tool card is gone. Dismissed and replayed cards settle
  instead of staying live.
- **Claude dock: model list from your CLI** — the picker asks the installed
  `claude` for its own model list (`list_models`), so new models show up with
  the CLI's "update to x.y.z" hint instead of a stale built-in array, in a
  proper picker (name, blurb, resolved model, current choice ticked, same-name
  entries disambiguated by version); the context meter uses the resolved model.
- **ProxyJump everywhere** — `~/.ssh/config` entries with `ProxyJump` now work
  in quick connect and in the import picker: each hop becomes (or is matched
  to) a host of its own and the target is saved with `via` pointing at the
  last hop; multi-hop chains, `[user@]host[:port]` literals and IPv6 brackets
  are understood. The host editor gained a "Connect via" picker so any host
  can be routed through another (self and dependants excluded, so chains
  can't loop).

## [0.1.0] — 2026-08-29 — first public cut

Everything so far, highlights:

- **Open-source readiness** — LICENSE (MIT), README, CONTRIBUTING, SECURITY,
  Code of Conduct; public landing page (`site/`); one master brand pear
  (`build/icon.svg`) driving every app icon, favicon and the Android launcher.
- **Fixes** — Ctrl+Shift+V no longer pastes twice; the Claude chat gained a
  right-click Copy menu; in-pane terminal placement now receives "open
  terminal here" and orchestration streams (they previously targeted the
  hidden bottom dock).
- **Workspaces & hosts** — colour-coded workspaces, quick connect, connection
  profiles with sequential failover, bastion (`via`) chains over real `forwardOut`
  channels, the local PC as a first-class host.
- **File workspace** — split panes, tabs, cross-host streaming transfers with
  optional SHA-256, remote editor.
- **Terminals** — shared dock / per-host / in-pane placement, PTY follows browsing.
- **Monitoring** — host vitals (CPU/mem/load/net/mounts) on a single polling loop,
  per-container stats.
- **Orchestration** — Docker / Swarm / Proxmox detection with adaptive dashboards,
  service task inspector with log streaming, sub-host "jump in" (recursive,
  ephemeral or pinned).
- **Claude Code integration** — local CLI on the user's subscription, loopback-only
  MCP server, per-run tokens.
- **Android app (WIP)** — Capacitor shell reusing `@pear/core` over a Kotlin
  SSH engine; not shipping yet.

[Unreleased]: https://github.com/dmytro-kryvyi/pear-ssh/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dmytro-kryvyi/pear-ssh/releases/tag/v0.1.0
