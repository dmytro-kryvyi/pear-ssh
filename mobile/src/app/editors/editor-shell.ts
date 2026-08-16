import { NgTemplateOutlet } from '@angular/common';
import { Component, input, output } from '@angular/core';
import { PmFullSheet } from '../chrome/chrome';
import { PmIcon } from '../icons/icon';

export interface EditorSection {
  id: string;
  label: string;
  icon: string;
}

/**
 * Editor chrome shared by the host and workspace editors. Phone: full-screen
 * sheet with a horizontal section chip strip. `wide` (tablet): centered modal
 * with a section rail on the left.
 */
@Component({
  selector: 'pm-editor-shell',
  imports: [PmFullSheet, PmIcon, NgTemplateOutlet],
  templateUrl: './editor-shell.html',
  styleUrl: './editor-shell.scss',
})
export class PmEditorShell {
  readonly wide = input(false);
  readonly title = input.required<string>();
  readonly subtitle = input('');
  readonly sections = input<EditorSection[]>([]);
  readonly section = input('');
  readonly sectionChange = output<string>();
  readonly closed = output<void>();
}
