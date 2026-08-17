// Shared domain types for Pear. These cross the core <-> desktop <-> ui
// boundary, so keep them JSON-serializable.

export type HostKind = FacetKind | 'plain';
export type HostStatus = 'online' | 'idle' | 'offline' | 'unknown';

/**
 * Explicit auth method chosen in the host editor. Absent on legacy hosts,
 * which keep the heuristic chain: agent -> explicit key -> default keys ->
 * password.
 */
export type AuthMethod = 'key' | 'agent' | 'password';

export interface HostAuth {
  /** Explicit method; undefined = legacy heuristic chain. */
  method?: AuthMethod;
  /** Try the running ssh-agent (SSH_AUTH_SOCK). Default true. */
  agent?: boolean;
  /** Forward the local agent to the remote session. */
  agentForward?: boolean;
  /** Absolute path to a private key file. */
  privateKeyPath?: string;
  /**
   * Private key as text (OpenSSH/PEM). The mobile app's key source — there
   * is no ~/.ssh on Android — and an alternative to privateKeyPath anywhere.
   * Write-only transient, same contract as password/passphrase.
   */
  privateKey?: string;
  /** Cipher text of privateKey. Persisted; never leaves the trusted side. */
  privateKeyEnc?: string;
  /**
   * Passphrase for the key file, if encrypted. Write-only transient: consumed
   * by upsert (encrypted to passphraseEnc) and by connect-time configs; never
   * persisted or returned to the renderer.
   */
  passphrase?: string;
  /** Password auth (also answers keyboard-interactive). Write-only transient. */
  password?: string;
  /** safeStorage ciphertext (base64). Persisted; never leaves the main process. */
  passwordEnc?: string;
  /** safeStorage ciphertext (base64). Persisted; never leaves the main process. */
  passphraseEnc?: string;
  /** Set on sanitized views so the UI can show "unchanged" placeholders. */
  hasPassword?: boolean;
  /** Set on sanitized views so the UI can show "unchanged" placeholders. */
  hasPassphrase?: boolean;
  /** Set on sanitized views so the UI can show "unchanged" placeholders. */
  hasPrivateKey?: boolean;
}

/** One address a host answers on. Dialed top-to-bottom; first success wins. */
export interface HostEndpoint {
  id: string;
  /** 'lan', 'vpn', 'public (fallback)' ... */
  label?: string;
  addr: string;
  port: number;
  note?: string;
}

/** Named palette for host/workspace accents (resolved to oklch in the UI). */
export type HostColor = 'red' | 'amber' | 'green' | 'teal' | 'blue' | 'violet';

export interface EnvVar {
  k: string;
  v: string;
}

/** One active SSH local port-forward (desktop PortForwardManager; the Claude
 *  port_forward tools report these). Pure type — managers are per-platform. */
export interface PortForwardInfo {
  id: string;
  hostId: string;
  hostName: string;
  /** Destination as seen from the remote host (usually 127.0.0.1). */
  remoteHost: string;
  remotePort: number;
  localHost: '127.0.0.1';
  localPort: number;
  startedAt: number;
}

/** Result of probing one endpoint for an SSH listener. */
export type ProbeResult =
  | { ok: true; latencyMs: number; banner?: string }
  | { ok: false; error: 'refused' | 'timeout' | 'unreachable' | 'other'; detail?: string };

/**
 * A named set of hosts ("Workspace" in the UI; HostGroup internally to avoid
 * clashing with the pane workspace). A host can belong to any number of them.
 */
export interface HostGroup {
  id: string;
  name: string;
  color: HostColor;
  icon: 'layers' | 'server' | 'cpu' | 'lightning' | 'docker';
  desc?: string;
  hostIds: string[];
}

/**
 * Container engines Pear can enter as a sub-host. Adding one (e.g. podman)
 * means extending this union and adding its adapter in ssh/subhost.ts.
 */
export type SubHostType = 'docker' | 'lxc';

/** What a sub-host enters on its parent: a container engine target. */
export interface SubHostTarget {
  type: SubHostType;
  /** docker: container name (stable across recreation); lxc: vmid as string. */
  ref: string;
}

export interface HostConfig {
  id: string;
  name: string;
  /** Mirror of endpoints[0].addr (kept for display and legacy readers). */
  host: string;
  /** Mirror of endpoints[0].port. */
  port: number;
  user: string;
  /** @deprecated Migrated to tags[0] on load; read forever, never written. */
  tag?: string;
  /** Freeform labels; tags[0] doubles as the sidebar badge. */
  tags?: string[];
  /** Extra names matched by search / quick connect. */
  aliases?: string[];
  /** 3-5 char label for tight rows; falls back to autoShort(name). */
  short?: string;
  /** Named accent used for the sidebar stripe and editor header. */
  color?: HostColor;
  /** Private free-text notes. */
  notes?: string;
  kind: HostKind;
  /** User pinned `kind` in the editor; facet detection won't overwrite it. */
  kindManual?: boolean;
  auth?: HostAuth;
  /**
   * Ordered failover addresses. Absent on local hosts and sub-hosts. Regular
   * hosts get one minted from host/port on load.
   */
  endpoints?: HostEndpoint[];
  /** Default working directory for new tabs and terminals. */
  cwd?: string;
  /** Environment exported at the top of every new terminal. */
  env?: EnvVar[];
  /** Commands run, in order, in every new terminal for this host. */
  startup?: string[];
  /** Per-endpoint dial budget during failover (ms). */
  readyTimeoutMs?: number;
  /** Sub-host: id of the parent whose SSH connection is reused. */
  parentId?: string;
  /** Sub-host: what to enter on the parent. Present iff parentId is. */
  target?: SubHostTarget;
  /**
   * Real SSH host tunneled through this host's connection (ProxyJump).
   * Mutually exclusive with parentId/target (which mean exec sub-host).
   */
  via?: string;
  /**
   * The machine Pear itself runs on — no SSH involved; shells, exec, and
   * files use local processes and the local filesystem. host/port/user are
   * informational only, and auth/via/parentId never apply.
   */
  local?: boolean;
}

export interface TermSize {
  cols: number;
  rows: number;
}

/** Claude Code dock availability (the CLI itself is user-installed). */
export interface ClaudeStatus {
  /** `claude` resolves in the user's login shell. */
  installed: boolean;
  /** Pear's MCP server is up and the workspace dir is provisioned. */
  mcpReady: boolean;
}

export interface FileEntry {
  name: string;
  kind: 'dir' | 'file' | 'link';
  size: number;
  mtimeMs: number;
  mode: string;
}

export interface DirListing {
  /** Absolute path after resolution (e.g. '~' -> /home/user). */
  path: string;
  entries: FileEntry[];
}

// ---- Orchestration (Docker / Swarm / Proxmox) ------------------------------

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  running: boolean;
  /** Human status from docker, e.g. "Up 14 days" / "Exited (0) 2 hours ago". */
  status: string;
  ports: string;
  /** Compose project (com.docker.compose.project label), or null if standalone. */
  project: string | null;
  /** Live CPU load as a 0..1 fraction (null when stopped or stats unavailable). */
  cpu: number | null;
  /** Live memory use in bytes (null when stopped/unavailable). */
  mem: number | null;
  /** Memory limit in bytes (null when unavailable). */
  maxmem: number | null;
}

/** Containers sharing a Compose project (project null = standalone). */
export interface ComposeGroup {
  project: string | null;
  containers: ContainerInfo[];
}

export interface SwarmNodeInfo {
  name: string;
  role: 'manager' | 'worker';
  ready: boolean;
  leader: boolean;
  /** Advertised address (host:port), or '' if unknown. */
  addr: string;
}

export interface SwarmServiceInfo {
  id: string;
  name: string;
  image: string;
  mode: 'replicated' | 'global';
  running: number;
  desired: number;
  ports: string;
  /** Stack namespace (com.docker.stack.namespace / name prefix), null if none. */
  stack: string | null;
}

/** Services sharing a Swarm stack (stack null = standalone service). */
export interface SwarmStackGroup {
  stack: string | null;
  services: SwarmServiceInfo[];
}

/** Lifecycle states a swarm task reports (docker's state list, lowercased). */
export type SwarmTaskState =
  | 'new'
  | 'allocated'
  | 'pending'
  | 'assigned'
  | 'accepted'
  | 'preparing'
  | 'ready'
  | 'starting'
  | 'running'
  | 'complete'
  | 'shutdown'
  | 'failed'
  | 'rejected'
  | 'remove'
  | 'orphaned';

/** One row of `docker service ps` — includes historical (shutdown) tasks. */
export interface SwarmTaskInfo {
  /** Full task id (--no-trunc); also the target for `docker service logs`. */
  id: string;
  /** "svc.1" (replicated) or "svc.<nodeid>" (global). History repeats names. */
  name: string;
  /** The part after "<service>.": replica slot number, or node id for global. */
  slot: string;
  image: string;
  /** Hostname of the node the task was placed on ('' while unscheduled). */
  node: string;
  /** What the orchestrator wants: "running" or "shutdown" (lowercased). */
  desiredState: string;
  state: SwarmTaskState;
  /** Docker's human relative time, e.g. "4 hours ago" ('' if unparsed). */
  sinceText: string;
  /** Task error with docker's wrapping quotes stripped; '' when none. */
  error: string;
}

/** One parsed line of `docker service logs --raw -t` for a single task. */
export interface TaskLogLine {
  /** RFC3339Nano timestamp — also the --since cursor for follow polling. */
  ts: string;
  /**
   * CLI stream the line arrived on: container stdout vs stderr. Tasks
   * running with a TTY merge everything into 'out'.
   */
  stream: 'out' | 'err';
  text: string;
}

export interface TaskLogChunk {
  lines: TaskLogLine[];
  /** Latest timestamp seen — pass as `since` on the next poll. Null when empty. */
  lastTs: string | null;
}

export interface ProxmoxResources {
  /** CPU load as a 0..1 fraction. */
  cpu: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  /** Seconds. */
  uptime: number;
}

export interface ProxmoxGuestInfo {
  vmid: number;
  name: string;
  type: 'vm' | 'lxc';
  running: boolean;
  status: string;
  /** CPU load as a 0..1 fraction (0 when stopped). */
  cpu: number;
  mem: number;
  maxmem: number;
}

/** Guests sharing a type (QEMU VMs vs LXC containers). */
export interface ProxmoxGuestGroup {
  type: 'vm' | 'lxc';
  guests: ProxmoxGuestInfo[];
}

export interface DockerFacet {
  /** Plain containers only — swarm-managed tasks are excluded (see swarm). */
  containers: ContainerInfo[];
  /** The same containers grouped by Compose project, standalone last. */
  groups: ComposeGroup[];
}

export interface SwarmFacet {
  nodes: SwarmNodeInfo[];
  services: SwarmServiceInfo[];
  /** The same services grouped by stack, standalone last. */
  stacks: SwarmStackGroup[];
}

export interface ProxmoxFacet {
  resources: ProxmoxResources | null;
  guests: ProxmoxGuestInfo[];
  /** The same guests grouped by type (VMs then CTs). */
  groups: ProxmoxGuestGroup[];
}

/**
 * The single source of truth for which orchestration facets exist and what
 * their live state looks like. Adding a facet (e.g. podman) means: add its
 * data shape here, its actions to FacetActionMap, and register a provider in
 * core/src/orchestration — every facet type below is derived from these maps,
 * and the provider registry is compile-checked against them.
 */
export interface FacetDataMap {
  docker: DockerFacet;
  swarm: SwarmFacet;
  proxmox: ProxmoxFacet;
}

export type FacetKind = keyof FacetDataMap;

/** Which orchestration systems a host runs (a host can be several at once). */
export type HostFacets = Record<FacetKind, boolean>;

/**
 * A host's live orchestration state. Any subset of facets may be present —
 * e.g. a Proxmox node that also runs Docker, or a Swarm manager (which has
 * both `swarm` services and `docker` standalone containers). An empty object
 * means nothing orchestration-related was detected.
 */
export type Orchestration = { [K in FacetKind]?: FacetDataMap[K] };

export type DockerAction =
  | { type: 'container'; id: string; name: string; op: 'start' | 'stop' | 'restart' | 'logs' }
  | { type: 'compose'; project: string; op: 'start' | 'stop' | 'restart' | 'logs' }
  | { type: 'engine'; op: 'prune' };

export type SwarmAction =
  | { type: 'service'; name: string; op: 'restart' | 'logs' }
  | { type: 'service'; name: string; op: 'scale'; replicas: number };

export type ProxmoxAction = {
  type: 'guest';
  vmid: number;
  guestType: 'vm' | 'lxc';
  op: 'start' | 'shutdown' | 'reboot' | 'console';
};

/**
 * Actions each facet's provider handles, keyed like FacetDataMap. The `type`
 * discriminants must stay globally unique — they are how an action finds its
 * provider.
 */
export interface FacetActionMap {
  docker: DockerAction;
  swarm: SwarmAction;
  proxmox: ProxmoxAction;
}

export type OrchAction = FacetActionMap[FacetKind];

export interface OrchActionResult {
  /** Set for streaming actions (logs, console): run this in the terminal. */
  terminalCommand?: string;
}

// ---- Resource monitor ------------------------------------------------------

/** Cumulative jiffies from /proc/stat; idle includes iowait. */
export interface CpuTicks {
  idle: number;
  total: number;
}

export interface MountUsage {
  fs: string;
  mount: string;
  totalKB: number;
  usedKB: number;
}

/** Cumulative byte counters from /proc/net/dev. */
export interface NetIfaceCounters {
  name: string;
  rxBytes: number;
  txBytes: number;
}

/**
 * One raw vitals snapshot from a single exec round-trip. CPU and network are
 * cumulative counters — rates come from the delta between two samples, which
 * the caller computes (core keeps no per-host state).
 */
export interface HostVitalsSample {
  at: number;
  cpu: CpuTicks;
  /** Per-core ticks, cpu0..cpuN in order. */
  cores: CpuTicks[];
  loadavg: [number, number, number];
  uptimeSec: number;
  kernel: string;
  memTotalKB: number;
  memAvailableKB: number;
  swapTotalKB: number;
  swapFreeKB: number;
  /** Real filesystems only (pseudo-fs filtered; '/' kept as fallback). */
  mounts: MountUsage[];
  /** Every interface except lo; the UI filters virtual ones. */
  net: NetIfaceCounters[];
}

/** One row of `docker system df` (containers / images / volumes / build cache). */
export interface DockerDiskRow {
  type: 'containers' | 'images' | 'volumes' | 'buildCache';
  count: number;
  active: number;
  /** Parsed bytes, null if docker's human string was unparseable. */
  size: number | null;
  reclaimable: number | null;
  /** Docker's own human strings, shown verbatim in the UI. */
  sizeText: string;
  reclaimableText: string;
}

/** Live per-container stats keyed by container id (rides the monitor tick). */
export type ContainerStatsMap = Record<
  string,
  { cpu: number | null; mem: number | null; maxmem: number | null }
>;
