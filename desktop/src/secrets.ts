import { safeStorage } from 'electron';
import type { SecretCipher } from '@pear/core';

/**
 * SecretCipher backed by Electron safeStorage (OS keychain / keyring).
 *
 * On Linux without a real keyring the backend degrades to `basic_text` — a
 * hardcoded-key obfuscation, not encryption. We treat that as unavailable, so
 * secrets stay prompt-at-connect rather than pretending to be protected.
 */
export class SafeStorageCipher implements SecretCipher {
  private warned = false;

  available(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
      if (!this.warned) {
        this.warned = true;
        console.warn(
          '[secrets] no OS keyring available (basic_text backend) — passwords will not be saved',
        );
      }
      return false;
    }
    return true;
  }

  encrypt(plain: string): string {
    return safeStorage.encryptString(plain).toString('base64');
  }

  decrypt(cipher: string): string {
    return safeStorage.decryptString(Buffer.from(cipher, 'base64'));
  }
}
