import { Component, inject, signal } from '@angular/core';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { PmHostKeySheet } from './native/host-key-sheet';
import { PmPhoneShell } from './shell/phone-shell';
import { PmTabletShell } from './shell/tablet-shell';
import { PearSession } from './state/session';

const TABLET_MIN_WIDTH = 900;

/** Root — picks the phone or tablet shell from the viewport width. */
@Component({
  selector: 'pm-root',
  imports: [PmPhoneShell, PmTabletShell, PmHostKeySheet],
  template: `
    @if (tablet()) {
      <pm-tablet-shell />
    } @else {
      <pm-phone-shell />
    }
    <pm-host-key-sheet />
  `,
  styles: ':host { display: block; height: 100dvh; }',
})
export class App {
  protected readonly tablet = signal(window.innerWidth >= TABLET_MIN_WIDTH);
  private readonly session = inject(PearSession);

  constructor() {
    window.addEventListener('resize', () =>
      this.tablet.set(window.innerWidth >= TABLET_MIN_WIDTH),
    );
    // Reconnect-on-resume (M3 lifecycle): transports lazily redial on the
    // next operation, so resuming just refreshes the active host's data —
    // which re-establishes the session in the background if Android killed it.
    if (Capacitor.isNativePlatform()) {
      void CapApp.addListener('resume', () => {
        if (this.session.activeHostId()) void this.session.refreshOrch();
      });
    }
  }
}
