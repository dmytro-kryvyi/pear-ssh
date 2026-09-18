/** What a trust-on-first-use prompt shows; `knownFingerprint` set = the key CHANGED. */
export interface HostKeyPrompt {
  host: string;
  port: number;
  keyType: string;
  /** `SHA256:<base64, unpadded>` — the form `ssh-keygen -lf` prints. */
  fingerprint: string;
  knownFingerprint?: string;
}

/** UI hook that answers host-key prompts. Resolve true to trust. */
export interface HostKeyGate {
  confirm(prompt: HostKeyPrompt): Promise<boolean>;
}

export type HostKeyErrorCode = 'UNKNOWN_HOST_KEY' | 'HOST_KEY_CHANGED';

/**
 * A connect refused because the server's key is not (or no longer) the one on
 * file. It carries everything a UI needs to ask the user — the transport never
 * waits on a human mid-handshake (that would hold the SSH ready-timeout open);
 * it fails fast, and the caller retries after `trust`.
 */
export class HostKeyError extends Error {
  constructor(
    readonly code: HostKeyErrorCode,
    readonly data: HostKeyPrompt,
  ) {
    super(
      code === 'HOST_KEY_CHANGED'
        ? `Host key for ${data.host}:${data.port} has CHANGED (now ${data.fingerprint}). ` +
            `This can mean the server was reinstalled — or that someone is intercepting the connection.`
        : `Unknown host key for ${data.host}:${data.port}: ${data.fingerprint}`,
    );
    this.name = 'HostKeyError';
  }
}

export interface KnownHostsStorage {
  read(): string | null;
  write(data: string): void;
}

interface Entry {
  fingerprint: string;
  keyType: string;
  addedAt: number;
}

/** Pear's own known-hosts file: `host:port` → the one key we accept there. */
export class KnownHosts {
  private entries: Record<string, Entry> = {};

  constructor(private readonly storage: KnownHostsStorage) {
    try {
      this.entries = JSON.parse(storage.read() ?? '{}') as Record<string, Entry>;
    } catch {
      this.entries = {};
    }
  }

  /** Throws HostKeyError unless `fingerprint` is the key on file. */
  verify(host: string, port: number, keyType: string, fingerprint: string): void {
    const known = this.entries[keyOf(host, port)];
    if (known?.fingerprint === fingerprint) return;
    throw known
      ? new HostKeyError('HOST_KEY_CHANGED', {
          host,
          port,
          keyType,
          fingerprint,
          knownFingerprint: known.fingerprint,
        })
      : new HostKeyError('UNKNOWN_HOST_KEY', { host, port, keyType, fingerprint });
  }

  trust(prompt: Pick<HostKeyPrompt, 'host' | 'port' | 'keyType' | 'fingerprint'>): void {
    if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(prompt.fingerprint)) {
      throw new Error('Not a SHA256 host key fingerprint');
    }
    this.entries[keyOf(prompt.host, prompt.port)] = {
      fingerprint: prompt.fingerprint,
      keyType: String(prompt.keyType),
      addedAt: Date.now(),
    };
    this.persist();
  }

  forget(host: string, port: number): void {
    delete this.entries[keyOf(host, port)];
    this.persist();
  }

  private persist(): void {
    this.storage.write(JSON.stringify(this.entries, null, 2));
  }
}

function keyOf(host: string, port: number): string {
  return `${host.toLowerCase()}:${port}`;
}
