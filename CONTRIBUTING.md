# Contributing to Pear

Thanks for helping! Pear is a small project with a clear architecture — the fastest way
to be effective is to respect the boundaries described in the
[README's architecture section](README.md#architecture).

## Dev setup

Requirements: **Node 22+**, npm 10+. For Android work: JDK 21 + Android SDK 35.
For the ssh-engine JVM tests: a local `sshd` binary (`openssh-server` package).

```sh
npm ci
npm start        # full build + launch desktop app
npm run dev      # watch mode
```

## Workspace layout

| Workspace | What lives there | Tests |
|---|---|---|
| `core/` | SSH/SFTP/exec engine, host inventory, monitors, orchestration, MCP server | `npm test -w core` (`node --test` over `dist/`; build first) |
| `desktop/` | Electron main, IPC bridge, safeStorage secrets | — |
| `ui/` | Angular renderer | `npm test -w ui` |
| `mobile/` | Capacitor Android app | `npm test -w mobile` (vitest) |
| `mobile/android/ssh-engine/` | Kotlin SSH engine (sshj) | `./gradlew test` (spawns a real scratch sshd) |
| `site/` | Landing page (standalone, not a workspace) | — |

End-to-end verification without a GUI harness follows the throwaway-sshd pattern: spin a
scratch `sshd` on a high port and drive real sessions through `@pear/core`'s public
exports (see `core`'s tests for examples).

## Ground rules

- **Secrets never cross the bridge.** The renderer sees a "has a secret" flag, never
  plaintext or ciphertext. Anything that would move secret material into `ui/` will be
  rejected.
- **`core/` stays UI-agnostic.** No Electron, DOM, or Angular imports there.
- Match the surrounding code style; `prettier` config is at the repo root.
- Comments explain *constraints*, not what the next line does.
- Brand assets: `build/icon.svg` is the single master. After changing it, run
  `node scripts/gen-brand-icons.mjs` (regenerates desktop/ui/Android rasters)
  and `npm run build` in `site/` (regenerates web favicons).

## Pull requests

- Keep PRs focused — one concern per PR.
- Run the affected workspace's tests before opening.
- Describe *why*, not just *what*, in the PR body.
- New features that touch SSH auth, secrets, or the MCP tool surface get extra scrutiny.

## Releases (maintainers)

Versions are tag-driven: push `v1.2.3` and CI builds/publishes desktop artifacts and the
Android APK with that version — no committed bumps. Update `CHANGELOG.md` in the same PR
that prepares a release.
