import { Component, inject, signal } from '@angular/core';
import { PEAR_BACKEND } from './backend';

/**
 * M0 boot shell: proves theme + backend DI wiring. Replaced by the phone
 * tab-bar / tablet rail shells in M1.
 */
@Component({
  selector: 'pm-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly backend = inject(PEAR_BACKEND);

  readonly backendState = signal('connecting…');

  constructor() {
    this.backend.hosts
      .list()
      .then((hosts) => this.backendState.set(`stub backend · ${hosts.length} hosts`))
      .catch((err: unknown) => this.backendState.set(`backend error: ${String(err)}`));
  }
}
