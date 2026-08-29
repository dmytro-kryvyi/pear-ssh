# Changelog

All notable changes to Pear are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions come from git tags
(`vX.Y.Z`) — see [CONTRIBUTING.md](CONTRIBUTING.md#releases-maintainers).

## [Unreleased]

### Added
- Public landing page (`site/`) — static, SEO-optimized, deployed to Cloudflare Pages.
- Repo community files: LICENSE (MIT), README, CONTRIBUTING, SECURITY, Code of Conduct.

### Changed
- Brand standardized on one master pear (`build/icon.svg`): app icons, favicons,
  Android launcher (was the stock Capacitor icon), landing marks and the in-app
  glyph all derive from it.

### Fixed
- Ctrl+Shift+V pasted twice into terminals: the custom clipboard handler never
  prevented the browser's native paste, so xterm's own paste listener fired too.
- The Claude chat transcript had no right-click menu; it now offers Copy and
  Copy message.
- With in-pane terminal placement, "Open terminal here" and orchestration
  streams (logs, service ps, prune) targeted the hidden bottom dock and
  rendered nowhere; they now open in workspace panes.
- Android CI workflow: `secrets` context in a step-level `if:` made the workflow
  file invalid; the keystore flag now flows through job-level `env`.

## [0.1.0] — first public cut

Everything so far, highlights:

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

[Unreleased]: https://github.com/dmytro-kryvyi/pear-ssh/compare/main
[0.1.0]: https://github.com/dmytro-kryvyi/pear-ssh/commits/main
