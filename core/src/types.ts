// Shared domain types for Pear. These cross the core <-> desktop <-> ui
// boundary, so keep them JSON-serializable.

export type HostKind = 'docker' | 'swarm' | 'proxmox' | 'plain';
export type HostStatus = 'online' | 'idle' | 'offline' | 'unknown';

export interface HostAuth {
  /** Try the running ssh-agent (SSH_AUTH_SOCK). Default true. */
  agent?: boolean;
  /** Absolute path to a private key file. */
  privateKeyPath?: string;
  /** Passphrase for the key file, if encrypted. */
  passphrase?: string;
  /** Password auth (also answers keyboard-interactive). */
  password?: string;
}

/** What a sub-host enters on its parent: a container engine target. */
export interface SubHostTarget {
  type: 'docker' | 'lxc';
  /** docker: container name (stable across recreation); lxc: vmid as string. */
  ref: string;
}

export interface HostConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  tag?: string;
  kind: HostKind;
  auth?: HostAuth;
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

export type FacetKind = 'docker' | 'swarm' | 'proxmox';

/** Which orchestration systems a host runs (a host can be several at once). */
export interface HostFacets {
  docker: boolean;
  swarm: boolean;
  proxmox: boolean;
}

/**
 * A host's live orchestration state. Any subset of facets may be present —
 * e.g. a Proxmox node that also runs Docker, or a Swarm manager (which has
 * both `swarm` services and `docker` standalone containers). An empty object
 * means nothing orchestration-related was detected.
 */
export interface Orchestration {
  docker?: DockerFacet;
  swarm?: SwarmFacet;
  proxmox?: ProxmoxFacet;
}

export type OrchAction =
  | { type: 'container'; id: string; name: string; op: 'start' | 'stop' | 'restart' | 'logs' }
  | { type: 'compose'; project: string; op: 'start' | 'stop' | 'restart' | 'logs' }
  | { type: 'service'; name: string; op: 'restart' | 'logs' }
  | { type: 'service'; name: string; op: 'scale'; replicas: number }
  | {
      type: 'guest';
      vmid: number;
      guestType: 'vm' | 'lxc';
      op: 'start' | 'shutdown' | 'reboot' | 'console';
    };

export interface OrchActionResult {
  /** Set for streaming actions (logs, console): run this in the terminal. */
  terminalCommand?: string;
}
