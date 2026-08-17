import { inject, type Provider } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { PEAR_BACKEND } from '../backend';
import { ClaudeLive } from '../claude/claude-live';
import { CLAUDE_STORE } from '../claude/claude-store';
import { createNativeBackend } from './backend';
import { HostKeys } from './host-keys';
import { PearSsh } from './pear-ssh';

/** PEAR_BACKEND = the real thing: PearSsh plugin + Preferences + Keystore. */
export function provideNativeBackend(): Provider[] {
  return [
    {
      provide: PEAR_BACKEND,
      useFactory: () =>
        createNativeBackend({
          plugin: PearSsh,
          gate: inject(HostKeys),
          kv: {
            get: async (key) => (await Preferences.get({ key })).value,
            set: async (key, value) => {
              await Preferences.set({ key, value });
            },
          },
          cipher: {
            available: async () => (await PearSsh.cipherAvailable()).available,
            encrypt: async (plain) => (await PearSsh.cipherEncrypt({ plain })).cipher,
            decrypt: async (cipher) => (await PearSsh.cipherDecrypt({ cipher })).plain,
          },
        }),
    },
    { provide: CLAUDE_STORE, useExisting: ClaudeLive },
  ];
}
