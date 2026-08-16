import { Component, computed, inject } from '@angular/core';
import { PmSheet } from '../chrome/chrome';
import { PmIcon } from '../icons/icon';
import { HostKeys } from './host-keys';

/**
 * The TOFU prompt: first contact shows the key fingerprint to verify out of
 * band; a CHANGED key gets the red treatment — that is the MITM case, and
 * accepting must feel like the exception, not the path of least resistance.
 */
@Component({
  selector: 'pm-host-key-sheet',
  imports: [PmSheet, PmIcon],
  template: `
    <pm-sheet [open]="prompt() !== null" (closed)="keys.answer(false)">
      @if (prompt(); as p) {
        <div class="hk">
          <div class="hk-head" [class.danger]="p.knownFingerprint">
            <pm-icon [name]="p.knownFingerprint ? 'warning' : 'key'" [size]="20" />
            <span>{{ p.knownFingerprint ? 'Host key changed!' : 'New host' }}</span>
          </div>
          @if (p.knownFingerprint) {
            <p class="hk-text">
              <strong>{{ p.host }}:{{ p.port }}</strong> presented a different key than the one
              you trusted before. This can mean the server was reinstalled — or that something
              is intercepting the connection. Verify before trusting.
            </p>
            <div class="hk-fp old"><span class="fp-label">was</span>{{ p.knownFingerprint }}</div>
          } @else {
            <p class="hk-text">
              First connection to <strong>{{ p.host }}:{{ p.port }}</strong>. Check that this
              fingerprint matches the server ({{ p.keyType || 'host key' }}):
            </p>
          }
          <div class="hk-fp"><span class="fp-label">{{ p.knownFingerprint ? 'now' : 'key' }}</span>{{ p.fingerprint }}</div>
          <div class="hk-actions">
            <button class="m-big" (click)="keys.answer(false)">Cancel</button>
            <button
              class="m-big"
              [class.primary]="!p.knownFingerprint"
              [class.danger]="p.knownFingerprint"
              (click)="keys.answer(true)"
            >
              {{ p.knownFingerprint ? 'Replace & trust' : 'Trust host' }}
            </button>
          </div>
        </div>
      }
    </pm-sheet>
  `,
  styles: `
    .hk { padding: 4px 16px calc(16px + var(--safe-bottom)); display: flex; flex-direction: column; gap: 12px; }
    .hk-head {
      display: flex; align-items: center; gap: 10px;
      font-size: 16px; font-weight: 650; color: var(--fg-0);
    }
    .hk-head.danger { color: var(--err); }
    .hk-text { margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--fg-1); }
    .hk-text strong { color: var(--fg-0); }
    .hk-fp {
      display: flex; align-items: center; gap: 10px;
      font-family: var(--mono); font-size: 11.5px; color: var(--fg-0);
      background: var(--bg-0); border: 1px solid var(--bg-3); border-radius: 10px;
      padding: 10px 12px; word-break: break-all;
    }
    .hk-fp.old { color: var(--fg-2); text-decoration: line-through; }
    .fp-label {
      flex-shrink: 0; font-family: var(--ui); font-size: 10px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.08em; color: var(--fg-3);
    }
    .hk-actions { display: flex; gap: 10px; }
    .hk-actions .m-big { flex: 1; }
  `,
})
export class PmHostKeySheet {
  protected readonly keys = inject(HostKeys);
  protected readonly prompt = computed(() => this.keys.pending());
}
