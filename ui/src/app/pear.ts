import { Injectable } from '@angular/core';
import type { PearApi } from '@pear/core';

declare global {
  interface Window {
    pear?: PearApi;
  }
}

/** Thin injectable over the preload bridge (window.pear). */
@Injectable({ providedIn: 'root' })
export class Pear {
  readonly available = typeof window !== 'undefined' && !!window.pear;

  get api(): PearApi {
    if (!window.pear) throw new Error('Pear bridge unavailable — not running inside Electron?');
    return window.pear;
  }
}
