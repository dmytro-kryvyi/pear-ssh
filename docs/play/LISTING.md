# Google Play submission kit

Everything needed to fill in the Play Console for Pear. Assets in this folder:
`icon-512.png` (app icon), `feature-graphic.png` (1024×500). Phone screenshots:
use the three mobile shots from `site/assets-src/shot-mob-*.png` (Play wants
16:9-ish portrait; re-capture at device resolution if the console rejects them).

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

Prepare a short screen-recording (open a session → background the app →
notification visible → return, session alive → close session → notification
gone) — the review commonly asks for a video demonstrating the service.

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
