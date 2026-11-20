import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type * as Monaco from 'monaco-editor';
import type { HostConfig } from '@pear/core';
import { Pear } from '../pear';
import { PearIcon } from '../icons/icon';
import { loadMonaco, type MonacoApi } from './monaco';
import { Clipboard } from '../clipboard';
import { ContextMenuService } from '../menu/context-menu';
import { copyItem } from '../menu/menu-items';
import { Workspace } from '../workspace/workspace';

@Component({
  selector: 'pear-editor',
  imports: [PearIcon],
  templateUrl: './editor.html',
  styleUrl: './editor.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Editor implements OnDestroy {
  readonly host = input.required<HostConfig>();
  readonly path = input.required<string>();
  readonly closed = output<void>();

  private readonly pear = inject(Pear);
  private readonly clipboard = inject(Clipboard);
  private readonly menu = inject(ContextMenuService);
  private readonly ws = inject(Workspace);
  private readonly editorHost = viewChild.required<ElementRef<HTMLDivElement>>('editorHost');

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly dirty = signal(false);
  readonly saving = signal(false);
  readonly line = signal(1);
  readonly col = signal(1);
  readonly language = signal('plaintext');

  readonly fileName = computed(() => this.path().split('/').pop() ?? this.path());

  private monaco?: MonacoApi;
  private editor?: Monaco.editor.IStandaloneCodeEditor;
  private savedVersion = 0;

  constructor() {
    afterNextRender(() => void this.init());
    // Reload when the open file (or host) changes while the pane stays up
    effect(() => {
      const path = this.path();
      const hostId = this.host().id;
      if (this.editor) void this.loadFile(hostId, path);
    });
  }

  private async init(): Promise<void> {
    const monaco = await loadMonaco();
    this.monaco = monaco;
    this.editor = monaco.editor.create(this.editorHost().nativeElement, {
      theme: 'pear-dark',
      automaticLayout: true,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 19,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      padding: { top: 10 },
      renderLineHighlight: 'line',
      fixedOverflowWidgets: true,
    });
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void this.save());
    this.editor.onDidChangeCursorPosition((e) => {
      this.line.set(e.position.lineNumber);
      this.col.set(e.position.column);
    });
    await this.loadFile(this.host().id, this.path());
  }

  private async loadFile(hostId: string, path: string): Promise<void> {
    const { monaco, editor } = this;
    if (!monaco || !editor) return;
    this.loading.set(true);
    this.error.set(null);
    this.dirty.set(false);
    try {
      const content = await this.pear.api.fs.read(hostId, path);
      editor.getModel()?.dispose();
      const uri = monaco.Uri.from({ scheme: 'pear', authority: hostId, path });
      const model = monaco.editor.createModel(content, undefined, uri);
      editor.setModel(model);
      this.savedVersion = model.getAlternativeVersionId();
      this.language.set(model.getLanguageId());
      model.onDidChangeContent(() =>
        this.dirty.set(model.getAlternativeVersionId() !== this.savedVersion),
      );
      editor.focus();
    } catch (err) {
      this.error.set(cleanIpcError(err));
    } finally {
      this.loading.set(false);
    }
  }

  async save(): Promise<void> {
    const model = this.editor?.getModel();
    if (!model || this.saving() || !this.dirty()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.pear.api.fs.write(this.host().id, this.path(), model.getValue());
      this.savedVersion = model.getAlternativeVersionId();
      this.dirty.set(false);
    } catch (err) {
      this.error.set(cleanIpcError(err));
    } finally {
      this.saving.set(false);
    }
  }

  onTabMenu(event: MouseEvent): void {
    event.preventDefault();
    const h = this.host();
    const path = this.path();
    const dir = path.replace(/\/[^/]*$/, '') || '/';
    this.menu.open(event.clientX, event.clientY, [
      { label: 'Save', shortcut: 'Ctrl+S', disabled: !this.dirty() || this.saving(), onClick: () => void this.save() },
      { label: 'Reload from host', icon: 'refresh', onClick: () => void this.loadFile(h.id, path) },
      { divider: true },
      copyItem('Copy path', path, this.clipboard),
      copyItem('Copy file name', this.fileName(), this.clipboard, 'file name'),
      copyItem('Copy host:path', h.local || h.parentId ? path : `${h.user}@${h.host}:${path}`, this.clipboard, 'host:path'),
      { divider: true },
      { label: 'Reveal in file list', icon: 'folderOpen', onClick: () => this.ws.newTab(null, h.id, dir) },
      { label: 'Close', icon: 'close', onClick: () => this.close() },
    ]);
  }

  close(): void {
    if (this.dirty() && !confirm(`${this.fileName()} has unsaved changes. Close anyway?`)) {
      return;
    }
    this.closed.emit();
  }

  ngOnDestroy(): void {
    this.editor?.getModel()?.dispose();
    this.editor?.dispose();
  }
}

function cleanIpcError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
