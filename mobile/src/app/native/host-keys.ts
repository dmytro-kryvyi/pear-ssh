import { Injectable, signal } from '@angular/core';
import type { HostKeyGate, HostKeyPrompt } from './transport';

/**
 * Bridges the transport's TOFU prompts to the UI: `confirm` parks the
 * pending prompt in a signal (the host-key sheet renders it) and resolves
 * once the user answers. A superseding prompt cancels the previous one —
 * safer to refuse than to leave a connect hanging on a stale question.
 */
@Injectable({ providedIn: 'root' })
export class HostKeys implements HostKeyGate {
  readonly pending = signal<HostKeyPrompt | null>(null);
  private resolver: ((trusted: boolean) => void) | null = null;

  confirm(prompt: HostKeyPrompt): Promise<boolean> {
    this.resolver?.(false);
    this.pending.set(prompt);
    return new Promise((resolve) => (this.resolver = resolve));
  }

  answer(trusted: boolean): void {
    const resolve = this.resolver;
    this.resolver = null;
    this.pending.set(null);
    resolve?.(trusted);
  }
}
