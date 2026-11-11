import type {
  ClaudeStatus,
  ContainerStatsMap,
  DirListing,
  DockerDiskRow,
  FileEntry,
  HostConfig,
  HostGroup,
  HostVitalsSample,
  OrchAction,
  OrchActionResult,
  Orchestration,
  ProbeResult,
  SubHostTarget,
  SwarmTaskInfo,
  TaskLogChunk,
  TermSize,
} from './types';
import type { HistoryEntry } from './history/store';
import type { HostKeyPrompt } from './ssh/known-hosts';
import type { SshConfigEntry } from './hosts/ssh-config';
import type { ConflictPolicy, TransferJobSnapshot, TransferRequest } from './transfers/engine';
import type { FileInfo } from './fs/info';
import type { PermsChange } from './fs/perms';
import type { ArchiveFormat, ArchiveTools } from './fs/archive';
import type { FsOpSnapshot } from './fs/ops-runner';
import type {
  ClaudeChatEvent,
  ClaudeChatState,
  ClaudeFocus,
  ClaudePermissionAnswer,
  ClaudeSessionMeta,
  ClaudeUiRequest,
  ClaudeUiResponse,
} from './claude/events';

/**
 * The bridge surface the desktop shell exposes to the renderer
 * (window.pear). Types only — implemented in the preload script.
 */
export interface PearApi {
  hosts: {
    /**
     * Sanitized views: secrets never cross the bridge — auth carries only
     * hasPassword / hasPassphrase flags. Password/passphrase fields on upsert
     * are write-only: undefined keeps the stored secret, '' clears it.
     */
    list(): Promise<HostConfig[]>;
    upsert(host: Omit<HostConfig, 'id'> & { id?: string }): Promise<HostConfig>;
    remove(id: string): Promise<void>;
    /**
     * Register the machine Pear runs on as a host (hostname/user filled in
     * by the shell). Idempotent: returns the existing local host if present.
     */
    addLocal(): Promise<HostConfig>;
    /**
     * Concrete Host entries parsed from ~/.ssh/config. Never rejects —
     * a missing or unreadable config yields [].
     */
    sshConfigEntries(): Promise<SshConfigEntry[]>;
    /**
     * Test one endpoint for a live sshd. Never rejects — failures come back
     * in the result (untested addresses are routine, not exceptional).
     */
    probe(endpoint: { addr: string; port: number }, timeoutMs?: number): Promise<ProbeResult>;
  };
  hostGroups: {
    /** Host groups — "Workspaces" in the UI. */
    list(): Promise<HostGroup[]>;
    upsert(group: Omit<HostGroup, 'id'> & { id?: string }): Promise<HostGroup>;
    remove(id: string): Promise<void>;
    setMembership(hostId: string, groupId: string, member: boolean): Promise<void>;
  };
  term: {
    /**
     * Opens a shell on the host; returns the terminal id. cwd overrides the
     * host's default working directory for this terminal only.
     */
    open(
      hostId: string,
      size: TermSize,
      opts?: { password?: string; cwd?: string },
    ): Promise<string>;
    write(termId: string, data: string): void;
    resize(termId: string, size: TermSize): void;
    close(termId: string): void;
    onData(cb: (termId: string, data: string) => void): () => void;
    onExit(cb: (termId: string) => void): () => void;
  };
  fs: {
    /**
     * List a remote directory. '~' resolves to the login home. A password
     * authenticates the connection when keys/agent can't (same contract as
     * term.open) — files-first tabs connect through here.
     */
    list(hostId: string, path: string, password?: string): Promise<DirListing>;
    /** Read a remote file as UTF-8 (size-capped for the editor). */
    read(hostId: string, path: string): Promise<string>;
    /** Overwrite a remote file with UTF-8 content. */
    write(hostId: string, path: string, content: string): Promise<void>;
    /**
     * Ask the user to pick local files (native dialog) and queue their upload
     * into remoteDir as a transfer job. Resolves once queued (or cancelled).
     */
    upload(
      hostId: string,
      remoteDir: string,
      conflict: ConflictPolicy,
      verify: boolean,
    ): Promise<void>;
    /** lstat of a single path; null when it does not exist. */
    stat(hostId: string, path: string): Promise<FileEntry | null>;
    mkdir(hostId: string, path: string): Promise<void>;
    /** Delete a path; directories require `recursive` unless empty. */
    remove(hostId: string, path: string, recursive?: boolean): Promise<void>;
    /** Same-host move; overwrites an existing destination. */
    rename(hostId: string, oldPath: string, newPath: string): Promise<void>;
    /** Same-host recursive copy. */
    copy(hostId: string, src: string, dest: string): Promise<void>;
    /** Full lstat view of one path; `deep` also totals a directory (du + find). */
    info(hostId: string, path: string, deep?: boolean): Promise<FileInfo>;
    /** chown (owner/group) then chmod (mode); `recursive` applies -R to both. */
    setPerms(hostId: string, path: string, change: PermsChange): Promise<void>;
  };
  /**
   * Long shell operations on a host (archive extract/compress). They run in
   * the background like transfers: start returns an op id, progress arrives
   * via onUpdate, and cancel closes the command's channel.
   */
  ops: {
    /** Which archive tools the host has (cached per host for a few minutes). */
    tools(hostId: string): Promise<ArchiveTools>;
    /** Unpack an archive into destDir (created if missing). Returns the op id. */
    extract(hostId: string, archivePath: string, destDir: string): Promise<string>;
    /** Pack `names` from `dir` into dir/archiveName. Returns the op id. */
    compress(
      hostId: string,
      dir: string,
      names: string[],
      archiveName: string,
      format: ArchiveFormat,
    ): Promise<string>;
    cancel(id: string): void;
    list(): Promise<FsOpSnapshot[]>;
    clearFinished(): void;
    onUpdate(cb: (op: FsOpSnapshot) => void): () => void;
  };
  transfers: {
    /**
     * Queue a transfer between hosts (or the local machine, hostId null).
     * Cross-host jobs relay through a local staging dir. Returns the job id;
     * progress arrives via onUpdate.
     */
    start(req: TransferRequest): Promise<string>;
    /** "Download to my machine": queue a copy into the OS Downloads folder. */
    download(
      srcHostId: string,
      srcDir: string,
      names: string[],
      conflict: ConflictPolicy,
      verify: boolean,
    ): Promise<string>;
    cancel(id: string): void;
    list(): Promise<TransferJobSnapshot[]>;
    clearFinished(): void;
    setMaxParallel(n: number): void;
    onUpdate(cb: (job: TransferJobSnapshot) => void): () => void;
    /**
     * Absolute path of a File dropped from the OS (Electron webUtils).
     * Typed unknown because core carries no DOM lib.
     */
    pathForFile(file: unknown): string;
  };
  subhosts: {
    /** Current session-scoped (unpinned) sub-hosts. */
    list(): Promise<HostConfig[]>;
    /**
     * Probe the target through the parent's connection and register an
     * ephemeral sub-host; every hostId-keyed feature works on the result.
     */
    jumpIn(parentId: string, target: SubHostTarget, name: string): Promise<HostConfig>;
    /**
     * QEMU variant of jumpIn: VMs have no exec tunnel, so this detects the
     * guest's address via the guest agent and registers an ephemeral SSH host
     * tunneled through the PVE node (via). Rejects when the agent is missing
     * or reports no usable address.
     */
    jumpInVm(parentId: string, vmid: number, name: string): Promise<HostConfig>;
    /** Persist an ephemeral sub-host under its parent (same id). */
    pin(id: string): Promise<HostConfig>;
    /** Move a pinned sub-host back to ephemeral (same id). */
    unpin(id: string): Promise<HostConfig>;
  };
  orch: {
    /**
     * Detect the host kind if unknown (persisting it) and fetch the live
     * orchestration state: containers, swarm services, or Proxmox guests.
     */
    get(hostId: string): Promise<Orchestration>;
    /**
     * Run an action. Streaming actions (logs, console) are not executed —
     * the returned terminalCommand should be typed into the host terminal.
     */
    action(hostId: string, action: OrchAction): Promise<OrchActionResult>;
    /**
     * Task list for one swarm service (`docker service ps`), including
     * historical shutdown/failed entries.
     */
    serviceTasks(hostId: string, service: string): Promise<SwarmTaskInfo[]>;
    /**
     * One-shot log fetch for a single task. Follow is the renderer re-calling
     * with `since` set to the previous chunk's lastTs (inclusive — dedup).
     */
    taskLogs(
      hostId: string,
      taskId: string,
      opts?: { tail?: number; since?: string },
    ): Promise<TaskLogChunk>;
  };
  monitor: {
    /**
     * One raw vitals snapshot (cumulative CPU/net counters — the renderer
     * derives rates from consecutive samples). Rejects with a message
     * containing 'vitals unsupported' when the host has no /proc.
     */
    sample(hostId: string): Promise<HostVitalsSample>;
    /** `docker system df` — slow on busy hosts, fetch lazily, never per tick. */
    dockerDf(hostId: string): Promise<DockerDiskRow[]>;
    /** Live per-container cpu/mem, keyed by container id. */
    stats(hostId: string): Promise<ContainerStatsMap>;
  };
  history: {
    /**
     * The whole deduplicated history. Loaded once and matched in the renderer
     * so inline suggestions cost no IPC per keystroke.
     */
    list(): Promise<HistoryEntry[]>;
    /** Fire-and-forget: remember a command the user just ran. */
    record(hostId: string, command: string): void;
    /**
     * Read this host's shell history files (~/.bash_history and friends) and
     * merge them in. Never called on its own — the user opts in per the
     * "scan remote shell history" setting. Resolves with the new commands and
     * the files they came from.
     */
    importFromHost(hostId: string): Promise<{ added: number; files: string[] }>;
    /** Forget everything, or just one host's commands. */
    clear(hostId?: string): Promise<void>;
  };
  claude: {
    /**
     * Launch the user's `claude` CLI in Pear's workspace dir (a local PTY).
     * Returns a terminal id — IO rides the regular term channels
     * (term.write/resize/close/onData/onExit), same as any other terminal.
     */
    open(size: TermSize): Promise<string>;
    status(): Promise<ClaudeStatus>;
    // Chat mode: the same CLI driven over stream-json; Pear renders events.
    /** Send a user turn to the active conversation (starts one if needed). */
    chatSend(text: string): Promise<void>;
    /** Stop the running turn (the conversation itself survives). */
    chatInterrupt(): void;
    /** Answer a pending permission or question card. */
    chatAnswer(requestId: string, answer: ClaudePermissionAnswer): void;
    chatSetAutoApprove(on: boolean): void;
    /** Model for chat sessions (alias like 'sonnet'/'opus' or a full id);
     *  null = the CLI's default. Applies from the next message. */
    chatSetModel(model: string | null): void;
    chatSessions(): Promise<ClaudeSessionMeta[]>;
    /** Load a past session (returns its transcript) and continue it. */
    chatResume(sessionId: string): Promise<ClaudeChatEvent[]>;
    /**
     * The live conversation, read-only — for a client that (re)connects while
     * it is in progress. Optional: only embedders whose UI can come and go
     * independently of the runtime (pear-server) need it.
     */
    chatState?(): Promise<ClaudeChatState>;
    /** Drop the active conversation; the next send starts fresh. */
    chatNew(): Promise<void>;
    /** Mirror the focused workspace location so the MCP tools can mark the
     *  focused host in list_hosts (null when nothing is open). */
    setFocus(focus: ClaudeFocus | null): void;
    onEvent(cb: (event: ClaudeChatEvent) => void): () => void;
    /** Main asks the renderer to serve a UI-facing MCP tool (read_terminal,
     *  reveal_in_app); the handler must always call uiRespond with the id. */
    onUiRequest(cb: (request: ClaudeUiRequest) => void): () => void;
    uiRespond(response: ClaudeUiResponse): void;
  };
  /**
   * Trust-on-first-use host keys, for embedders that verify them. A connect
   * to a host whose key is not on file rejects with code UNKNOWN_HOST_KEY or
   * HOST_KEY_CHANGED and the prompt as `data`; the UI asks, calls trust, and
   * retries. Absent where keys are not verified (desktop) or where the
   * transport owns the dance itself (Android).
   */
  hostKeys?: {
    trust(prompt: HostKeyPrompt): Promise<void>;
    forget(host: string, port: number): Promise<void>;
  };
  onHostDisconnected(cb: (hostId: string) => void): () => void;
}
