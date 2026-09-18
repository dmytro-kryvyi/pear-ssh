import { inject, type Provider } from '@angular/core';
import { PEAR_BACKEND } from '../backend';
import { ClaudeLive } from '../claude/claude-live';
import { CLAUDE_STORE } from '../claude/claude-store';
import { HostKeys } from '../native/host-keys';
import { connectToPearServer, type PearServerBackend } from './connect';
import { REMOTE } from './remote-state';

/**
 * PEAR_BACKEND = a pear-server on the other end of a WebSocket. This is how
 * the app runs where no SSH plugin can exist — an iPad's home screen, any
 * browser. SSH sessions, secrets and the Claude CLI all live on the server.
 */
export function provideRemoteBackend(): Provider[] {
  return [
    {
      provide: PEAR_BACKEND,
      // The server verifies SSH host keys; its prompts land in the same sheet
      // the Android transport uses (PmHostKeySheet, mounted in the root).
      useFactory: () => connectToPearServer(inject(HostKeys)),
    },
    {
      provide: REMOTE,
      useFactory: () => (inject(PEAR_BACKEND) as PearServerBackend).remote,
    },
    // The server emits the same ClaudeChatEvent stream the native backend
    // does, so the live store renders it unchanged.
    { provide: CLAUDE_STORE, useExisting: ClaudeLive },
  ];
}
