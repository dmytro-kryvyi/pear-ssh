import { Terminal } from '@xterm/xterm';

/**
 * Clipboard keys, handled before xterm turns them into PTY bytes.
 * Ctrl+C only copies while text is selected; otherwise it stays SIGINT.
 *
 * Returning false stops xterm's own key handling, but xterm does NOT
 * preventDefault() on that path — so without an explicit preventDefault()
 * the browser's native paste still fires xterm's `paste` listener and the
 * text lands in the PTY twice. Both branches prevent the default for the
 * same reason.
 *
 * For attachCustomKeyEventHandler: return true to let xterm process the key.
 */
export function handleClipboardKeys(xterm: Terminal, e: KeyboardEvent): boolean {
  if (e.type !== 'keydown') return true;
  const key = e.key.toLowerCase();
  // In a browser on a Mac or an iPad with a keyboard, ⌘C / ⌘V are what hands
  // know. ⌘V is left entirely to the browser: its native paste event reaches
  // xterm's own listener, with none of the permission prompts that
  // clipboard.readText() triggers in Safari. (Electron never sees metaKey
  // combos on Linux/Windows, so this changes nothing there.)
  if (e.metaKey && !e.ctrlKey && key === 'v') return false;
  if (e.metaKey && !e.ctrlKey && key === 'c' && xterm.hasSelection()) {
    e.preventDefault();
    copySelection(xterm);
    return false;
  }
  const copyKey =
    (e.ctrlKey && e.shiftKey && key === 'c') ||
    (e.ctrlKey && !e.shiftKey && key === 'c' && xterm.hasSelection()) ||
    (e.ctrlKey && key === 'insert');
  if (copyKey) {
    e.preventDefault();
    copySelection(xterm);
    return false;
  }
  const pasteKey = (e.ctrlKey && e.shiftKey && key === 'v') || (e.shiftKey && key === 'insert');
  if (pasteKey) {
    e.preventDefault();
    void pasteClipboard(xterm);
    return false;
  }
  return true;
}

export function copySelection(xterm: Terminal): void {
  const text = xterm.getSelection();
  if (!text) return;
  void navigator.clipboard.writeText(text);
  // Deselecting is the visual receipt that the copy happened.
  xterm.clearSelection();
}

export async function pasteClipboard(xterm: Terminal): Promise<void> {
  const text = await navigator.clipboard.readText();
  // xterm.paste() normalizes newlines and honors bracketed paste mode, then
  // feeds onData — the same path keystrokes take.
  if (text) xterm.paste(text);
}
