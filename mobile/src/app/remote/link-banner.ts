import { Component, inject, signal } from '@angular/core';
import { REMOTE } from './remote-state';

/** A thin strip while the link to pear-server is down. Sessions are safe on
 *  the server meanwhile — this only explains why the screen went quiet. */
@Component({
  selector: 'pm-link-banner',
  template: `
    @if (down()) {
      <div class="bar" role="status">Reconnecting to Pear server…</div>
    }
  `,
  styles: `
    .bar {
      position: fixed;
      z-index: 1000;
      left: 0;
      right: 0;
      top: 0;
      padding: calc(4px + var(--safe-top)) 12px 4px;
      font: 500 12px var(--ui);
      text-align: center;
      color: var(--bg-0);
      background: var(--warn);
    }
  `,
})
export class PmLinkBanner {
  private readonly remote = inject(REMOTE, { optional: true });
  protected readonly down = signal(false);

  constructor() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.remote?.onState((state) => {
      clearTimeout(timer);
      // A resume blip reconnects in well under a second; don't flash for it.
      if (state === 'reconnecting') timer = setTimeout(() => this.down.set(true), 700);
      else this.down.set(false);
    });
  }
}
