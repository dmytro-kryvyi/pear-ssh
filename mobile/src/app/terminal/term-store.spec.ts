import { describe, expect, it, vi } from 'vitest';
import { Injector } from '@angular/core';
import type { PearApi } from '@pear/core';

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    onData() {}
    onResize() {}
    loadAddon() {}
    write() {}
    open() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.stubGlobal('document', {
  createElement: () => ({ className: '', isConnected: false, remove() {}, appendChild() {} }),
});

import { TermStore } from './term-store';
import { PEAR_BACKEND } from '../backend';

function makeStore() {
  let opens = 0;
  let resolveOpen!: (termId: string) => void;
  const openP = new Promise<string>((r) => (resolveOpen = r));
  const backend = {
    term: {
      open: () => {
        opens++;
        return openP;
      },
      write: () => {},
      resize: () => {},
      close: () => {},
      onData: () => {},
      onExit: () => {},
    },
  } as unknown as PearApi;
  const store = Injector.create({
    providers: [
      { provide: PEAR_BACKEND, useValue: backend },
      { provide: TermStore, useClass: TermStore, deps: [] },
    ],
  }).get(TermStore);
  return { store, opens: () => opens, resolveOpen };
}

describe('TermStore', () => {
  it('concurrent ensure() calls share one PTY open', async () => {
    const { store, opens, resolveOpen } = makeStore();
    // The real-world race: orchAction's terms.run() and the terminal
    // screen's mount effect both ensure() while the open is in flight.
    const first = store.ensure('h1');
    const second = store.ensure('h1');
    resolveOpen('t1');
    const [a, b] = await Promise.all([first, second]);
    expect(opens()).toBe(1);
    expect(a).toBe(b);
    expect(a.termId).toBe('t1');
  });
});
