import { Component, inject, signal } from '@angular/core';
import type { RemoteUpdate } from '@pear/core';
import { REMOTE } from './remote-state';

/**
 * What only exists when a pear-server serves the app: a note that a newer
 * server release is out, the way over to the desktop interface, and sign-out.
 * Renders nothing on Android or on the mock backend. Lives under the host list
 * in both shells (the phone's hosts screen, the tablet's rail).
 */
@Component({
  selector: 'pm-server-foot',
  template: `
    @if (remote) {
      @if (update(); as up) {
        <a class="update" [href]="up.url" target="_blank" rel="noopener noreferrer">
          Pear server {{ up.latest }} is available — update it on the server
        </a>
      }
      <div class="links">
        <button (click)="switchUi()">Desktop interface</button>
        @if (passwordAuth()) {
          <span>·</span>
          <button (click)="signOut()">Sign out</button>
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .update {
      display: block;
      margin: 14px 4px 0;
      padding: 10px 12px;
      border-radius: 10px;
      font-size: 12.5px;
      line-height: 1.4;
      text-align: center;
      color: var(--fg-1);
      background: var(--accent-soft);
      border: 1px solid var(--accent-line);
    }
    .links {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 10px;
      padding: 12px 0 8px;
      font-size: 12.5px;
      color: var(--fg-3);
    }
    .links button {
      color: var(--fg-2);
      padding: 8px 4px;
    }
  `,
})
export class PmServerFoot {
  protected readonly remote = inject(REMOTE, { optional: true });
  protected readonly update = signal<RemoteUpdate | null>(null);

  constructor() {
    this.remote?.onUpdateAvailable((u) => this.update.set(u));
  }

  protected passwordAuth(): boolean {
    return this.remote?.hello()?.features['passwordAuth'] === true;
  }

  /** boot.js (served by pear-server) reads ?ui= and remembers it per device. */
  protected switchUi(): void {
    location.assign('/?ui=desktop');
  }

  protected async signOut(): Promise<void> {
    await fetch('/api/logout', { method: 'POST' });
    location.assign('/login');
  }
}
