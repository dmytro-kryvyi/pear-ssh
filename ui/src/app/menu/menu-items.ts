import type { MenuItem } from './context-menu';
import { canReadClipboard, type Clipboard } from '../clipboard';

/** A "Copy <label>" row; disabled when there is nothing to copy. */
export function copyItem(
  label: string,
  text: string | null | undefined,
  clipboard: Clipboard,
  what: string = label.replace(/^Copy /, ''),
): MenuItem {
  const value = (text ?? '').trim();
  return {
    label,
    icon: 'copy',
    disabled: !value,
    onClick: () => void clipboard.copy(value, what),
  };
}

export type EditableField = HTMLInputElement | HTMLTextAreaElement;

const TEXT_TYPES = new Set(['text', 'search', 'url', 'email', 'password', 'number', '']);

/** Whether a right-click target is a plain text field Pear should give an edit menu. */
export function editableFieldOf(target: EventTarget | null): EditableField | null {
  if (target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLInputElement && TEXT_TYPES.has(target.type)) return target;
  return null;
}

/**
 * Cut / Copy / Paste / Select all for a text field. Edits go through
 * setRangeText followed by a synthetic `input` event so Angular bindings
 * ((input)=, ngModel) see the change exactly as if it were typed.
 */
export function editMenuFor(el: EditableField, clipboard: Clipboard): MenuItem[] {
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  const selected = el.value.slice(start, end);
  const secret = el instanceof HTMLInputElement && el.type === 'password';
  const locked = el.readOnly || el.disabled;
  const replaceSelection = (text: string) => {
    el.setRangeText(text, el.selectionStart ?? 0, el.selectionEnd ?? 0, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
  };
  const selectAll = () => {
    el.focus();
    el.select();
  };
  if (locked) {
    return [
      {
        label: 'Copy',
        icon: 'copy',
        shortcut: 'Ctrl+C',
        disabled: !selected || secret,
        onClick: () => void clipboard.copy(selected),
      },
      { divider: true },
      { label: 'Select all', shortcut: 'Ctrl+A', onClick: selectAll },
    ];
  }
  return [
    {
      label: 'Cut',
      icon: 'scissors',
      shortcut: 'Ctrl+X',
      disabled: !selected || secret,
      onClick: () => {
        void clipboard.copy(selected);
        replaceSelection('');
      },
    },
    {
      label: 'Copy',
      icon: 'copy',
      shortcut: 'Ctrl+C',
      disabled: !selected || secret,
      onClick: () => void clipboard.copy(selected),
    },
    {
      label: 'Paste',
      icon: 'clipboard',
      shortcut: 'Ctrl+V',
      // Reading needs a secure origin; over plain http the keystroke still works.
      disabled: !canReadClipboard(),
      onClick: () => void navigator.clipboard.readText().then(replaceSelection, () => {}),
    },
    { divider: true },
    { label: 'Select all', shortcut: 'Ctrl+A', onClick: selectAll },
  ];
}

/** Select every character inside a block element (log panes, transcripts). */
export function selectContents(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = document.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** The current text selection, '' when none. */
export function selectionText(): string {
  return document.getSelection()?.toString() ?? '';
}
