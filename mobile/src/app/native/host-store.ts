import { sanitizeHost, uuid, type HostAuth, type HostConfig } from '@pear/core';
import type { AsyncCipher, AsyncKv } from './kv';

const HOSTS_KEY = 'pear.hosts';

type SecretPair = readonly ['password' | 'passphrase' | 'privateKey',
  'passwordEnc' | 'passphraseEnc' | 'privateKeyEnc'];

const SECRETS: readonly SecretPair[] = [
  ['password', 'passwordEnc'],
  ['passphrase', 'passphraseEnc'],
  ['privateKey', 'privateKeyEnc'],
] as const;

/**
 * The async twin of core's HostStore (hosts/store.ts) for Capacitor:
 * same write-only secret contract (undefined keeps, '' clears, value
 * replaces + encrypts) and the same sanitized views via core's
 * sanitizeHost — but storage is Preferences and the cipher crosses the
 * bridge to the Keystore, both async, which the sync core class cannot
 * absorb. Behavioral parity with the desktop store is the contract here.
 */
export class MobileHostStore {
  private hosts: HostConfig[] = [];

  private constructor(
    private readonly kv: AsyncKv,
    private readonly cipher: AsyncCipher,
  ) {}

  static async load(kv: AsyncKv, cipher: AsyncCipher): Promise<MobileHostStore> {
    const store = new MobileHostStore(kv, cipher);
    try {
      const raw = await kv.get(HOSTS_KEY);
      store.hosts = raw ? (JSON.parse(raw) as HostConfig[]) : [];
    } catch {
      store.hosts = [];
    }
    let changed = false;
    for (const h of store.hosts) changed = store.normalize(h) || changed;
    if (changed) await store.persist();
    return store;
  }

  list(): HostConfig[] {
    return this.hosts.map((h) => ({ ...h }));
  }

  listSanitized(): HostConfig[] {
    return this.hosts.map((h) => sanitizeHost(h));
  }

  get(id: string): HostConfig | undefined {
    return this.hosts.find((h) => h.id === id);
  }

  async upsert(host: Omit<HostConfig, 'id'> & { id?: string }): Promise<HostConfig> {
    const existing = host.id ? this.get(host.id) : undefined;
    const saved: HostConfig = { ...host, id: host.id || uuid() };
    saved.auth = await this.mergeAuth(existing?.auth, host.auth);
    this.normalize(saved);
    if (existing) {
      this.hosts = this.hosts.map((h) => (h.id === saved.id ? saved : h));
    } else {
      this.hosts.push(saved);
    }
    await this.persist();
    return sanitizeHost(saved);
  }

  async remove(id: string): Promise<void> {
    this.hosts = this.hosts.filter((h) => h.id !== id);
    await this.persist();
  }

  /** Patch non-auth fields (kind, facets) without touching secrets. */
  async patch(id: string, patch: Partial<Omit<HostConfig, 'id' | 'auth'>>): Promise<void> {
    const host = this.get(id);
    if (!host) return;
    Object.assign(host, patch);
    await this.persist();
  }

  /** Connect-time view: throwaway copy with secrets decrypted from *Enc. */
  async decryptAuth(config: HostConfig): Promise<HostConfig> {
    const auth = config.auth;
    if (!auth) return { ...config };
    const out: HostAuth = { ...auth };
    for (const [plain, enc] of SECRETS) {
      if (!out[plain] && out[enc]) {
        try {
          out[plain] = await this.cipher.decrypt(out[enc]);
        } catch {
          /* fall back to prompt-at-connect */
        }
      }
    }
    return { ...config, auth: out };
  }

  private async mergeAuth(
    prev: HostAuth | undefined,
    next: HostAuth | undefined,
  ): Promise<HostAuth | undefined> {
    if (!next) return prev ? { ...prev } : undefined;
    const auth: HostAuth = { ...next };
    delete auth.passwordEnc;
    delete auth.passphraseEnc;
    delete auth.privateKeyEnc;
    delete auth.hasPassword;
    delete auth.hasPassphrase;
    delete auth.hasPrivateKey;
    for (const [plain, enc] of SECRETS) {
      const incoming = auth[plain];
      if (incoming === undefined) {
        if (prev?.[enc]) auth[enc] = prev[enc];
        if (prev?.[plain]) auth[plain] = prev[plain];
        continue;
      }
      if (incoming === '') {
        delete auth[plain];
        continue;
      }
      if (await this.cipher.available()) {
        auth[enc] = await this.cipher.encrypt(incoming);
        delete auth[plain];
      }
      // No cipher: keep plaintext in memory for the session; persist() strips it.
    }
    return auth;
  }

  private normalize(h: HostConfig): boolean {
    let changed = false;
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
    return changed;
  }

  private async persist(): Promise<void> {
    const stripped = this.hosts.map((h) => {
      if (!h.auth) return h;
      const auth = { ...h.auth };
      delete auth.password;
      delete auth.passphrase;
      delete auth.privateKey;
      delete auth.hasPassword;
      delete auth.hasPassphrase;
      delete auth.hasPrivateKey;
      return { ...h, auth };
    });
    await this.kv.set(HOSTS_KEY, JSON.stringify(stripped));
  }
}
