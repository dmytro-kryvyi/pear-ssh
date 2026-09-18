import { Injectable, inject, signal } from '@angular/core';
import type { RemoteControl, RemoteUpdate } from '@pear/core';
import { Pear } from '../pear';

/**
 * What the shell needs to know when the bridge is a pear-server rather than
 * Electron: is the link up, and which features did the server switch off.
 * Inert (link always up, everything allowed) under Electron.
 */
@Injectable({ providedIn: 'root' })
export class RemoteLink {
  private readonly pear = inject(Pear);
  readonly remote: RemoteControl | undefined = this.pear.available
    ? (this.pear.api as { remote?: RemoteControl }).remote
    : undefined;

  /** True once the link has been down long enough to be worth mentioning. */
  readonly down = signal(false);
  /** The server machine offered as a host ("Add this computer"). */
  readonly localHost = signal(true);
  /** The server's release version, and a newer one if the server knows of it. */
  readonly version = signal<string | null>(null);
  readonly update = signal<RemoteUpdate | null>(null);

  constructor() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = (): void => {
      const features = this.remote?.hello()?.features;
      if (features) this.localHost.set(features['localHost'] !== false);
      this.version.set(this.remote?.hello()?.version ?? null);
    };
    apply();
    this.remote?.onUpdateAvailable((update) => this.update.set(update));
    this.remote?.onState((state) => {
      clearTimeout(timer);
      // A resume blip reconnects in well under a second; don't flash for it.
      if (state === 'reconnecting') timer = setTimeout(() => this.down.set(true), 700);
      else this.down.set(false);
      if (state === 'open') apply();
    });
  }
}
