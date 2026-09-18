import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SecretCipher } from '@pear/core';

/**
 * SecretCipher for a headless box, where there is no OS keychain to lean on:
 * AES-256-GCM under a key that lives beside the data (0600) or arrives via
 * PEAR_SECRET_KEY (systemd credentials, Docker secrets).
 *
 * Be clear about what this buys: a leaked hosts.json or backup is useless
 * without the key. It does nothing against someone who can already read files
 * as the server's user — that person can also just ask the running server.
 */
export class FileKeyCipher implements SecretCipher {
  private constructor(private readonly key: Buffer | null) {}

  /** `--no-store-secrets`: HostStore then keeps secrets in memory only and the
   *  UI prompts at connect — the same degradation desktop uses without a keyring. */
  static disabled(): FileKeyCipher {
    return new FileKeyCipher(null);
  }

  static fromEnvOrFile(keyFile: string, envKey = process.env.PEAR_SECRET_KEY): FileKeyCipher {
    if (envKey) {
      const key = Buffer.from(envKey, 'base64');
      if (key.length !== 32) throw new Error('PEAR_SECRET_KEY must be 32 bytes, base64-encoded');
      return new FileKeyCipher(key);
    }
    try {
      const key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
      if (key.length !== 32) throw new Error(`${keyFile} does not hold a 32-byte key`);
      return new FileKeyCipher(key);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const key = randomBytes(32);
    mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
    writeFileSync(keyFile, key.toString('base64') + '\n', { mode: 0o600 });
    chmodSync(keyFile, 0o600); // writeFileSync's mode is subject to umask
    return new FileKeyCipher(key);
  }

  available(): boolean {
    return this.key !== null;
  }

  encrypt(plain: string): string {
    if (!this.key) throw new Error('Secret storage is disabled');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    // One base64 blob, as the SecretCipher contract asks: version | iv | tag | ct.
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ct]).toString('base64');
  }

  decrypt(blob: string): string {
    if (!this.key) throw new Error('Secret storage is disabled');
    const raw = Buffer.from(blob, 'base64');
    if (raw.length < 1 + 12 + 16 || raw[0] !== 1) throw new Error('Unrecognised ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(1, 13));
    decipher.setAuthTag(raw.subarray(13, 29));
    return Buffer.concat([decipher.update(raw.subarray(29)), decipher.final()]).toString('utf8');
  }
}
