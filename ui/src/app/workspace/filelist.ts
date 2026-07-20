import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { FileEntry } from '@pear/core';
import { PearIcon } from '../icons/icon';
import { Pear } from '../pear';
import { Settings } from '../settings';
import { HostCatalog } from '../hosts';
import { TermTabs } from '../terminal/tabs';
import { ContextMenuService, type MenuItem } from '../menu/context-menu';
import { FsStore } from './fs-store';
import { FileOps, joinPath, type DragSource } from './ops';
import { Workspace, type WsPane, type WsTab } from './workspace';

const FILES_MIME = 'application/x-pear-files';

/**
 * One directory listing inside a pane tab: navigation, multi-select, context
 * menus, inline rename, drag-and-drop in and out, and the connect card for
 * hosts that need a password before their filesystem answers.
 */
@Component({
  selector: 'pear-filelist',
  imports: [FormsModule, PearIcon],
  templateUrl: './filelist.html',
  styleUrl: './filelist.scss',
})
export class FileList {
  readonly pane = input.required<WsPane>();
  readonly tab = input.required<WsTab>();

  private readonly pear = inject(Pear);
  readonly store = inject(FsStore);
  readonly ops = inject(FileOps);
  readonly ws = inject(Workspace);
  readonly settings = inject(Settings);
  readonly catalog = inject(HostCatalog);
  private readonly termTabs = inject(TermTabs);
  private readonly menu = inject(ContextMenuService);
  private readonly renameInput = viewChild<ElementRef<HTMLInputElement>>('renameField');

  readonly selected = signal<string[]>([]);
  private lastIndex: number | null = null;
  readonly filter = signal('');
  readonly showFilter = signal(false);
  /** Row name currently highlighted as a folder drop target. */
  readonly dropTarget = signal<string | null>(null);
  readonly dropOnList = signal(false);
  password = '';
  readonly connecting = signal(false);

  readonly host = computed(() => this.catalog.byId(this.tab().hostId));
  readonly state = computed(() => this.store.read(this.tab().hostId, this.tab().path));

  readonly crumbs = computed(() => {
    const p = this.tab().path;
    if (!p.startsWith('/')) return [];
    const parts = p.split('/').filter(Boolean);
    return parts.map((name, i) => ({
      name,
      full: '/' + parts.slice(0, i + 1).join('/'),
      last: i === parts.length - 1,
    }));
  });

  readonly entries = computed<FileEntry[]>(() => {
    let list = this.state()?.entries ?? [];
    if (!this.settings.showHidden()) list = list.filter((e) => !e.name.startsWith('.'));
    const q = this.filter().toLowerCase();
    if (q) list = list.filter((e) => e.name.toLowerCase().includes(q));
    const dirsFirst = this.settings.sortDirsFirst();
    return [...list].sort((a, b) => {
      if (dirsFirst) {
        const ad = a.kind === 'dir' ? 0 : 1;
        const bd = b.kind === 'dir' ? 0 : 1;
        if (ad !== bd) return ad - bd;
      }
      return a.name.localeCompare(b.name);
    });
  });

  readonly renamingName = computed(() => {
    const r = this.ops.renaming();
    const t = this.tab();
    return r && r.hostId === t.hostId && r.dir === t.path ? r.name : null;
  });

  constructor() {
    // Load when the tab points somewhere we have no listing for yet.
    effect(() => {
      const t = this.tab();
      const cached = this.store.read(t.hostId, t.path);
      if (!cached || (!cached.loading && !cached.error && cached.path !== t.path)) {
        untracked(() => void this.loadInto(t, undefined));
      }
    });
    // Selection does not survive navigation or host switching.
    effect(() => {
      this.tab().path;
      this.tab().hostId;
      untracked(() => {
        this.selected.set([]);
        this.lastIndex = null;
        this.filter.set('');
      });
    });
    effect(() => {
      if (this.renamingName()) {
        setTimeout(() => {
          const el = this.renameInput()?.nativeElement;
          el?.focus();
          el?.select();
        });
      }
    });
  }

  private async loadInto(tab: WsTab, password?: string): Promise<void> {
    try {
      const resolved = await this.store.load(tab.hostId, tab.path, password);
      if (resolved !== tab.path) this.ws.navigate(tab.id, resolved);
    } catch {
      // surfaced via store state error
    }
  }

  async connect(): Promise<void> {
    this.connecting.set(true);
    try {
      await this.loadInto(this.tab(), this.password || undefined);
    } finally {
      this.connecting.set(false);
      this.password = '';
    }
  }

  refresh(): void {
    void this.loadInto(this.tab());
  }

  navigate(path: string): void {
    this.ws.navigate(this.tab().id, path);
    this.ws.focusPane(this.pane().id);
  }

  up(): void {
    const p = this.tab().path;
    if (p === '/' || !p.startsWith('/')) return;
    this.navigate(p.slice(0, p.lastIndexOf('/')) || '/');
  }

  home(): void {
    this.navigate(this.store.homes()[this.tab().hostId] ?? '~');
  }

  open(entry: FileEntry): void {
    const full = joinPath(this.tab().path, entry.name);
    if (entry.kind === 'dir' || entry.kind === 'link') this.navigate(full);
    else this.ws.openFile(this.pane().id, this.tab().hostId, full);
  }

  onRowClick(event: MouseEvent, index: number, entry: FileEntry): void {
    this.ws.focusPane(this.pane().id);
    if (event.shiftKey && this.lastIndex !== null) {
      const [a, b] = [this.lastIndex, index].sort((x, y) => x - y);
      this.selected.set(this.entries().slice(a, b + 1).map((e) => e.name));
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      this.selected.update((sel) =>
        sel.includes(entry.name) ? sel.filter((n) => n !== entry.name) : [...sel, entry.name],
      );
      this.lastIndex = index;
      return;
    }
    this.selected.set([entry.name]);
    this.lastIndex = index;
    if (this.settings.openWith() === 'single') this.open(entry);
  }

  onRowDblClick(entry: FileEntry): void {
    if (this.settings.openWith() === 'double') this.open(entry);
  }

  clearSelection(): void {
    this.selected.set([]);
    this.lastIndex = null;
  }

  onKeydown(event: KeyboardEvent): void {
    const t = this.tab();
    const sel = this.selected();
    if (event.key === 'F2' && sel.length === 1) {
      this.ops.startRename(t.hostId, t.path, sel[0]);
    } else if (event.key === 'Delete' && sel.length) {
      void this.ops.remove(t.hostId, t.path, sel).then(() => this.clearSelection());
    } else if ((event.ctrlKey || event.metaKey) && event.key === 'c' && sel.length) {
      this.ops.copy(t.hostId, t.path, sel);
    } else if ((event.ctrlKey || event.metaKey) && event.key === 'x' && sel.length) {
      this.ops.cut(t.hostId, t.path, sel);
    } else if ((event.ctrlKey || event.metaKey) && event.key === 'v') {
      void this.ops.paste(t.hostId, t.path);
    } else {
      return;
    }
    event.preventDefault();
  }

  // ---- context menus -------------------------------------------------------

  onRowMenu(event: MouseEvent, entry: FileEntry): void {
    event.preventDefault();
    event.stopPropagation();
    this.ws.focusPane(this.pane().id);
    if (!this.selected().includes(entry.name)) this.selected.set([entry.name]);
    const t = this.tab();
    const names = this.selected();
    const single = names.length === 1;
    const full = joinPath(t.path, entry.name);
    const sendTarget = this.ops.otherPaneTarget(this.pane().id);
    const items: MenuItem[] = [
      entry.kind === 'dir'
        ? { label: 'Open', icon: 'folderOpen', onClick: () => this.open(entry) }
        : { label: 'Open in editor', icon: 'fileCode', onClick: () => this.open(entry) },
      {
        label: 'Open in another pane',
        icon: 'split',
        disabled: !single,
        onClick: () =>
          this.ws.openToSide(
            this.pane().id,
            t.hostId,
            full,
            entry.kind === 'file' ? 'file' : 'dir',
          ),
      },
      {
        label: 'Download to my machine',
        icon: 'download',
        onClick: () => void this.ops.download(t.hostId, t.path, names),
      },
      { divider: true },
      {
        label: 'Copy',
        icon: 'copy',
        shortcut: 'Ctrl C',
        onClick: () => this.ops.copy(t.hostId, t.path, names),
      },
      {
        label: 'Cut',
        icon: 'scissors',
        shortcut: 'Ctrl X',
        onClick: () => this.ops.cut(t.hostId, t.path, names),
      },
      ...(sendTarget
        ? [
            {
              label: `Send to other pane (${this.catalog.nameOf(sendTarget.hostId)})`,
              icon: 'swap',
              onClick: () =>
                void this.ops.sendToOtherPane(this.pane().id, t.hostId, t.path, names),
            } satisfies MenuItem,
          ]
        : []),
      { divider: true },
      {
        label: 'Rename',
        icon: 'pencil',
        shortcut: 'F2',
        disabled: !single,
        onClick: () => this.ops.startRename(t.hostId, t.path, entry.name),
      },
      {
        label: single ? 'Delete' : `Delete ${names.length} items`,
        icon: 'trash',
        danger: true,
        shortcut: 'Del',
        onClick: () =>
          void this.ops.remove(t.hostId, t.path, names).then(() => this.clearSelection()),
      },
    ];
    this.menu.open(event.clientX, event.clientY, items);
  }

  onListMenu(event: MouseEvent): void {
    if ((event.target as HTMLElement).closest('[data-row]')) return;
    event.preventDefault();
    this.ws.focusPane(this.pane().id);
    const t = this.tab();
    this.menu.open(event.clientX, event.clientY, [
      {
        label: 'New folder',
        icon: 'folderPlus',
        onClick: () => void this.ops.newFolder(t.hostId, t.path),
      },
      {
        label: 'New file',
        icon: 'filePlus',
        onClick: () => void this.ops.newFile(t.hostId, t.path),
      },
      { divider: true },
      {
        label: 'Paste',
        icon: 'clipboard',
        shortcut: 'Ctrl V',
        disabled: !this.ws.clipboard(),
        onClick: () => void this.ops.paste(t.hostId, t.path),
      },
      {
        label: 'Open terminal here',
        icon: 'terminal',
        onClick: () => this.termTabs.navigate(t.hostId, t.path),
      },
      { divider: true },
      {
        label: 'Upload from my machine…',
        icon: 'upload',
        onClick: () => void this.ops.uploadPicker(t.hostId, t.path),
      },
    ]);
  }

  onHostPill(event: MouseEvent): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const t = this.tab();
    this.menu.open(
      rect.left,
      rect.bottom + 4,
      this.catalog.all().map((h) => ({
        label: h.name,
        icon: h.local ? 'terminal' : h.parentId ? 'cube' : 'server',
        shortcut: h.tag,
        disabled: h.id === t.hostId,
        onClick: () => this.ws.setTabHost(t.id, h.id),
      })),
    );
  }

  // ---- drag and drop -------------------------------------------------------

  onRowDragStart(event: DragEvent, entry: FileEntry): void {
    if (this.renamingName()) {
      event.preventDefault();
      return;
    }
    if (!this.selected().includes(entry.name)) this.selected.set([entry.name]);
    const t = this.tab();
    const payload: DragSource = {
      paneId: this.pane().id,
      hostId: t.hostId,
      dir: t.path,
      names: this.selected(),
    };
    event.dataTransfer?.setData(FILES_MIME, JSON.stringify(payload));
    event.dataTransfer!.effectAllowed = 'copyMove';
    this.ws.dragging.set('files');
  }

  onDragEnd(): void {
    this.ws.dragging.set(null);
    this.dropTarget.set(null);
    this.dropOnList.set(false);
  }

  private acceptsFiles(event: DragEvent): boolean {
    const types = event.dataTransfer ? Array.from(event.dataTransfer.types) : [];
    return types.includes(FILES_MIME) || types.includes('Files');
  }

  onRowDragOver(event: DragEvent, entry: FileEntry): void {
    if (entry.kind !== 'dir' || !this.acceptsFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer!.dropEffect = 'copy';
    this.dropTarget.set(entry.name);
    this.dropOnList.set(false);
  }

  onRowDragLeave(entry: FileEntry): void {
    if (this.dropTarget() === entry.name) this.dropTarget.set(null);
  }

  onRowDrop(event: DragEvent, entry: FileEntry): void {
    if (entry.kind !== 'dir') return;
    event.preventDefault();
    event.stopPropagation();
    void this.dropInto(event, joinPath(this.tab().path, entry.name));
  }

  onListDragOver(event: DragEvent): void {
    if (!this.acceptsFiles(event)) return;
    event.preventDefault();
    event.dataTransfer!.dropEffect = 'copy';
    this.dropOnList.set(true);
  }

  onListDragLeave(event: DragEvent): void {
    if (event.target === event.currentTarget) this.dropOnList.set(false);
  }

  onListDrop(event: DragEvent): void {
    event.preventDefault();
    if ((event.target as HTMLElement).closest('[data-dir]')) return;
    void this.dropInto(event, this.tab().path);
  }

  private async dropInto(event: DragEvent, destDir: string): Promise<void> {
    this.dropTarget.set(null);
    this.dropOnList.set(false);
    this.ws.dragging.set(null);
    const t = this.tab();
    const raw = event.dataTransfer?.getData(FILES_MIME);
    if (raw) {
      const src = JSON.parse(raw) as DragSource;
      if (src.hostId === t.hostId && src.dir === destDir) return;
      let mode: 'move' | 'copy' =
        this.settings.sameHostDrag() === 'copy' || src.hostId !== t.hostId ? 'copy' : 'move';
      if (event.ctrlKey || event.altKey) mode = mode === 'move' ? 'copy' : 'move';
      if (this.settings.sameHostDrag() === 'ask' && src.hostId === t.hostId) {
        this.menu.open(event.clientX, event.clientY, [
          {
            label: `Move ${src.names.length === 1 ? src.names[0] : src.names.length + ' items'} here`,
            icon: 'forward',
            onClick: () => void this.ops.transfer(src, t.hostId, destDir, 'move'),
          },
          {
            label: 'Copy here',
            icon: 'copy',
            onClick: () => void this.ops.transfer(src, t.hostId, destDir, 'copy'),
          },
        ]);
        return;
      }
      await this.ops.transfer(src, t.hostId, destDir, mode);
    } else if (event.dataTransfer?.files.length) {
      await this.ops.uploadDropped(t.hostId, destDir, event.dataTransfer.files);
    }
  }

  // ---- rename --------------------------------------------------------------

  onRenameKey(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      void this.ops.commitRename((event.target as HTMLInputElement).value.trim());
    } else if (event.key === 'Escape') {
      void this.ops.cancelRename();
    }
    event.stopPropagation();
  }

  onRenameBlur(event: FocusEvent): void {
    if (this.ops.renaming()) {
      void this.ops.commitRename((event.target as HTMLInputElement).value.trim());
    }
  }

  // ---- formatting ----------------------------------------------------------

  formatSize(entry: FileEntry): string {
    if (entry.kind === 'dir') return '—';
    const base = this.settings.sizeUnits() === 'binary' ? 1024 : 1000;
    const units =
      this.settings.sizeUnits() === 'binary' ? ['B', 'KiB', 'MiB', 'GiB'] : ['B', 'KB', 'MB', 'GB'];
    let size = entry.size;
    let u = 0;
    while (size >= base && u < units.length - 1) {
      size /= base;
      u++;
    }
    return u === 0 ? `${size} ${units[0]}` : `${size.toFixed(1)} ${units[u]}`;
  }

  formatDate(entry: FileEntry): string {
    if (!entry.mtimeMs) return '—';
    const d = new Date(entry.mtimeMs);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: '2-digit',
      ...(sameYear ? { hour: '2-digit', minute: '2-digit', hour12: false } : { year: 'numeric' }),
    });
  }
}
