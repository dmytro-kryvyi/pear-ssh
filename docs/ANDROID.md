# Pear for Android — Roadmap

Pear's mobile port: a standalone Android app (phone + tablet) that speaks SSH
natively, reusing the desktop's core logic and the finished mobile designs.
This document is the source of truth for scope and sequencing; each milestone
is a separately implementable, separately verifiable chunk.

Designs live in the claude.ai/design project **Pear** — `Pear Mobile.html`
(phone, 393×852) and `Pear Tablet.html` (1194×834), sharing `src-mobile/*`
screen components. The device frame, dynamic island, and iOS status bar in
those mockups are presentation chrome, not app UI.

## Architecture

```
┌────────────────────────────── Android app ──────────────────────────────┐
│  WebView (Angular 22, zoneless, signals)                                │
│                                                                         │
│   screens (phone tabs / tablet rail+split) ── shared with designs       │
│        │                                                                │
│   PearBackend (DI token, mirrors PearApi from core/src/api.ts)          │
│     ├─ MockBackend        (M1 — browser dev & demos)                    │
│     ├─ NativeSshBackend   (M3 — the real thing)                         │
│     │    └─ SessionManager (@pear/core ssh/sessions.ts, reused)         │
│     │         └─ CapacitorSshTransport → implements ssh/transport.ts    │
│     └─ RemoteServerBackend (future — WebSocket to a headless Pear       │
│                             server; not part of this roadmap)           │
│                                  │                                      │
├──────────────────────── Capacitor bridge ───────────────────────────────┤
│  PearSsh Kotlin plugin (sshj)                                           │
│   connect/failover · TOFU host keys · exec · PTY shell · SFTP ·         │
│   via-ProxyJump · remote port-forward                                   │
│  Secrets: Android Keystore-wrapped AES over encrypted key/password blobs│
│  Host store: Capacitor Preferences behind core's storage interface      │
└─────────────────────────────────────────────────────────────────────────┘
```

Decisions already made (see git history / desktop parity):

- **Capacitor over alternatives.** xterm.js and the Angular orch UI are DOM
  components; any non-WebView framework means a rewrite or WebViews-in-native.
  Capacitor also keeps an iOS path open (same TS, plugin re-done on
  swift-nio-ssh).
- **sshj, not JSch.** JSch is unmaintained; sshj needs the real BouncyCastle
  registered on Android (the OS ships a stripped one) — known, solvable.
- **CodeMirror 6, not Monaco.** Touch-first, small, good soft-keyboard
  behavior. Editable from the first native milestone (`fs.read`/`fs.write`).
- **Claude via SSH.** The `claude` CLI cannot run on-device. A designated host
  that has it installed and subscription-authenticated runs it under
  `--output-format stream-json` over an exec channel; the phone parses the
  stream with core's `ChatStreamParser`. Token/API mode is a possible later
  fallback, not in this roadmap.
- **Proxy ladder** (each tier a superset): `via` ProxyJump (network reach,
  field already exists in `HostConfig`) → credential proxy via remote
  agent signing (proxy's keys sign auth, sessions stay native) → standalone
  Pear server (adds sync/push; future).
- **Background sessions**: start with reconnect-on-resume; a foreground
  service is an M6 option, not a prerequisite.

## What already exists and gets reused

The platform split in `core/` is machine-checked: `tsconfig.pure.json`
compiles everything outside `core/src/node/` with no Node types. Everything
below is WebView-safe **today**:

| Existing code | Role on Android |
|---|---|
| `core/src/types.ts`, `core/src/api.ts` | The domain model and the `PearApi` surface — `HostConfig`/`HostGroup` already carry every field the mobile editors show (endpoints, auth, tags, aliases, short, color, notes, env, startup; group color/icon/desc) |
| `core/src/ssh/transport.ts`, `ssh/sessions.ts` | `SshTransport`/`ShellChannel` contracts + transport-agnostic `SessionManager` — the Kotlin plugin sits *behind* these, so session logic is reused, not rewritten |
| `core/src/hosts/*` (store, identity, groups, ephemeral) | Host persistence (pluggable storage/cipher interfaces → Preferences + Keystore), `shortLabel`/`autoShort` |
| `core/src/orchestration/*` | All facet providers/parsers (docker, swarm, proxmox, tasks) — orch works as soon as `exec` works |
| `core/src/monitor/*` | Vitals/docker-df parsers for the KPI/gauge rows |
| `core/src/transfers/engine.ts` | `TransferEngine` is platform-neutral — M6 wires it to SFTP + SAF |
| `core/src/claude/events.ts`, `claude/parser.ts` | `ChatStreamParser`, `coalesceChatEvents`, event models — the whole chat protocol, transport-independent |
| `core/src/history/*` | Command history + shell-history import |
| ui stores (zoneless signals, all behind the `Pear` injectable): `hosts.ts`, `hosts/groups.ts`, `orch/store.ts` + `facet-meta.ts`, `claude/chat-store.ts`, `transfers/store.ts`, `monitor/store.ts`, `terminal/tabs.ts`/`term-registry.ts`/`history.ts`/`suggest.ts` | Headless state layer, reusable if extracted/shared; mobile provides its own templates |
| `ui/src/styles.scss` | Theme tokens — the mobile design uses the **same custom-property names** (`--bg-0..4`, `--fg-0..3`, `--accent`, `--term-bg`, `--ok/--warn/--err`, `--mono/--ui`) plus a new `--claude` |

Not reusable: the desktop shell (`ui/src/app/app.ts`), pane-grid/splitters
(mouse-driven), Monaco editor, all desktop templates, and everything under
`core/src/node/` (ssh2, PTYs, Claude chat runtime, MCP http server — Electron
main only).

## Design → implementation map

| Design file | What it is | Mobile component(s) | Reuses |
|---|---|---|---|
| `src-mobile/chrome.jsx` | Tab bar, header, sheets, dots/pills/buttons | app shell + shared atoms | `facet-meta` glyph mapping |
| `src-mobile/state.jsx` | Demo session state | `MockBackend` + existing stores | `hosts.ts`, `orch/store.ts` patterns |
| `src-mobile/hosts.jsx` | Hosts screen, workspace strip, host picker sheet, recents | hosts feature | `HostCatalog`, `HostGroups`, `shortLabel` |
| `src-mobile/files.jsx` | Breadcrumb + file list + viewer sheet | files feature | `fs.*` API, CM6 replaces the read-only viewer |
| `src-mobile/orch.jsx` | KPI row, gauges, Docker/Swarm/Proxmox cards | orch feature | facet providers, `monitor/*` parsers, `OrchStore` |
| `src-mobile/terminal.jsx` | Output view, quick keys, input bar | terminal feature (xterm.js) | `TermTabs`, `term-registry`, history/suggest |
| `src-mobile/claude.jsx` | Transcript blocks, context meter, sessions sheet | claude feature | `ClaudeChat` store, `ChatStreamParser`, event models |
| `src-mobile/editors.jsx` | Host/Workspace editors, form atoms, `wide` variant | editors feature (sheet on phone, modal on tablet) | `HostConfig`/`HostGroup` types, probe API, `hosts/forms.ts` logic |
| `src-mobile/app.jsx` | Phone shell: tabs + sheets | phone layout | — |
| `src-tablet/app.jsx` | Tablet shell: rail + view switch + terminal split | tablet layout (same screens) | — |

Phone vs tablet is one app with a responsive breakpoint — every screen
component is shared; only the shell differs (bottom tabs + sheets vs rail +
split + centered modals).

## Milestones

### M0 — Scaffold

**Status: done (Aug 2026).**

**Scope**
- New npm workspace `mobile/`: Angular 22 app (zoneless, standalone, same
  conventions as `ui/`), Capacitor config, Android project stub committed.
- Theme SCSS ported from the design head styles (token names shared with
  `ui/src/styles.scss`, plus `--claude`), Inter/JetBrains Mono bundled locally.
- `PearBackend` injection token typed as `PearApi`; app boots against a stub.
- Root build scripts extended (`mobile` build; core stays the shared dep).

**Out of scope:** any real screen, any Kotlin.

**Verify:** `ng serve` shows a themed empty shell in the browser;
`npx cap sync android` succeeds; repo build still green.

### M1 — Full UI on a mock backend

**Status: done (Aug 2026).** MockBackend in `mobile/src/app/mock/`; screens
in `hosts/ files/ orch/ terminal/ claude/ editors/ shell/`.

**Scope**
- All screens from the designs: Hosts (workspace strip, recents, search,
  rows), Files (breadcrumb, list, empty state), Orch (KPI row, gauges,
  Docker/Swarm/Proxmox cards + actions), Terminal (output, quick-key row,
  input bar), Claude (transcript block types, context meter, sessions sheet,
  auto-approve toggle), Host editor + Workspace editor (all sections,
  endpoint cards with probe UI, membership).
- Phone shell (tab bar, host-picker sheet, full-screen sheets) and tablet
  shell (rail with drag-to-workspace, view switch, 55/45 terminal split,
  `wide` editor modals) over the same components.
- `MockBackend` implementing `PearApi` in memory (seeded like the design's
  `state.jsx`/`data.jsx`) so every interaction works in a desktop browser.
- Share or lift the headless ui stores where practical rather than rewriting.

**Out of scope:** real SSH, real editor buffer (viewer can be plain text),
xterm (the mock terminal renders the history list like the design).

**Verify:** browser walkthrough phone-width and tablet-width against the two
design HTMLs; all design interactions (connect, switch host, orch actions,
editor save/delete, sheets) function on mock data.

### M2 — Kotlin plugin core (`PearSsh`)

**Status: done (Aug 2026).** Split into a pure-JVM `mobile/android/ssh-engine`
Gradle module (sshj engine — testable with a plain JDK: `./gradlew test`
spins a scratch sshd; 19 tests, engine-side PTY throughput ~28 MB/s) and the
thin Android layer in the app module (`PearSshPlugin.kt` with per-frame
event batching, `KeystoreCipher.kt`); TS contract in
`mobile/src/app/native/pear-ssh.ts`. One deliberate contract shift from this
doc's original sketch: endpoint failover stays in core's
`SessionManager.dialEndpoints` (reused in M3), so `connect` is
single-endpoint and TOFU is reject-with-fingerprint → retry-with-trust.
**Spike closed (Aug 2026, real device + host):** PTY over the batched
bridge does **1.86 MB/s** vs a 3.12 MB/s raw network/sshj ceiling on the
same WiFi — comfortably terminal-grade (xterm itself renders ~1 MB/s), so
the bridge design stands and no local-socket fallback is needed. Gotcha
that masked this: Capacitor debug builds log every bridge call/event, which
throttled the stream to 0.14 MB/s — `loggingBehavior: 'none'` in
capacitor.config.ts is load-bearing for terminal streams.

**Scope**
- sshj wiring with real BouncyCastle; connect/disconnect with ordered
  endpoint failover (same sequential contract as desktop `connection.ts`).
- Host-key TOFU: persisted known-hosts, `hostKeyPrompt` event → UI confirm.
- `exec` (stdout/stderr demux, exit code), PTY shell channels (open, write,
  resize, close, data/exit events), SFTP (list/stat/read/write/mkdir/remove/
  rename/copy).
- Event batching across the bridge (coalesce terminal data per frame — raw
  per-chunk plugin events will jank).
- Secrets: AES key in Android Keystore wrapping encrypted key/password blobs
  (Keystore can't export raw keys; sshj needs the bytes). Host list in
  Capacitor Preferences, both behind core's storage/cipher interfaces.
- **Week-one spike, before building the rest: PTY throughput/latency through
  the Capacitor bridge** (e.g. `yes` / large `cat` under a real device). This
  is the only genuine unknown in the whole plan; if it fails, the fallback is
  a plugin-local socket/stream channel, and we want to know immediately.

**Out of scope:** `via`, port-forwarding, agent signing, transfers, any UI.

**Verify:** JVM/instrumentation tests against a scratch sshd (adapt the
desktop verify pattern: throwaway sshd on `:2222`, real docker containers);
demo activity or bridge harness proving shell + exec + SFTP round-trips.

### M3 — Native backend, real data, CM6

**Status: code complete (Aug 2026); on-device verification pending an
Android SDK.** `mobile/src/app/native/`: `CapacitorSshTransport` (TOFU
reject→confirm→retry via the HostKeys gate + sheet), `MobileHostStore`
(async twin of core's HostStore: Preferences + Keystore cipher, write-only
secrets incl. the new `privateKey`/`privateKeyEnc` text-key trio added to
core), `createNativeBackend` (PearApi over core SessionManager — orch/
monitor/history reuse core stores via a preload-sync KV facade). Backend
picked by platform in app.config. Terminal is real xterm.js (TermStore owns
one live xterm per host across shell switches; the mock backend grew a
byte-level FakePty so the same screen works in a browser). Editor is
CodeMirror 6 (editable, dirty + save, lazy-loaded chunk). Verified: vitest
fake-bridge suite (15), core 189, browser screenshots both form factors.
Device pass (connect real host, edit/save, orch live) = first task once
Android Studio is set up, together with the M2 `benchPty` spike.

**Scope**
- `CapacitorSshTransport` implementing `SshTransport`/`ShellChannel` over the
  plugin; `SessionManager` on top; `NativeSshBackend` implementing `PearApi`
  (hosts CRUD + secrets write-only contract, term, fs, orch, monitor,
  history, probe).
- Terminal becomes real xterm.js with the design's quick-key row plus a
  Ctrl/Esc/Tab/arrows accessory bar; reconnect-on-resume lifecycle.
- CodeMirror 6 editor (editable, save via `fs.write`, dirty state, language
  packs for conf/json/yaml/shell) replacing the M1 viewer.
- Orch/monitor/host screens flip from mock to live (facet providers over
  `exec`); backend selection: mock in browser, native on device.

**Out of scope:** Claude, transfers, `via`.

**Verify:** on a device/emulator against the scratch-sshd + docker hosts:
connect (key + password + failover), browse/edit/save a file, run orch
actions, live gauges; browser mode still fully works on mock.

### M4 — Claude over SSH

**Status: code complete (Aug 2026); on-device verification pending.** Core
refactor first: the whole chat runtime (ClaudeChatRuntime, PermissionBridge,
ClaudeExecutor, registerPearTools) moved from `core/src/node/claude/` into
the platform-pure `core/src/claude/` with storage + a ChatSessionFactory
injected; `node/claude/*` are now shims so desktop is byte-compatible.
Engine gained non-PTY exec channels (clean stderr demux + `shellSignal`),
`remoteForwardOpen/Close`, and `McpRelay` (a loopback HTTP server) — a JVM
test proves the full tunnel: curl on the host → SSH remote-forward → relay →
response. Mobile `native/claude/`: `SshChatSession` runs `claude
--output-format stream-json` on a non-PTY channel; `McpWebViewServer` serves
core's tools over the relay bridge (lazy-loaded — the MCP SDK is an 82 kB
chunk); workspace `.mcp.json`/CLAUDE.md provisioned over SFTP. UI: the M1
demo store became the `CLAUDE_STORE` interface, with `ClaudeDemo` (mock) and
`ClaudeLive` (renders the real ClaudeChatEvent stream) behind it — the
screen is unchanged. Claude-host picker lives in the sessions sheet.
Verified: core 189, engine 22 (incl. tunnel), mobile 21 (incl. MCP
list_hosts + stream parse), all builds; screenshot confirms the screen.
Device pass (a real host running `claude`, a permission round-trip, an MCP
tool landing back on the phone) is the on-device task.

First device run surfaced (and fixed) two things: the MCP relay bound
`getLoopbackAddress()` (=`::1` on Android) while the SSH forwarder dials
`127.0.0.1`, so every tunneled request was refused — and sshj 0.40's
malformed CHANNEL_OPEN_FAILURE (missing the RFC-4254 language-tag field) then
made the server drop the whole connection ("Invalid open failure message").
Relay now binds `127.0.0.1` explicitly. Setup failures are now surfaced as
plain-language chat errors: no Claude host, `AllowTcpForwarding` disabled
(engine `FORWARD_DENIED`), CLI not installed (a preflight `command -v
claude`), unreachable home dir, workspace-provision failure — each with the
tunnel/relay cleaned up. A lost connection reads as such, not "exit -1".

**Scope**
- "Claude host" setting (a host with `claude` installed + authenticated).
- Exec-channel runtime: spawn `claude --output-format stream-json` per
  session, feed `ChatStreamParser`, drive the `ClaudeChat` store; sessions
  list/resume/new; interrupt.
- Transcript UI already built in M1 goes live: permission cards (allow /
  session / deny), question cards, reports, thinking blocks, context meter,
  auto-approve.
- MCP tools (list_hosts, exec, read_terminal…): serve from the phone over
  HTTP and expose to the Claude host via sshj **remote port-forward**
  (Claude connects to `localhost:<port>` on its host, tunneled back).
  Fallback if the tunnel fights us: v1 tools scoped to the Claude host only.

**Out of scope:** on-device CLI, token/API mode, desktop-style local PTY dock.

**Verify:** end-to-end chat against a real host running `claude`; a
permission round-trip; an MCP tool call landing back on the phone.

### M5 — Proxy & reach

**Status: code complete (Aug 2026); on-device verification pending.** `via`
ProxyJump works end-to-end through the native stack. The design was already
wired for it: core's `SessionManager` resolves `HostConfig.via`, builds the
jump connection first, and hands it to the transport factory — the only gaps
were the leaf implementations, now filled:
- **Engine** (`SshEngine.connectVia(spec, jumpSessionId)`): opens a
  `direct-tcpip` channel on the jump (`jump.newDirectConnection`) and runs a
  second, independent `SSHClient` over it via sshj's `connectVia(DirectConnection)`.
  Auth + TOFU verify the *target's* own host key end-to-end, so the jump never
  sees the target's credentials; keepalive + disconnect instrumentation are
  shared with `connect` (extracted `authAndRegister`/`addVerifier`). A dying
  jump EOFs the tunnel and cascades the target closed.
- **Plugin** (`PearSshPlugin.connectVia`): same `ConnectSpec` builder as
  `connect` (`PluginCall.connectSpec()`), plus a `jumpSessionId`.
- **TS** (`CapacitorSshTransport`): accepts the `jump` transport (must itself
  be a `CapacitorSshTransport`), routes the dial through `plugin.connectVia`
  with the jump's `pluginSessionId`, keeps the TOFU retry dance on the tunneled
  leg, and disposes itself when the jump closes. Chains (A → B → C) are just
  nested jumps SessionManager builds bottom-up.

- **UI**: a "Connect via" picker in the host editor's Advanced section
  (`host-editor.html`) — a select over every other host (`jumpCandidates`),
  "Direct (no jump)" default; the chosen id lands in `HostConfig.via` and
  persists through `saveHost`.

Tests: engine +3 JVM (tunneled exec/PTY, target-key TOFU over the tunnel,
jump-death cascade — the scratch sshd doubles as its own jump target via a
loopback direct-tcpip channel); mobile +5 vitest (tunnels through the jump
session, target TOFU carried through, non-native jump rejected, unconnected
jump fails, jump-drop teardown). Engine 23 JVM (SshEngineTest 20), mobile 31
vitest.

**Not done:** the stretch credential-proxy (agent-protocol tunnel) below —
deferred; and on-device verification of a real two-hop chain.

**Scope (remaining, stretch)**
- Credential proxy — tunnel the SSH agent protocol to the proxy's
  `SSH_AUTH_SOCK` so the proxy's keys sign target auth while sessions stay
  native. UI must frame such a proxy as trusted. (Keys-in-agent only.)

**Verify:** reach a host only routable through another host; scratch-sshd
chain test (A → B where B only listens on a docker network).

### M6 — Transfers, packaging, polish

**Status: code complete except the polish pass (Aug 2026); on-device
verification pending.** Four pieces shipped:

- **Claude resilience — detached runner + file streaming** (added to M6 by
  request; the chat twin of the terminal's tmux wrap). `SshChatSession` now
  probes the host for `setsid` and, when present, runs claude *detached*: a
  POSIX-`sh` wrapper under `setsid` (its own session, so sshd's process-group
  kill can't reach it) with stdin from a FIFO held open read-write, stream-json
  appended to `run/<id>/out.jsonl`, pid/exit files beside it, and an exit
  sentinel line appended to the stream itself. The phone streams the file with
  `tail -c +offset -f` on a non-PTY channel and counts consumed bytes
  (`utf8ByteLength`); when the SSH connection drops mid-turn it re-dials and
  re-tails from that offset — the reply catches up instead of dying. Sends go
  through liveness-guarded FIFO writes (`kill -0` on the process group, so a
  dead runner answers `DEAD` instead of blocking); a dead runner relaunches
  with `--resume` transparently. Hosts without setsid (macOS) fall back to the
  M4 direct-stdio mode. Backend side: the Claude runtime now *survives* host
  disconnects (no teardown in onHostDisconnected); `ensureTunnel` re-dials and
  re-forwards the **same remote port** (`remoteForwardOpen` gained a
  `remotePort` request param through engine/plugin/TS) so the running claude's
  `.mcp.json` stays valid across reconnects. Known gap: MCP calls made during
  the phone's offline window fail (claude sees tool errors) — unavoidable
  without a host-side proxy.
- **Keep-alive foreground service** — `PearForegroundService` (dataSync type,
  low-importance "N SSH sessions active" notification) started/stopped
  automatically by the plugin as engine sessions come and go; zero TS wiring.
  Keeps the process out of the cached-apps freezer so WebView timers (terminal,
  Claude tail-chase, transfers, MCP relay) keep running while backgrounded.
  POST_NOTIFICATIONS requested on first start; a background-start denial
  (Android 12+) is caught and tolerated.
- **Transfers** — engine `download`/`upload` (SFTP streams, 16-deep pipelining,
  ≤32KB writes — servers cap SFTP message size; 100ms-throttled
  `transferProgress` events; `transferAbort` → TRANSFER_ABORTED) + `LocalFs`
  (phone filesystem as the relay: list/stat/mkdir/remove/rename/SHA-256/staging
  dirs under the app cache). TS: core `TransferEngine` wired with
  `LocalFsTransport` as the `hostId: null` relay endpoint — cross-host
  transfers stage through the phone exactly like desktop's local relay.
  Device flows: `transfers.download` stages then publishes into the system
  Downloads collection (MediaStore `Download/Pear` on API 29+, public dir
  below); `pickAndUpload` (mobile-only backend extra) runs the SAF picker,
  stages picks into cache, and uploads into the open directory. Files screen:
  per-file download button, header Upload wired, transfer strip (progress bar,
  stage 1/2 label, cancel/dismiss) that refreshes the listing when a job
  lands. Staging dirs are swept on terminal job states.
- **Release CI** — `.github/workflows/android.yml`: tag-triggered (`v*`) +
  dispatch dry-run; builds web + `cap sync`, assembles a release APK signed
  from `ANDROID_KEYSTORE_BASE64`/`_PASSWORD`/`_ALIAS`/`_KEY_PASSWORD` secrets
  (unsigned when absent — `signingConfigs.release` in app/build.gradle reads
  `PEAR_KEYSTORE_*` env), stamps versionName from the tag and versionCode from
  the run number, uploads the artifact and attaches it to the GitHub release.

Tests: mobile 39 vitest (detached-runner suite: launch/tail/FIFO write,
offset re-tail on drop, dead-runner settle after catch-up, exit sentinel,
--resume relaunch, interrupt kill, direct fallback ×3; transfer wiring:
pickAndUpload → upload leg + staging sweep, download → Downloads publish);
engine 23 JVM (upload/download round-trip w/ progress + hash parity, abort,
LocalFs).

**Not done (the polish pass — deferred to a later run):** haptics,
back-gesture behavior per screen, keyboard insets, a dedicated transfer-queue
sheet beyond the Files strip, Play-readiness checklist. On-device verify list:
Claude reply surviving screen-off/reconnect, keep-alive notification
lifecycle, SAF pick → upload, download landing in Downloads, CI APK install.

**Verify:** cross-host transfer through the phone; upload from SAF; CI
produces an installable signed APK; a Claude reply survives screen-off.

## Explicitly deferred

- **Standalone Pear server / `RemoteServerBackend`** — headless
  `core/src/node` behind a WebSocket re-exposing `PearApi`; adds host-list
  sync (E2E-encrypted; server stores ciphertext only), push, and a Claude
  fallback. Cheap to add later precisely because `PearApi` is already
  IPC-shaped — but no WS bridge exists today and none is needed for v1.
- Subhost descent (exec-tunnel into containers/VMs) — M5's nested-client
  machinery is the prerequisite; UI comes later.
- iOS (Capacitor keeps the door open; plugin would target swift-nio-ssh).
- Token/API Claude mode.

## Risks

| Risk | Mitigation |
|---|---|
| PTY data rate over the Capacitor bridge janks | M2 week-one spike; batch per frame; fallback to a local socket stream |
| sshj/BouncyCastle friction on Android (stripped OS BC, R8/ProGuard) | Known pattern: depend on real `bcprov`, register provider explicitly, keep rules; covered by M2 instrumentation tests |
| App death in background kills sessions | Reconnect-on-resume from M3; **terminals auto-wrap in tmux** (attach-or-create per host) when the host has it, so a running command survives a screen-off drop and reconnect re-attaches — warns once if tmux is absent; foreground service as opt-in in M6. (Claude chat can't use tmux — stream-json over stdio, not a PTY — so it relies on `--resume` + the M6 service.) |
| CM6 (mobile) vs Monaco (desktop) divergence | Both sit behind `fs.read`/`fs.write`; no shared editor state to drift |
| Keystore UX (biometric prompts, key invalidation on lock changes) | Wrap-key design isolates it; decided in M2 secrets work |

## Testing strategy

- **Core** parsers/stores: already unit-tested; unchanged.
- **TS backend** (`CapacitorSshTransport`, `NativeSshBackend`): vitest against
  a fake plugin bridge (scripted event streams).
- **Kotlin plugin**: JVM tests with sshj against a throwaway sshd (the
  desktop verify pattern: scratch sshd `:2222` + real docker), plus a small
  instrumentation suite on-device for Keystore and bridge throughput.
- **UI**: browser e2e on `MockBackend` (works headless in CI); design-parity
  eyeballing against the two design HTMLs at phone/tablet widths.
