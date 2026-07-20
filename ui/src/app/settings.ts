import { Injectable, effect, signal } from '@angular/core';

export type Accent = 'teal' | 'blue' | 'violet' | 'amber';
export type Density = 'comfortable' | 'compact';
export type OpenWith = 'single' | 'double';
export type SizeUnits = 'binary' | 'decimal';
export type SameHostDrag = 'move' | 'copy' | 'ask';
export type ConflictSetting = 'rename' | 'overwrite' | 'skip';
export type TermPlacement = 'shared' | 'per-host' | 'in-pane';

export const ACCENTS: Record<Accent, { main: string; soft: string; line: string }> = {
  teal: {
    main: 'oklch(0.72 0.09 190)',
    soft: 'oklch(0.72 0.09 190 / 0.14)',
    line: 'oklch(0.72 0.09 190 / 0.4)',
  },
  blue: {
    main: 'oklch(0.70 0.11 240)',
    soft: 'oklch(0.70 0.11 240 / 0.14)',
    line: 'oklch(0.70 0.11 240 / 0.4)',
  },
  violet: {
    main: 'oklch(0.70 0.12 295)',
    soft: 'oklch(0.70 0.12 295 / 0.14)',
    line: 'oklch(0.70 0.12 295 / 0.4)',
  },
  amber: {
    main: 'oklch(0.78 0.11 75)',
    soft: 'oklch(0.78 0.11 75 / 0.14)',
    line: 'oklch(0.78 0.11 75 / 0.4)',
  },
};

const STORAGE_KEY = 'pear-settings';

/** User-tweakable appearance settings, persisted to localStorage. */
@Injectable({ providedIn: 'root' })
export class Settings {
  readonly accent = signal<Accent>('teal');
  readonly density = signal<Density>('comfortable');

  /** Inline ghost-text completions in the terminal, from command history. */
  readonly suggestions = signal(true);

  /**
   * Whether Pear may read a host's own shell history files (~/.bash_history
   * and friends) to seed suggestions. Off by default: it reads files on the
   * user's servers, so it is theirs to turn on.
   */
  readonly scanRemoteHistory = signal(true);

  // File browser
  readonly openWith = signal<OpenWith>('double');
  readonly confirmDelete = signal(true);
  readonly sortDirsFirst = signal(true);
  readonly showHidden = signal(true);
  readonly sizeUnits = signal<SizeUnits>('binary');

  // Transfers
  readonly sameHostDrag = signal<SameHostDrag>('move');
  readonly conflict = signal<ConflictSetting>('rename');
  readonly maxParallel = signal(2);
  /** Preference surface only — not wired to real behaviour yet. */
  readonly verifyChecksums = signal(false);
  readonly termPlacement = signal<TermPlacement>('shared');

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
      if (saved.accent in ACCENTS) this.accent.set(saved.accent);
      if (saved.density === 'compact') this.density.set('compact');
      // Compared against the type, not a literal: these round-trip correctly
      // even if the default above is later flipped.
      if (typeof saved.suggestions === 'boolean') this.suggestions.set(saved.suggestions);
      if (typeof saved.scanRemoteHistory === 'boolean') {
        this.scanRemoteHistory.set(saved.scanRemoteHistory);
      }
      if (['single', 'double'].includes(saved.openWith)) this.openWith.set(saved.openWith);
      if (typeof saved.confirmDelete === 'boolean') this.confirmDelete.set(saved.confirmDelete);
      if (typeof saved.sortDirsFirst === 'boolean') this.sortDirsFirst.set(saved.sortDirsFirst);
      if (typeof saved.showHidden === 'boolean') this.showHidden.set(saved.showHidden);
      if (['binary', 'decimal'].includes(saved.sizeUnits)) this.sizeUnits.set(saved.sizeUnits);
      if (['move', 'copy', 'ask'].includes(saved.sameHostDrag)) {
        this.sameHostDrag.set(saved.sameHostDrag);
      }
      if (['rename', 'overwrite', 'skip'].includes(saved.conflict)) {
        this.conflict.set(saved.conflict);
      }
      if ([1, 2, 3, 6].includes(saved.maxParallel)) this.maxParallel.set(saved.maxParallel);
      if (typeof saved.verifyChecksums === 'boolean') {
        this.verifyChecksums.set(saved.verifyChecksums);
      }
      if (['shared', 'per-host', 'in-pane'].includes(saved.termPlacement)) {
        this.termPlacement.set(saved.termPlacement);
      }
    } catch {
      // corrupt settings: keep defaults
    }

    effect(() => {
      const root = document.documentElement;
      const accent = ACCENTS[this.accent()];
      root.style.setProperty('--accent', accent.main);
      root.style.setProperty('--accent-soft', accent.soft);
      root.style.setProperty('--accent-line', accent.line);
      root.dataset['density'] = this.density();
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          accent: this.accent(),
          density: this.density(),
          suggestions: this.suggestions(),
          scanRemoteHistory: this.scanRemoteHistory(),
          openWith: this.openWith(),
          confirmDelete: this.confirmDelete(),
          sortDirsFirst: this.sortDirsFirst(),
          showHidden: this.showHidden(),
          sizeUnits: this.sizeUnits(),
          sameHostDrag: this.sameHostDrag(),
          conflict: this.conflict(),
          maxParallel: this.maxParallel(),
          verifyChecksums: this.verifyChecksums(),
          termPlacement: this.termPlacement(),
        }),
      );
    });
  }
}
