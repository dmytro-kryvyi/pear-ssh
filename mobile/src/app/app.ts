import { Component, inject, signal } from '@angular/core';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { PmHostKeySheet } from './native/host-key-sheet';
import { PmPhoneShell } from './shell/phone-shell';
import { PmTabletShell } from './shell/tablet-shell';
import { PmLinkBanner } from './remote/link-banner';
import { REMOTE } from './remote/remote-state';
import { PearSession } from './state/session';

const TABLET_MIN_WIDTH = 900;

/** Root — picks the phone or tablet shell from the viewport width. */
@Component({
  selector: 'pm-root',
  imports: [PmPhoneShell, PmTabletShell, PmHostKeySheet, PmLinkBanner],
  template: `
    @if (tablet()) {
      <pm-tablet-shell />
    } @else {
      <pm-phone-shell />
    }
    <pm-host-key-sheet />
    <pm-link-banner />
  `,
  // --kb-inset: the on-screen keyboard. iOS overlays it on the page instead of
  // shrinking the layout viewport, so without this the terminal's last rows
  // and the key bar sit underneath it.
  styles: ':host { display: block; height: calc(100dvh - var(--kb-inset, 0px)); }',
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
    this.trackKeyboard();
    // Home-screen web apps are exempt from Safari's storage eviction only if
    // asked; per-device choices (UI override, Claude model) live there.
    void navigator.storage?.persist?.().catch(() => {});
    // Same idea against a pear-server: once the link is back, refresh what
    // went stale while the app was frozen.
    let wasOpen = false;
    inject(REMOTE, { optional: true })?.onState((state) => {
      if (state !== 'open') return;
      if (wasOpen && this.session.activeHostId()) void this.session.refreshOrch();
      wasOpen = true;
    });
    if (Capacitor.isNativePlatform()) {
      void CapApp.addListener('resume', () => {
        if (this.session.activeHostId()) void this.session.refreshOrch();
      });
    }
  }

  /** Keep the app exactly as tall as what is visible above the keyboard. The
   *  terminal refits by itself (ResizeObserver) once its box changes. */
  private trackKeyboard(): void {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = (): void => {
      const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      document.documentElement.style.setProperty('--kb-inset', `${inset}px`);
      // Safari scrolls the page up to reveal a focused input; with the layout
      // already resized that only pushes the header off-screen.
      if (inset > 0) window.scrollTo(0, 0);
    };
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
  }
}
