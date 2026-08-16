import type { HostAuth, HostConfig } from '../types';
import { uuid } from '../uuid';

/**
 * Where the inventory JSON lives. Injected by the embedder: a file under
 * Electron's userData today, a daemon's config dir or Capacitor Preferences
 * tomorrow. `read` returns null when nothing has been stored yet.
 */
export interface HostStorage {
  read(): string | null;
  write(data: string): void;
}

/**
 * Encrypts secrets at rest. Injected by the embedder (Electron safeStorage in
 * the desktop app). When absent or unavailable, secrets are kept in memory for
 * the session but never written to disk.
 */
export interface SecretCipher {
  available(): boolean;
  /** plaintext -> base64 ciphertext */
  encrypt(plain: string): string;
  /** base64 ciphertext -> plaintext; throws if undecryptable */
  decrypt(cipher: string): string;
}

/**
 * Host inventory persisted as JSON through an injected HostStorage.
 *
 * Secrets: `auth.password` / `auth.passphrase` are write-only — upsert encrypts
 * them into `passwordEnc` / `passphraseEnc` (or keeps them in memory only when
 * no cipher is available) and persist() strips the plaintext. The renderer gets
 * `listSanitized()` views that carry only `hasPassword` / `hasPassphrase`.
 */
export class HostStore {
  private hosts: HostConfig[] = [];

  constructor(
    private readonly storage: HostStorage,
    private readonly cipher?: SecretCipher,
  ) {
    let changed = false;
    try {
      const raw = storage.read();
      this.hosts = raw ? JSON.parse(raw) : [];
    } catch {
      this.hosts = [];
    }
    for (const h of this.hosts) changed = this.normalize(h) || changed;
    if (changed) this.persist();
  }

  list(): HostConfig[] {
    return this.hosts.map((h) => ({ ...h }));
  }

  /** Renderer-safe view: no plaintext, no ciphertext, just has-flags. */
  listSanitized(): HostConfig[] {
    return this.hosts.map((h) => sanitizeHost(h));
  }

  get(id: string): HostConfig | undefined {
    return this.hosts.find((h) => h.id === id);
  }

  upsert(host: Omit<HostConfig, 'id'> & { id?: string }): HostConfig {
    const existing = host.id ? this.get(host.id) : undefined;
    const saved: HostConfig = { ...host, id: host.id ?? uuid() };
    saved.auth = this.mergeAuth(existing?.auth, host.auth);
    this.normalize(saved);
    if (existing) {
      this.hosts = this.hosts.map((h) => (h.id === saved.id ? saved : h));
    } else {
      this.hosts.push(saved);
    }
    this.persist();
    return sanitizeHost(saved);
  }

  remove(id: string): void {
    this.hosts = this.hosts.filter((h) => h.id !== id);
    this.persist();
  }

  /**
   * Connect-time view: a throwaway copy with secrets decrypted from *Enc.
   * Undecryptable ciphertext (keyring changed) degrades to "no secret" so the
   * caller falls back to prompting, never throws.
   */
  decryptAuth(config: HostConfig): HostConfig {
    const auth = config.auth;
    if (!auth) return { ...config };
    const out: HostAuth = { ...auth };
    if (!out.password && out.passwordEnc && this.cipher) {
      try {
        out.password = this.cipher.decrypt(out.passwordEnc);
      } catch {
        /* fall back to prompt-at-connect */
      }
    }
    if (!out.passphrase && out.passphraseEnc && this.cipher) {
      try {
        out.passphrase = this.cipher.decrypt(out.passphraseEnc);
      } catch {
        /* fall back to prompt-at-connect */
      }
    }
    return { ...config, auth: out };
  }

  /**
   * Write-only secret merge: undefined preserves the stored secret, '' clears
   * it, anything else replaces it (encrypted when the cipher allows). Incoming
   * ciphertext / has-flags from callers are never trusted.
   */
  private mergeAuth(prev: HostAuth | undefined, next: HostAuth | undefined): HostAuth | undefined {
    if (!next) return prev ? { ...prev } : undefined;
    const auth: HostAuth = { ...next };
    delete auth.passwordEnc;
    delete auth.passphraseEnc;
    delete auth.hasPassword;
    delete auth.hasPassphrase;
    this.mergeSecret(auth, prev, 'password', 'passwordEnc');
    this.mergeSecret(auth, prev, 'passphrase', 'passphraseEnc');
    return auth;
  }

  private mergeSecret(
    auth: HostAuth,
    prev: HostAuth | undefined,
    plain: 'password' | 'passphrase',
    enc: 'passwordEnc' | 'passphraseEnc',
  ): void {
    const incoming = auth[plain];
    if (incoming === undefined) {
      // Preserve whatever the store already holds (ciphertext or session-only plaintext).
      if (prev?.[enc]) auth[enc] = prev[enc];
      if (prev?.[plain]) auth[plain] = prev[plain];
      return;
    }
    if (incoming === '') {
      delete auth[plain];
      return;
    }
    if (this.cipher?.available()) {
      auth[enc] = this.cipher.encrypt(incoming);
      delete auth[plain];
    }
    // No cipher: keep the plaintext in memory for this session; persist() strips it.
  }

  /**
   * Bring a record up to the current shape. Returns true if anything changed
   * in a way that should be flushed to disk.
   */
  private normalize(h: HostConfig): boolean {
    let changed = false;
    if (h.tag && !h.tags?.length) {
      h.tags = [h.tag];
      changed = true;
    }
    if (h.tags?.length) {
      if (h.tag !== undefined) {
        delete h.tag;
        changed = true;
      }
    }
    if (!h.local && !h.parentId) {
      if (!h.endpoints?.length) {
        h.endpoints = [{ id: uuid(), addr: h.host, port: h.port }];
        changed = true;
      }
      const primary = h.endpoints[0];
      if (h.host !== primary.addr || h.port !== primary.port) {
        h.host = primary.addr;
        h.port = primary.port;
        changed = true;
      }
    }
    // Plaintext secrets loaded from an old inventory: encrypt when possible.
    if (h.auth) {
      for (const [plain, enc] of [
        ['passphrase', 'passphraseEnc'],
        ['password', 'passwordEnc'],
      ] as const) {
        const value = h.auth[plain];
        if (value && !h.auth[enc] && this.cipher?.available()) {
          h.auth[enc] = this.cipher.encrypt(value);
          delete h.auth[plain];
          changed = true;
        }
      }
    }
    return changed;
  }

  private persist(): void {
    const sanitized = this.hosts.map((h) => ({
      ...h,
      auth: h.auth ? stripPlaintext(h.auth) : undefined,
    }));
    this.storage.write(JSON.stringify(sanitized, null, 2));
  }
}

function stripPlaintext(auth: HostAuth): HostAuth {
  const out = { ...auth };
  delete out.password;
  delete out.passphrase;
  delete out.hasPassword;
  delete out.hasPassphrase;
  return out;
}

/** Strip secrets entirely, keeping only has-flags for the UI. */
export function sanitizeHost(h: HostConfig): HostConfig {
  if (!h.auth) return { ...h };
  const auth: HostAuth = { ...h.auth };
  const hasPassword = Boolean(auth.password || auth.passwordEnc);
  const hasPassphrase = Boolean(auth.passphrase || auth.passphraseEnc);
  delete auth.password;
  delete auth.passphrase;
  delete auth.passwordEnc;
  delete auth.passphraseEnc;
  if (hasPassword) auth.hasPassword = true;
  if (hasPassphrase) auth.hasPassphrase = true;
  return { ...h, auth };
}
