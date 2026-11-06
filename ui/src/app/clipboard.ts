import { Injectable, inject } from '@angular/core';
import { Notices } from './notices';

/** Whether the async clipboard API can read (secure origins only). */
export function canReadClipboard(): boolean {
  return typeof navigator.clipboard?.readText === 'function';
}

/**
 * Put text on the system clipboard. The async API needs a secure context;
 * a Pear server reached over plain http on the LAN has none, so fall back to
 * the selection-based copy command, which still works from a user gesture.
 */
export async function writeClipboardText(text: string): Promise<void> {
  if (typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* fall through to execCommand */
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } finally {
    ta.remove();
  }
  if (!ok) throw new Error('clipboard unavailable');
}

/**
 * System clipboard writes with optional feedback. Menu-initiated copies pass
 * `what` so a "Copied …" toast confirms them (the menu is gone by then);
 * controls with their own inline "Copied" swap call copy(text) alone.
 */
@Injectable({ providedIn: 'root' })
export class Clipboard {
  private readonly notices = inject(Notices);

  async copy(text: string, what?: string): Promise<void> {
    try {
      await writeClipboardText(text);
      if (what) this.notices.show(`Copied ${what}`);
    } catch {
      this.notices.show('Copy failed — clipboard unavailable', 'error');
    }
  }
}
