import { InjectionToken, Provider } from '@angular/core';
import type { PearApi } from '@pear/core';

/**
 * The backend seam for the mobile app. Same surface as the desktop bridge
 * (PearApi), provided via DI instead of window.pear so shells can swap
 * implementations: stub (M0) → in-memory mock (M1) → native SSH plugin (M3)
 * → remote Pear server (future).
 */
export const PEAR_BACKEND = new InjectionToken<PearApi>('PEAR_BACKEND');

const fail = (what: string) => () =>
  Promise.reject(new Error(`PearBackend stub: ${what} not implemented`));
const noop = () => {};
/** Subscriptions hand back an unsubscribe that does nothing. */
const never = () => noop;

/** Boot-only stand-in: empty lists, rejecting mutations, silent streams. */
export function createStubBackend(): PearApi {
  return {
    hosts: {
      list: async () => [],
      upsert: fail('hosts.upsert'),
      remove: fail('hosts.remove'),
      addLocal: fail('hosts.addLocal'),
      // No ~/.ssh/config to read off-desktop; the API contract is "never rejects".
      sshConfigEntries: async () => [],
      probe: async () => ({ ok: false, error: 'unreachable', detail: 'stub backend' }),
    },
    hostGroups: {
      list: async () => [],
      upsert: fail('hostGroups.upsert'),
      remove: fail('hostGroups.remove'),
      setMembership: fail('hostGroups.setMembership'),
    },
    term: {
      open: fail('term.open'),
      write: noop,
      resize: noop,
      close: noop,
      onData: never,
      onExit: never,
    },
    fs: {
      list: fail('fs.list'),
      read: fail('fs.read'),
      write: fail('fs.write'),
      upload: fail('fs.upload'),
      stat: async () => null,
      mkdir: fail('fs.mkdir'),
      remove: fail('fs.remove'),
      rename: fail('fs.rename'),
      copy: fail('fs.copy'),
    },
    transfers: {
      start: fail('transfers.start'),
      download: fail('transfers.download'),
      cancel: noop,
      list: async () => [],
      clearFinished: noop,
      setMaxParallel: noop,
      onUpdate: never,
      pathForFile: () => {
        throw new Error('PearBackend stub: transfers.pathForFile not implemented');
      },
    },
    subhosts: {
      list: async () => [],
      jumpIn: fail('subhosts.jumpIn'),
      jumpInVm: fail('subhosts.jumpInVm'),
      pin: fail('subhosts.pin'),
      unpin: fail('subhosts.unpin'),
    },
    orch: {
      get: fail('orch.get'),
      action: fail('orch.action'),
      serviceTasks: fail('orch.serviceTasks'),
      taskLogs: fail('orch.taskLogs'),
    },
    monitor: {
      sample: fail('monitor.sample'),
      dockerDf: fail('monitor.dockerDf'),
      stats: fail('monitor.stats'),
    },
    history: {
      list: async () => [],
      record: noop,
      importFromHost: fail('history.importFromHost'),
      clear: async () => {},
    },
    claude: {
      open: fail('claude.open'),
      status: fail('claude.status'),
      chatSend: fail('claude.chatSend'),
      chatInterrupt: noop,
      chatAnswer: noop,
      chatSetAutoApprove: noop,
      chatSetModel: noop,
      chatSessions: async () => [],
      chatResume: fail('claude.chatResume'),
      chatNew: async () => {},
      setFocus: noop,
      onEvent: never,
      onUiRequest: never,
      uiRespond: noop,
    },
    onHostDisconnected: never,
  };
}

export function provideStubBackend(): Provider {
  return { provide: PEAR_BACKEND, useFactory: createStubBackend };
}
