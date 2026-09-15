# Google Play submission kit

Everything needed to fill in the Play Console for Pear. Assets in this folder:
`icon-512.png` (app icon), `feature-graphic.png` (1024×500), and
`screenshots/` — real captures of the app (mock-backend demo data) at exact
Play ratios: 5 phone shots at 1080×1920 (9:16) and 3 tablet shots at
2560×1440 (16:9). Upload the same tablet files to BOTH the 7-inch and
10-inch slots (both accept 2560×1440). To re-capture after UI changes:
`npm start -w mobile` (mock backend in browser) + the playwright-core script
pattern — drive Chrome at 360×640@3x for phone, 1280×720@2x for tablet.

## Identity (decided 2026-08-29)

- **applicationId:** `app.pear.mobile` — permanent once the first build is
  uploaded; deliberately kept (desktop's `dev.pear.desktop` scheme is cosmetic,
  neither maps to an owned domain).
- **Launcher label:** "Pear" (`res/values/strings.xml`) — short, matches desktop.
- **Play listing title:** "Pear — SSH workspace" — "ssh" is the category search
  term (every competitor titles with it); "Pear" alone is unsearchable.

## US export compliance

Play Console asks for a one-time acknowledgement that the app complies with US
export laws (uploading to Google's US servers is legally an "export" of the
SSH cryptography). Basis for checking it (not legal advice): Pear is free,
open-source, and uses standard published crypto protocols (SSH via sshj) —
the mass-market / publicly-available-source case under the EAR that every
open-source SSH client ships on. Optional belt-and-braces: email the repo URL
once to crypt@bis.doc.gov (cc web_site@bis.doc.gov) per the
publicly-available-source notification provision.

## Store listing

- **App name:** Pear — SSH workspace
- **Short description** (≤80 chars):
  > SSH client with files, terminal, live metrics and container dashboards.
- **Full description:**
  > Every host, one workspace.
  >
  > Pear is a free, open-source SSH workspace: connection manager, file browser,
  > terminal, live resource monitor and container orchestration in one app.
  >
  > • Workspaces — group hosts, quick connect, connection profiles with failover
  > • Files — browse, edit and transfer between hosts
  > • Terminal — a real shell per host that follows the folder you browse
  > • Monitoring — CPU, memory, network and disks, live
  > • Docker, Swarm & Proxmox — detected automatically; containers, replicas,
  >   VMs and guests with stats and logs
  > • Jump in — a full workspace inside any container or VM guest
  >
  > No account. No backend. No telemetry. Your keys stay in the Android
  > Keystore, and Pear connects only to servers you configure.
  >
  > Open source (MIT): https://github.com/dmytro-kryvyi/pear-ssh
- **Category:** Tools
- **Privacy policy URL:** `<BASE_URL>/privacy` (currently https://pear.pages.dev/privacy —
  update if a custom domain lands)
- **Contact email:** required by Play — use the address on the GitHub profile.

## Data safety form

- Data collected: **none**. Data shared: **none**.
- "Does your app collect or share any of the required user data types?" → **No**.
- Encryption in transit: yes (SSH). Deletion request mechanism: N/A (no data).
- Note: SSH credentials are stored on-device in the Android Keystore and never
  transmitted to the developer — that is *not* "collection" per Play's
  definition (data leaving the device).

## Foreground service declaration (specialUse)

Play requires a declaration + review for `FOREGROUND_SERVICE_SPECIAL_USE`.
Decision record: `dataSync` was rejected (Android 15 imposes a 6-hour timeout
that would kill long-lived sessions) and `connectedDevice` was rejected (its
prerequisites — Bluetooth/USB/Wi-Fi-config permissions — don't apply to an SSH
client). `specialUse` is the honest fit; the manifest already carries the
`PROPERTY_SPECIAL_USE_FGS_SUBTYPE` justification.

Declaration text for the console:

> Pear is an interactive SSH client. The foreground service keeps the user's
> live SSH sessions (remote shells, file transfers, log streams) connected
> while the app is backgrounded. Terminating the process would drop remote
> shells and abort in-flight transfers, losing user work on their servers.
> The service runs only while at least one session the user opened is active,
> shows a persistent "sessions active" notification, and stops automatically
> when the last session closes. No standard FGS type covers an interactive
> remote-shell client: dataSync is time-limited (sessions are indefinite and
> user-attended) and connectedDevice targets local peripherals.

The console form (App content → Foreground service permissions) asks for a task
selection, a video, and a description. Answers of record:

- **Task:** Other.
- **Description** (why it must start immediately / can't be paused or restarted):

> Pear is an interactive SSH client. When the user opens a session to their
> server, the foreground service starts immediately and keeps that session's
> TCP/SSH connection alive while the app is backgrounded — remote shells,
> in-flight file transfers, and live log streams run over it.
>
> The task cannot be paused: pausing means the OS freezes the process and the
> SSH connection times out server-side. It cannot be restarted, because
> reconnecting does not restore the previous state — remote shell processes
> are terminated by the disconnect and interrupted transfers abort, losing the
> user's work on their servers.
>
> The service runs only while at least one user-opened session is active,
> shows a persistent "sessions active" notification, and stops automatically
> when the last session closes. No standard FGS type fits: dataSync is
> time-limited (sessions are indefinite and user-attended), and
> connectedDevice targets local peripherals, not remote servers.

- **Video** (~60s, real device, unlisted YouTube link). Show a task with a real
  interruption cost, mirroring the description's claims:
  1. Prep off-camera: `fallocate -l 2G /tmp/demo.bin` on a host.
  2. Pear → Files → download demo.bin → progress % climbing.
  3. Home → notification shade → "SSH sessions active".
  4. ~15s outside the app → reopen → progress advanced (task ran in background).
  5. Optional: shell scene with `sudo apt-get upgrade` running while backgrounded.
  6. Disconnect → notification gone.
  Pre-flight: verify a transfer actually survives backgrounding on-device
  before recording — that's the exact path the FGS protects.

## Content rating questionnaire (IARC) — answers of record

All **No**, except **Online Content = Yes**.

- Ratings-relevant content in package → No (SSH tool, no such assets)
- User content sharing (user-to-user) → No (single-user tool)
- **Online content → Yes** — the app ships a dedicated Claude assistant UI and
  a listing screenshot shows it; "generated AI content" is the question's own
  example. The BYO-CLI/own-server argument doesn't flip this: IARC asks whether
  content can be *accessed from the app*, not who hosts it, and an all-No
  declaration would contradict the store screenshots.
  - Follow-ups (Violence / Sexuality / Language / Controlled substances) → all
    **No**: these cover *developer-curated catalog* content (Netflix-style) and
    explicitly exclude user-directed content. Pear curates no catalog; AI output
    is user-prompted and provider-moderated.
- Age-restricted products, location sharing, digital purchases, cash/crypto
  rewards, browser/search engine, news/educational → all No.

Expected result: Everyone / PEGI 3, possibly with an "unrated online content" /
AI interactive-element note.

## Release name & notes

Release name: the bare version (`0.1.0`) — console-internal, keep it matching
the git tag. Release notes: ≤500 chars, plain text, tester-facing. v0.1.0 notes:

```
<en-US>
First test build of Pear — an SSH workspace for your phone.

• Hosts & workspaces with quick connect
• Files: browse, edit and transfer
• Real terminal (PTY) per host
• Live CPU, memory and network vitals
• Docker, Swarm & Proxmox dashboards with container logs

Early build — expect rough edges, and thanks for testing! Report anything odd at github.com/dmytro-kryvyi/pear-ssh/issues
</en-US>
```

For later releases: lead with what changed (from CHANGELOG.md), not the feature
list — testers see these notes as the "what's new" text.

## Release checklist

1. Secrets in repo settings: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
   `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` (workflow builds unsigned without them).
2. Tag `vX.Y.Z` → CI produces `pear-vX.Y.Z.aab` (workflow artifact; the `.apk`
   goes to the GitHub release for sideloading).
3. Play Console → create app → enroll in **Play App Signing** (the CI keystore
   becomes the upload key).
4. Upload the `.aab` to an **internal testing** track first.
5. **New personal developer accounts:** production requires a closed test with
   ≥12 testers opted in for 14 continuous days before you can apply for
   production access. Plan this into the timeline.
6. Content rating questionnaire (utility app, no user-generated content
   visible to others → Everyone), ads declaration (none), target audience
   (18+ / not directed at children).
