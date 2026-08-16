import type {
  DirListing,
  HostConfig,
  ProxmoxGuestInfo,
  ProxmoxResources,
  SwarmTaskInfo,
  TaskLogChunk,
} from '../../types';
import type {
  ClaudeFocus,
  ClaudeRevealAction,
  ClaudeTerminalInfo,
  ClaudeUiRequestPayload,
} from '../../claude/events';
import type { ExecResult } from '../../ssh/transport';
import type {
  ConflictPolicy,
  TransferJobSnapshot,
  TransferRequest,
} from '../../transfers/engine';
import type { PortForwardInfo } from '../port-forward';
import { applyEdit } from '../../claude/edit';
import { summarizeVitals, fetchVitals, type VitalsSummary } from '../../monitor/vitals';
import { detectFacets, fetchProxmox, type Exec } from '../../orchestration/orchestration';
import { fetchServiceTasks, fetchTaskLogs, type TaskLogsOptions } from '../../orchestration/tasks';
import { shq } from '../../shq';

/** What the Claude MCP tools need from the embedding app (desktop binds this
 *  to HostStore/EphemeralHostRegistry + SessionManager). Host configs are
 *  looked up on every call so reconnects and edits are picked up, matching
 *  the existing IPC handlers. */
export interface ClaudeExecutorEnv {
  hosts(): HostConfig[];
  isConnected(hostId: string): boolean;
  exec(host: HostConfig, command: string): Promise<ExecResult>;
  readFile(host: HostConfig, path: string, maxBytes?: number): Promise<string>;
  writeFile(host: HostConfig, path: string, content: string): Promise<void>;
  listDir(host: HostConfig, path: string): Promise<DirListing>;
  /** Round-trip to the renderer (terminal reads, reveal actions). Absent in
   *  headless embeddings — the UI tools then fail with a clear message. */
  uiRequest?(payload: ClaudeUiRequestPayload): Promise<unknown>;
  /** TransferEngine bridge (host↔host copies). Optional like uiRequest. */
  startTransfer?(req: TransferRequest): string;
  transferList?(): TransferJobSnapshot[];
  /** PortForwardManager bridge. Optional like uiRequest. */
  openForward?(
    host: HostConfig,
    remotePort: number,
    remoteHost?: string,
    localPort?: number,
  ): Promise<PortForwardInfo>;
  listForwards?(): PortForwardInfo[];
  closeForward?(id: string): boolean;
}

/** One row of `list_hosts` — everything the model needs to pick a target. */
export interface ClaudeHostInfo {
  id: string;
  name: string;
  address: string;
  kind: string;
  tag?: string;
  connected: boolean;
  /** The machine Pear itself runs on (commands run locally, no SSH). */
  local?: boolean;
  /** Sub-host: runs inside a container/CT on the parent host. */
  parentId?: string;
  /** The host the user currently has open in the Pear UI. */
  focused?: boolean;
  /** Directory the user is looking at on the focused host. */
  focusedPath?: string;
}

export interface RunResult extends ExecResult {
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 600;

/** Resolves host references (id or name) and executes tool operations over
 *  the app's existing connections. Never sees or returns auth material. */
export class ClaudeExecutor {
  private focus: ClaudeFocus | null = null;

  constructor(
    private readonly env: ClaudeExecutorEnv,
    /** Injectable so vitals tests don't wait out the real sampling gap. */
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Renderer pushes the focused workspace location here on every change. */
  setFocus(focus: ClaudeFocus | null): void {
    this.focus = focus;
  }

  listHosts(): ClaudeHostInfo[] {
    return this.env.hosts().map((h) => ({
      id: h.id,
      name: h.name,
      address: h.local ? 'this machine (local)' : `${h.user}@${h.host}:${h.port}`,
      kind: h.kind,
      ...(h.tag ? { tag: h.tag } : {}),
      connected: this.env.isConnected(h.id),
      ...(h.local ? { local: true } : {}),
      ...(h.parentId ? { parentId: h.parentId } : {}),
      ...(this.focus?.hostId === h.id
        ? { focused: true, ...(this.focus.path ? { focusedPath: this.focus.path } : {}) }
        : {}),
    }));
  }

  /** Host by exact id, exact name, or case-insensitive unique name. */
  resolve(ref: string): HostConfig {
    const all = this.env.hosts();
    const byId = all.find((h) => h.id === ref);
    if (byId) return byId;
    const byName = all.filter((h) => h.name === ref);
    if (byName.length === 1) return byName[0];
    const ciMatches = all.filter((h) => h.name.toLowerCase() === ref.toLowerCase());
    if (ciMatches.length === 1) return ciMatches[0];
    if (byName.length > 1 || ciMatches.length > 1) {
      throw new Error(
        `Host name '${ref}' is ambiguous — use an id from list_hosts: ` +
          ciMatches.map((h) => `${h.name} (${h.id})`).join(', '),
      );
    }
    const known = all.map((h) => h.name).join(', ') || '(no hosts configured)';
    throw new Error(`Unknown host '${ref}'. Known hosts: ${known}`);
  }

  /** Runs through the login shell on the host, bounded by `timeout` so an
   *  interactive or runaway command cannot hang the agent (or the shared
   *  connection) forever. */
  async runCommand(ref: string, command: string, timeoutSec?: number): Promise<RunResult> {
    const host = this.resolve(ref);
    const t = Math.min(MAX_TIMEOUT_SEC, Math.max(1, Math.floor(timeoutSec ?? DEFAULT_TIMEOUT_SEC)));
    const result = await this.env.exec(host, `timeout ${t} sh -c ${shq(command)}`);
    return { ...result, timedOut: result.code === 124 };
  }

  async readFile(ref: string, path: string, maxBytes?: number): Promise<string> {
    return this.env.readFile(this.resolve(ref), path, maxBytes);
  }

  async writeFile(ref: string, path: string, content: string): Promise<void> {
    return this.env.writeFile(this.resolve(ref), path, content);
  }

  async listDir(ref: string, path: string): Promise<DirListing> {
    return this.env.listDir(this.resolve(ref), path);
  }

  /** Plain exec binder for the core fetch* helpers. */
  private execFor(ref: string): Exec {
    const host = this.resolve(ref);
    return (command) => this.env.exec(host, command);
  }

  /** Two samples ~1s apart — CPU/net are counters, one sample has no rates. */
  async hostVitals(ref: string): Promise<VitalsSummary> {
    const run = this.execFor(ref);
    const first = await fetchVitals(run);
    await this.sleep(1000);
    return summarizeVitals(first, await fetchVitals(run));
  }

  async serviceTasks(ref: string, service: string): Promise<SwarmTaskInfo[]> {
    return fetchServiceTasks(this.execFor(ref), service);
  }

  async taskLogs(ref: string, target: string, opts?: TaskLogsOptions): Promise<TaskLogChunk> {
    return fetchTaskLogs(this.execFor(ref), target, opts);
  }

  async listGuests(
    ref: string,
  ): Promise<{ resources: ProxmoxResources | null; guests: ProxmoxGuestInfo[] }> {
    const host = this.resolve(ref);
    const run = this.execFor(ref);
    const facets = await detectFacets(run);
    if (!facets.proxmox) throw new Error(`'${host.name}' is not a Proxmox node`);
    const { resources, guests } = await fetchProxmox(run);
    return { resources, guests };
  }

  private ui(payload: ClaudeUiRequestPayload): Promise<unknown> {
    if (!this.env.uiRequest) throw new Error('Pear window is not available');
    return this.env.uiRequest(payload);
  }

  async listTerminals(): Promise<ClaudeTerminalInfo[]> {
    return (await this.ui({ kind: 'listTerminals' })) as ClaudeTerminalInfo[];
  }

  async readTerminal(terminalId?: string, lines?: number): Promise<string> {
    return (await this.ui({ kind: 'readTerminal', terminalId, lines })) as string;
  }

  async reveal(action: ClaudeRevealAction): Promise<void> {
    // Fail on bad host refs with the usual resolve() message before the UI
    // opens anything.
    this.resolve(action.hostId);
    await this.ui({ kind: 'reveal', action });
  }

  /** 'local' means the Pear machine (hostId null in the engine). Registered
   *  local hosts collapse to the relay in the desktop binding. */
  private transferEndpoint(ref: string, dir: string): { hostId: string | null; dir: string } {
    return { hostId: ref === 'local' ? null : this.resolve(ref).id, dir };
  }

  startTransfer(
    srcRef: string,
    srcDir: string,
    names: string[],
    destRef: string,
    destDir: string,
    opts?: { move?: boolean; conflict?: ConflictPolicy; verify?: boolean },
  ): TransferJobSnapshot {
    if (!this.env.startTransfer || !this.env.transferList) {
      throw new Error('Transfers are not available');
    }
    if (names.length === 0) throw new Error('names must not be empty');
    const id = this.env.startTransfer({
      src: this.transferEndpoint(srcRef, srcDir),
      dest: this.transferEndpoint(destRef, destDir),
      names,
      op: opts?.move ? 'move' : 'copy',
      conflict: opts?.conflict ?? 'rename',
      verify: opts?.verify ?? false,
    });
    const snap = this.env.transferList().find((j) => j.id === id);
    if (!snap) throw new Error(`Transfer ${id} started but is not listed`);
    return snap;
  }

  transferStatus(jobId?: string): TransferJobSnapshot[] {
    if (!this.env.transferList) throw new Error('Transfers are not available');
    const all = this.env.transferList();
    if (jobId === undefined) return all;
    const job = all.find((j) => j.id === jobId);
    if (!job) throw new Error(`Unknown transfer job '${jobId}' (finished and cleared, or never started)`);
    return [job];
  }

  async portForward(
    ref: string,
    remotePort: number,
    remoteHost?: string,
    localPort?: number,
  ): Promise<PortForwardInfo> {
    if (!this.env.openForward) throw new Error('Port forwarding is not available');
    return this.env.openForward(this.resolve(ref), remotePort, remoteHost, localPort);
  }

  listForwards(): PortForwardInfo[] {
    if (!this.env.listForwards) throw new Error('Port forwarding is not available');
    return this.env.listForwards();
  }

  closeForward(id: string): void {
    if (!this.env.closeForward) throw new Error('Port forwarding is not available');
    if (!this.env.closeForward(id)) {
      throw new Error(`Unknown forward '${id}' (already closed?) — see list_port_forwards`);
    }
  }

  async editFile(
    ref: string,
    path: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<{ count: number; bytes: number }> {
    const host = this.resolve(ref);
    const before = await this.env.readFile(host, path, 256 * 1024);
    const { content, count } = applyEdit(before, oldString, newString, replaceAll);
    await this.env.writeFile(host, path, content);
    return { count, bytes: Buffer.byteLength(content, 'utf8') };
  }
}
