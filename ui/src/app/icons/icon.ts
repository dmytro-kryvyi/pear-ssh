import { Component, computed, inject, input } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

// Inner SVG markup per icon, 16x16 viewBox — ported from design/src/icons.jsx.
const ICONS: Record<string, string> = {
  folder: '<path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h6.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/>',
  folderOpen:
    '<path d="M1.5 5.5V4a1 1 0 0 1 1-1h3L7 4.5h6.5a1 1 0 0 1 1 1V6.5"/><path d="M1.5 5.5h13l-1.3 6.2a1 1 0 0 1-1 .8H2.8a1 1 0 0 1-1-.8z"/>',
  file: '<path d="M3 2h6l4 4v8H3z"/><path d="M9 2v4h4"/>',
  fileCode:
    '<path d="M3 2h6l4 4v8H3z"/><path d="M9 2v4h4"/><path d="M6 10l-1.2 1.2L6 12.5M10 10l1.2 1.2L10 12.5"/>',
  link: '<path d="M6.5 9.5l3-3"/><path d="M7.5 4.5l1-1a2.1 2.1 0 0 1 3 3l-1 1M8.5 11.5l-1 1a2.1 2.1 0 0 1-3-3l1-1"/>',
  back: '<path d="M10 4L6 8l4 4"/>',
  forward: '<path d="M6 4l4 4-4 4"/>',
  home: '<path d="M2.5 7.5L8 2.5l5.5 5v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>',
  refresh: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/>',
  upload:
    '<path d="M8 10V3"/><path d="M5 6l3-3 3 3"/><path d="M2.5 11v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V11"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  terminal: '<path d="M2 3h12v10H2z"/><path d="M4.5 6l2 2-2 2M8 10.5h3.5"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  minus: '<path d="M3 8h10"/>',
  play: '<path d="M4.5 3v10l8-5z" fill="currentColor" stroke="none"/>',
  stop: '<path d="M4 4h8v8H4z" fill="currentColor" stroke="none"/>',
  logs: '<path d="M3 3h10v10H3z"/><path d="M5.5 6h5M5.5 8h5M5.5 10h3"/>',
  chevronDown: '<path d="M4 6l4 4 4-4"/>',
  chevronRight: '<path d="M6 4l4 4-4 4"/>',
  docker:
    '<path d="M1.5 9h13l-.7 2.5a2 2 0 0 1-1.9 1.3H4.3a2.8 2.8 0 0 1-2.8-2.5z"/><path d="M3 7h2v2H3zM6 7h2v2H6zM9 7h2v2H9zM6 4h2v2H6zM9 4h2v2H9zM9 1h2v2H9z"/>',
  layers: '<path d="M8 1.8l6 3-6 3-6-3z"/><path d="M2 8l6 3 6-3"/><path d="M2 11l6 3 6-3"/>',
  server:
    '<path d="M2 3h12v4H2zM2 9h12v4H2z"/><circle cx="4" cy="5" r="0.5" fill="currentColor"/><circle cx="4" cy="11" r="0.5" fill="currentColor"/>',
  cube: '<path d="M8 1.6l5.5 3v6.8L8 14.4 2.5 11.4V4.6z"/><path d="M2.6 4.7L8 7.7l5.4-3M8 7.7v6.7"/>',
  cpu: '<path d="M4.5 4.5h7v7h-7z"/><path d="M6.8 6.8h2.4v2.4H6.8z"/><path d="M6.2 1.8v2.6M9.8 1.8v2.6M6.2 11.6v2.6M9.8 11.6v2.6M1.8 6.2h2.6M1.8 9.8h2.6M11.6 6.2h2.6M11.6 9.8h2.6"/>',
  settings:
    '<circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M3.2 12.8l1.4-1.4M11.4 4.6l1.4-1.4"/>',
  activity: '<path d="M1.5 8h3L6 3l4 10 1.5-5h3"/>',
  crown: '<path d="M2 12h12M2.5 4.5l2.5 3 3-4 3 4 2.5-3-1 7.5h-9z" fill="currentColor" stroke="none"/>',
  network:
    '<circle cx="8" cy="3" r="1.6"/><circle cx="3.5" cy="12.5" r="1.6"/><circle cx="12.5" cy="12.5" r="1.6"/><path d="M8 4.6v3M8 7.6L4.4 11M8 7.6L11.6 11"/>',
  clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
  expand: '<path d="M6 2H2v4M14 6V2h-4M10 14h4v-4M2 10v4h4"/>',
  folder2: '<path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h6.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/>',
  sparkle: '<path d="M8 1.5l1.4 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.4-4.9L1.7 8l4.9-1.6z" fill="currentColor" stroke="none"/>',
  enter: '<path d="M9.5 3H13v10H9.5"/><path d="M2 8h8"/><path d="M7.5 5.5L10 8l-2.5 2.5"/>',
  pin: '<path d="M6.2 2h3.6v4.5L11.5 9h-7l1.7-2.5z"/><path d="M8 9v4.5"/>',
  pinFilled:
    '<path d="M6.2 2h3.6v4.5L11.5 9h-7l1.7-2.5z" fill="currentColor" stroke="none"/><path d="M8 9v4.5"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 3.5v-1h-8v8h1"/>',
  scissors:
    '<circle cx="4" cy="4.3" r="1.7"/><circle cx="4" cy="11.7" r="1.7"/><path d="M5.5 5.4l8 7.6M5.5 10.6l8-7.6"/>',
  clipboard:
    '<path d="M5.5 3H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1h-1.5"/><path d="M6 1.8h4v2.4H6z"/>',
  trash:
    '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9"/><path d="M6.8 7.2v4M9.2 7.2v4"/>',
  download:
    '<path d="M8 3v7"/><path d="M5 7l3 3 3-3"/><path d="M2.5 11v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V11"/>',
  pencil:
    '<path d="M3 13l.7-2.9 6.8-6.8a1.2 1.2 0 0 1 1.7 0l.5.5a1.2 1.2 0 0 1 0 1.7l-6.8 6.8z"/><path d="M9.5 4.3l2.2 2.2"/>',
  swap: '<path d="M13.5 5.5H4.5M6.5 3.5l-2 2 2 2"/><path d="M2.5 10.5h9M9.5 8.5l2 2-2 2"/>',
  split: '<path d="M2 3h12v10H2z"/><path d="M8 3v10"/>',
  check: '<path d="M3 8.5l3.2 3L13 5"/>',
  filePlus: '<path d="M3 2h6l4 4v8H3z"/><path d="M9 2v4h4"/><path d="M8 8v4M6 10h4"/>',
  folderPlus:
    '<path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h6.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/><path d="M8 6.8v4M6 8.8h4"/>',
  filter: '<path d="M2.5 3h11L9.5 8.5V13l-3-1.5V8.5z"/>',
};

@Component({
  selector: 'pear-icon',
  templateUrl: './icon.html',
  styleUrl: './icon.scss',
})
export class PearIcon {
  readonly name = input.required<string>();
  readonly size = input(16);

  private readonly sanitizer = inject(DomSanitizer);

  readonly markup = computed<SafeHtml>(() =>
    this.sanitizer.bypassSecurityTrustHtml(ICONS[this.name()] ?? ''),
  );
}
