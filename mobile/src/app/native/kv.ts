import type { HostStorage } from '@pear/core';

/** Async key-value persistence (Capacitor Preferences on device). */
export interface AsyncKv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** Async secret cipher (the PearSsh Keystore cipher on device). */
export interface AsyncCipher {
  available(): Promise<boolean>;
  encrypt(plain: string): Promise<string>;
  decrypt(cipher: string): Promise<string>;
}

/**
 * Adapt one AsyncKv key to core's synchronous storage contract
 * (HostStorage/HistoryStorage): preload once, then serve reads from memory
 * and flush writes fire-and-forget. Lets core's HostGroupStore and
 * HistoryStore run unmodified on top of Capacitor Preferences.
 */
export async function syncStorage(kv: AsyncKv, key: string): Promise<HostStorage> {
  let cache = await kv.get(key);
  return {
    read: () => cache,
    write: (data: string) => {
      cache = data;
      void kv.set(key, data);
    },
  };
}
