import type {
  DirListing,
  FileEntry,
  HostConfig,
  OrchAction,
  OrchActionResult,
  Orchestration,
  SubHostTarget,
  TermSize,
} from './types';
import type { HistoryEntry } from './history/store';
import type { ConflictPolicy, TransferJobSnapshot, TransferRequest } from './transfers/engine';

/**
 * The bridge surface the desktop shell exposes to the renderer
 * (window.pear). Types only — implemented in the preload script.
 */
export interface PearApi {
  hosts: {
    list(): Promise<HostConfig[]>;
    upsert(host: Omit<HostConfig, 'id'> & { id?: string }): Promise<HostConfig>;
    remove(id: string): Promise<void>;
    /**
     * Register the machine Pear runs on as a host (hostname/user filled in
     * by the shell). Idempotent: returns the existing local host if present.
     */
    addLocal(): Promise<HostConfig>;
  };
  term: {
    /** Opens a shell on the host; returns the terminal id. */
    open(hostId: string, size: TermSize, password?: string): Promise<string>;
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
    upload(hostId: string, remoteDir: string, conflict: ConflictPolicy): Promise<void>;
    /** lstat of a single path; null when it does not exist. */
    stat(hostId: string, path: string): Promise<FileEntry | null>;
    mkdir(hostId: string, path: string): Promise<void>;
    /** Delete a path; directories require `recursive` unless empty. */
    remove(hostId: string, path: string, recursive?: boolean): Promise<void>;
    /** Same-host move; overwrites an existing destination. */
    rename(hostId: string, oldPath: string, newPath: string): Promise<void>;
    /** Same-host recursive copy. */
    copy(hostId: string, src: string, dest: string): Promise<void>;
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
    /** Persist an ephemeral sub-host under its parent (same id). */
    pin(id: string): Promise<HostConfig>;
    /** Move a pinned sub-host back to ephemeral (same id). */
    unpin(id: string): Promise<HostConfig>;
    /**
     * Detect a QEMU VM's address via the guest agent, for promoting it to a
     * real SSH host. Rejects when the agent is missing or reports no address.
     */
    vmIp(hostId: string, vmid: number): Promise<string>;
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
  onHostDisconnected(cb: (hostId: string) => void): () => void;
}
