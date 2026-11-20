import { Injectable, signal } from '@angular/core';

export type NoticeTone = 'info' | 'error';

export interface Notice {
  text: string;
  tone: NoticeTone;
}

/**
 * The one transient toast at the bottom of the window. Errors linger long
 * enough to read; info notices ("Copied …") flash and go.
 */
@Injectable({ providedIn: 'root' })
export class Notices {
  readonly current = signal<Notice | null>(null);
  private timer: ReturnType<typeof setTimeout> | null = null;

  show(text: string, tone: NoticeTone = 'info', ms = tone === 'error' ? 6000 : 1600): void {
    this.current.set({ text, tone });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.current.set(null), ms);
  }

  dismiss(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current.set(null);
  }
}
