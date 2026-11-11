import type { WebFiles } from '../remote/connect';
import { Injectable, inject, signal } from '@angular/core';
import { archiveKind, archiveStem, type ArchiveFormat, type ArchiveTools } from '@pear/core';
import { Pear } from '../pear';
import { Settings } from '../settings';
import { FsStore } from './fs-store';
import { Workspace, dirnameOf, type HostTab, type WsTab } from './workspace';

export interface RenameState {
  hostId: string;
  dir: string;
  name: string;
  /** Created by "new folder/file" — cancelling the rename deletes it again. */
  isNew: boolean;
}

export interface DragSource {
  paneId: string;
  hostId: string;
  dir: string;
  names: string[];
}

export function joinPath(dir: string, name: string): string {
  if (!name) return dir;
  return (dir === '/' ? '' : dir.replace(/\/$/, '')) + '/' + name;
}

/**
 * File operations behind the browser UI. Same-host moves/copies run directly
 * over SFTP; anything crossing hosts (or touching this machine) becomes a
 * queued transfer job with progress.
 */
@Injectable({ providedIn: 'root' })
export class FileOps {
  private readonly pear = inject(Pear);
  private readonly settings = inject(Settings);
  private readonly store = inject(FsStore);
  private readonly ws = inject(Workspace);

  readonly renaming = signal<RenameState | null>(null);
  /** Last operation failure, surfaced as a dismissable toast. */
  readonly lastError = signal<string | null>(null);
  /** The Properties modal's subject, when open. */
  readonly properties = signal<{ hostId: string; path: string } | null>(null);
  /** The Compress dialog's subject, when open. */
  readonly compressDialog = signal<{ hostId: string; dir: string; names: string[] } | null>(null);
  /** Archive tools per host; null until the probe answers. */
  private readonly tools = signal<Record<string, ArchiveTools>>({});
  private readonly toolsPending = new Map<string, Promise<ArchiveTools>>();

  private async guard<T>(work: () => Promise<T>): Promise<T | undefined> {
    try {
      return await work();
    } catch (err) {
      this.lastError.set(err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  // ---- properties & archives -------------------------------------------------

  /** Cached probe of a host's archive tools; kicks the fetch off and returns
   *  null until it lands, so a menu built meanwhile shows items enabled. */
  toolsFor(hostId: string): ArchiveTools | null {
    const known = this.tools()[hostId];
    if (known) return known;
    void this.loadTools(hostId);
    return null;
  }

  loadTools(hostId: string): Promise<ArchiveTools> {
    const known = this.tools()[hostId];
    if (known) return Promise.resolve(known);
    let pending = this.toolsPending.get(hostId);
    if (!pending) {
      pending = this.pear.api.ops
        .tools(hostId)
        .then((tools) => {
          this.tools.update((all) => ({ ...all, [hostId]: tools }));
          return tools;
        })
        .finally(() => this.toolsPending.delete(hostId));
      this.toolsPending.set(hostId, pending);
    }
    return pending;
  }

  openProperties(hostId: string, path: string): void {
    this.properties.set({ hostId, path });
  }

  /** Unpack an archive next to itself ('here') or into a fresh "stem/" folder. */
  async extract(hostId: string, dir: string, name: string, into: 'here' | 'subdir'): Promise<void> {
    await this.guard(async () => {
      let dest = dir;
      if (into === 'subdir') {
        const kind = archiveKind(name);
        const stem = kind ? archiveStem(name, kind) : name;
        dest = joinPath(dir, await this.uniqueName(hostId, dir, stem || name));
      }
      await this.pear.api.ops.extract(hostId, joinPath(dir, name), dest);
    });
  }

  async compress(
    hostId: string,
    dir: string,
    names: string[],
    archiveName: string,
    format: ArchiveFormat,
  ): Promise<void> {
    await this.guard(async () => {
      await this.pear.api.ops.compress(hostId, dir, names, archiveName, format);
    });
  }

  /** First free "name", "name (1)", ... in a directory, probed via stat. */
  private async uniqueName(hostId: string, dir: string, name: string): Promise<string> {
    if (!(await this.pear.api.fs.stat(hostId, joinPath(dir, name)))) return name;
    const dot = name.startsWith('.') ? -1 : name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 1; i < 100; i++) {
      const candidate = `${stem} (${i})${ext}`;
      if (!(await this.pear.api.fs.stat(hostId, joinPath(dir, candidate)))) return candidate;
    }
    throw new Error(`No free name for ${name}`);
  }

  async newFolder(hostId: string, dir: string): Promise<void> {
    await this.guard(async () => {
      const name = await this.uniqueName(hostId, dir, 'untitled folder');
      await this.pear.api.fs.mkdir(hostId, joinPath(dir, name));
      this.store.invalidate(hostId, dir);
      this.renaming.set({ hostId, dir, name, isNew: true });
    });
  }

  async newFile(hostId: string, dir: string): Promise<void> {
    await this.guard(async () => {
      const name = await this.uniqueName(hostId, dir, 'untitled.txt');
      await this.pear.api.fs.write(hostId, joinPath(dir, name), '');
      this.store.invalidate(hostId, dir);
      this.renaming.set({ hostId, dir, name, isNew: true });
    });
  }

  startRename(hostId: string, dir: string, name: string): void {
    this.renaming.set({ hostId, dir, name, isNew: false });
  }

  async commitRename(newName: string): Promise<void> {
    const r = this.renaming();
    this.renaming.set(null);
    if (!r || !newName || newName === r.name || newName.includes('/')) return;
    await this.guard(async () => {
      await this.pear.api.fs.rename(
        r.hostId,
        joinPath(r.dir, r.name),
        joinPath(r.dir, newName),
      );
      this.store.invalidate(r.hostId, r.dir);
    });
  }

  async cancelRename(): Promise<void> {
    const r = this.renaming();
    this.renaming.set(null);
    if (r?.isNew) {
      // The placeholder entry was only ever created to be named.
      await this.guard(async () => {
        await this.pear.api.fs.remove(r.hostId, joinPath(r.dir, r.name), true);
        this.store.invalidate(r.hostId, r.dir);
      });
    }
  }

  async remove(hostId: string, dir: string, names: string[]): Promise<void> {
    if (this.settings.confirmDelete()) {
      const what = names.length === 1 ? `'${names[0]}'` : `${names.length} items`;
      if (!window.confirm(`Delete ${what}? This cannot be undone.`)) return;
    }
    await this.guard(async () => {
      for (const name of names) {
        await this.pear.api.fs.remove(hostId, joinPath(dir, name), true);
      }
      this.store.invalidate(hostId, dir);
    });
  }

  copy(hostId: string, dir: string, names: string[]): void {
    this.ws.clipboard.set({ op: 'copy', hostId, dir, names });
  }

  cut(hostId: string, dir: string, names: string[]): void {
    this.ws.clipboard.set({ op: 'cut', hostId, dir, names });
  }

  async paste(destHostId: string, destDir: string): Promise<void> {
    const clip = this.ws.clipboard();
    if (!clip) return;
    await this.transfer(
      { paneId: '', hostId: clip.hostId, dir: clip.dir, names: clip.names },
      destHostId,
      destDir,
      clip.op === 'cut' ? 'move' : 'copy',
    );
    if (clip.op === 'cut') this.ws.clipboard.set(null);
  }

  /**
   * Move/copy a set of entries to a destination directory. Same host: direct
   * SFTP rename/copy honouring the conflict policy. Different host (or
   * to/from this machine): a queued transfer job.
   */
  async transfer(
    src: DragSource,
    destHostId: string,
    destDir: string,
    op: 'move' | 'copy',
  ): Promise<void> {
    if (src.hostId === destHostId) {
      if (src.dir === destDir && op === 'move') return;
      await this.guard(async () => {
        for (const name of src.names) {
          const from = joinPath(src.dir, name);
          let destName = name;
          const conflict = this.settings.conflict();
          const existing = await this.pear.api.fs.stat(destHostId, joinPath(destDir, name));
          if (existing) {
            if (conflict === 'skip') continue;
            if (conflict === 'rename') {
              destName = await this.uniqueName(destHostId, destDir, name);
            } else {
              await this.pear.api.fs.remove(destHostId, joinPath(destDir, name), true);
            }
          }
          const to = joinPath(destDir, destName);
          if (op === 'move') await this.pear.api.fs.rename(src.hostId, from, to);
          else await this.pear.api.fs.copy(src.hostId, from, to);
        }
        this.store.invalidate(src.hostId, src.dir);
        this.store.invalidate(destHostId, destDir);
      });
      return;
    }
    await this.guard(() =>
      this.pear.api.transfers.start({
        src: { hostId: src.hostId, dir: src.dir },
        dest: { hostId: destHostId, dir: destDir },
        names: src.names,
        op,
        conflict: this.settings.conflict(),
        verify: this.settings.verifyChecksums(),
      }),
    );
  }

  async download(hostId: string, dir: string, names: string[]): Promise<void> {
    await this.guard(() =>
      this.pear.api.transfers.download(
        hostId,
        dir,
        names,
        this.settings.conflict(),
        this.settings.verifyChecksums(),
      ),
    );
  }

  async uploadPicker(hostId: string, dir: string): Promise<void> {
    await this.guard(() =>
      this.pear.api.fs.upload(hostId, dir, this.settings.conflict(), this.settings.verifyChecksums()),
    );
  }

  /** Files dropped from the OS onto a directory. */
  async uploadDropped(hostId: string, dir: string, files: FileList): Promise<void> {
    await this.guard(async () => {
      // In a browser a dropped File has no path to hand to the transfer
      // engine — its bytes go to the server instead.
      const web = this.pear.api as Partial<WebFiles>;
      if (web.uploadFiles) {
        await web.uploadFiles(
          hostId,
          dir,
          Array.from(files),
          this.settings.conflict(),
          this.settings.verifyChecksums(),
        );
        return;
      }
      // One job per source directory (nearly always exactly one).
      const byDir = new Map<string, string[]>();
      for (const file of Array.from(files)) {
        const full = this.pear.api.transfers.pathForFile(file);
        if (!full) continue;
        const srcDir = dirnameOf(full);
        const name = full.slice(full.lastIndexOf('/') + 1);
        byDir.set(srcDir, [...(byDir.get(srcDir) ?? []), name]);
      }
      for (const [srcDir, names] of byDir) {
        await this.pear.api.transfers.start({
          src: { hostId: null, dir: srcDir },
          dest: { hostId, dir },
          names,
          op: 'copy',
          conflict: this.settings.conflict(),
          verify: this.settings.verifyChecksums(),
        });
      }
    });
  }

  /**
   * Where "Send to other pane" would land: the first other pane whose active
   * (or any) tab yields a directory. Null hides the menu item — without a
   * real target the action would degenerate into a pane duplicate.
   */
  otherPaneTarget(
    fromPaneId: string,
  ): { paneId: string; hostId: string; dir: string } | null {
    for (const pane of this.ws.panes()) {
      if (pane.id === fromPaneId) continue;
      // Only a directory or a file has a directory to land in — not an orch
      // view, a shell, or the Transfers tab.
      const isDirLike = (t: WsTab): t is HostTab => t.kind === 'dir' || t.kind === 'file';
      const active = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0];
      const tab = active && isDirLike(active) ? active : pane.tabs.find(isDirLike);
      if (!tab) continue;
      return {
        paneId: pane.id,
        hostId: tab.hostId,
        dir: tab.kind === 'file' ? dirnameOf(tab.path) : tab.path,
      };
    }
    return null;
  }

  /** Copy the selection into the other pane's current directory. */
  async sendToOtherPane(
    fromPaneId: string,
    hostId: string,
    dir: string,
    names: string[],
  ): Promise<void> {
    const target = this.otherPaneTarget(fromPaneId);
    if (!target) return;
    await this.transfer(
      { paneId: fromPaneId, hostId, dir, names },
      target.hostId,
      target.dir,
      'copy',
    );
    this.ws.focusPane(target.paneId);
  }
}
