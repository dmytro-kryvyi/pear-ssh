# Changelog

All notable changes to Pear are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions come from git tags
(`vX.Y.Z`) — see [CONTRIBUTING.md](CONTRIBUTING.md#releases-maintainers).

## [Unreleased]

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
