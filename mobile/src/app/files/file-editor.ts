import {
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { javascript } from '@codemirror/lang-javascript';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { PEAR_BACKEND } from '../backend';
import { PmFullSheet } from '../chrome/chrome';
import { PmIcon } from '../icons/icon';
import { PearSession } from '../state/session';

function langOf(path: string): { label: string; ext: Extension[] } {
  const name = path.split('/').pop() ?? '';
  if (/\.json$/.test(name)) return { label: 'json', ext: [json()] };
  if (/\.ya?ml$/.test(name)) return { label: 'yaml', ext: [yaml()] };
  if (/\.(ts|tsx)$/.test(name)) return { label: 'ts', ext: [javascript({ typescript: true })] };
  if (/\.(js|mjs|cjs|jsx)$/.test(name)) return { label: 'js', ext: [javascript()] };
  if (/\.(sh|bash|zsh)$/.test(name) || /^\.?(bashrc|zshrc|profile|bash_profile)$/.test(name)) {
    return { label: 'shell', ext: [StreamLanguage.define(shell)] };
  }
  // No nginx mode on purpose: the legacy CM nginx parser reads the `/*` in
  // glob includes (`include conf.d/*.conf;`) as a block comment and greys
  // out the rest of the file. properties reads cleanly for conf/ini alike.
  if (
    /\.(conf|ini|env|properties|service|toml)$/.test(name) ||
    /-release$/.test(name) ||
    /nginx/.test(path) ||
    name === 'hosts'
  ) {
    return { label: 'conf', ext: [StreamLanguage.define(properties)] };
  }
  return { label: 'plain', ext: [] };
}

// Editor chrome + syntax palette from the design tokens (CSS vars pass
// straight through to the generated classes).
const pearTheme = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'var(--term-bg)' },
    '.cm-scroller': {
      fontFamily: 'var(--mono)',
      lineHeight: '1.6',
      overscrollBehavior: 'contain',
    },
    '.cm-content': { caretColor: 'var(--accent)', paddingBottom: '40vh' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'oklch(0.72 0.09 190 / 0.25) !important',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--term-bg)',
      color: 'var(--fg-3)',
      border: 'none',
      paddingLeft: '4px',
    },
    '.cm-activeLine': { backgroundColor: 'oklch(1 0 0 / 0.03)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg-1)' },
    '.cm-matchingBracket': { backgroundColor: 'oklch(0.72 0.09 190 / 0.2)', outline: 'none' },
  },
  { dark: true },
);

const pearHighlight = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--fg-3)', fontStyle: 'italic' },
  { tag: tags.string, color: 'var(--ok)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--warn)' },
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--accent)' },
  { tag: [tags.propertyName, tags.attributeName, tags.definition(tags.name)], color: 'oklch(0.75 0.09 250)' },
  { tag: [tags.variableName, tags.special(tags.variableName)], color: 'oklch(0.75 0.1 300)' },
  { tag: [tags.typeName, tags.className], color: 'oklch(0.8 0.08 60)' },
  { tag: tags.meta, color: 'var(--fg-2)' },
]);

/**
 * Full-screen CodeMirror 6 editor for the open file — replaces the M1
 * read-only viewer. Touch-first, dirty tracking, save via fs.write
 * (Ctrl/Cmd-S or the header button).
 */
@Component({
  selector: 'pm-file-editor',
  imports: [PmFullSheet, PmIcon],
  templateUrl: './file-editor.html',
  styleUrl: './file-editor.scss',
})
export class PmFileEditor implements OnDestroy {
  readonly path = input.required<string>();
  readonly closed = output<void>();

  private readonly session = inject(PearSession);
  private readonly backend = inject(PEAR_BACKEND);
  private readonly cmHost = viewChild.required<ElementRef<HTMLDivElement>>('cm');

  protected readonly dirty = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly lines = signal(0);
  protected readonly loading = signal(true);

  protected readonly name = computed(() => this.path().split('/').pop() ?? '');
  protected readonly lang = computed(() => langOf(this.path()).label);

  private view?: EditorView;

  constructor() {
    effect(() => {
      const hostId = this.session.activeHostId();
      const path = this.path();
      const host = this.cmHost().nativeElement;
      if (!hostId) return;
      this.loading.set(true);
      this.error.set(null);
      void this.backend.fs.read(hostId, path).then(
        (content) => {
          if (this.path() !== path) return;
          this.openDoc(host, path, content);
          this.loading.set(false);
        },
        (err: unknown) => {
          this.error.set(err instanceof Error ? err.message : String(err));
          this.loading.set(false);
        },
      );
    });
  }

  private openDoc(parent: HTMLElement, path: string, content: string): void {
    this.view?.destroy();
    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        indentOnInput(),
        bracketMatching(),
        keymap.of([
          { key: 'Mod-s', run: () => (this.save(), true) },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        pearTheme,
        syntaxHighlighting(pearHighlight, { fallback: true }),
        ...langOf(path).ext,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            this.dirty.set(true);
            this.lines.set(update.state.doc.lines);
          }
        }),
      ],
    });
    this.view = new EditorView({ state, parent });
    this.dirty.set(false);
    this.lines.set(state.doc.lines);
  }

  protected save(): void {
    const hostId = this.session.activeHostId();
    const view = this.view;
    if (!hostId || !view || this.saving() || !this.dirty()) return;
    this.saving.set(true);
    this.error.set(null);
    void this.backend.fs.write(hostId, this.path(), view.state.doc.toString()).then(
      () => {
        this.saving.set(false);
        this.dirty.set(false);
      },
      (err: unknown) => {
        this.saving.set(false);
        this.error.set(err instanceof Error ? err.message : String(err));
      },
    );
  }

  ngOnDestroy(): void {
    this.view?.destroy();
  }
}
