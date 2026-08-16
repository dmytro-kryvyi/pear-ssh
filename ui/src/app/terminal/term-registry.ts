import { Injectable } from '@angular/core';

/**
 * Live terminal buffer readers, keyed by TermTab id. Each TerminalPane
 * registers a plain-text reader over its private xterm instance so the
 * Claude UI bridge can serve read_terminal without reaching into components.
 * Only tabs with a mounted xterm appear here — that's also what makes a tab
 * "readable" in list_terminals.
 */
@Injectable({ providedIn: 'root' })
export class TermRegistry {
  private readonly readers = new Map<string, (lines: number) => string>();

  register(tabId: string, read: (lines: number) => string): void {
    this.readers.set(tabId, read);
  }

  unregister(tabId: string): void {
    this.readers.delete(tabId);
  }

  has(tabId: string): boolean {
    return this.readers.has(tabId);
  }

  read(tabId: string, lines: number): string | null {
    const reader = this.readers.get(tabId);
    return reader ? reader(lines) : null;
  }
}
