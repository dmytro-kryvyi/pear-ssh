import type {
  DirListing,
  ExecResult,
  FileEntry,
  ShellChannel,
  SshTransport,
} from '@pear/core';
import type { PearSshPlugin } from './pear-ssh';

const notAHost = () => new Error('The phone is a transfer relay, not a shell host');

/**
 * The phone's own filesystem as an SshTransport — TransferEngine's relay
 * endpoint (`hostId: null`). Cross-host transfers stage through the app
 * cache here (download stage → upload stage), and SAF picks/downloads use
 * the same surface. Only the methods TransferEngine touches are real; the
 * shell/exec/file-editor surface intentionally throws.
 */
export class LocalFsTransport implements SshTransport {
  constructor(private readonly plugin: PearSshPlugin) {}

  readonly isConnected = true;
  async connect(): Promise<void> {}
  onClose(): void {}
  dispose(): void {}

  async listDir(path: string): Promise<DirListing> {
    const result = await this.plugin.localList({ path });
    return { path: result.path, entries: result.entries as FileEntry[] };
  }

  async stat(path: string): Promise<FileEntry | null> {
    const result = await this.plugin.localStat({ path });
    return result.exists ? ((result.entry ?? null) as FileEntry | null) : null;
  }

  async mkdir(path: string): Promise<void> {
    await this.plugin.localMkdir({ path });
  }

  async remove(path: string, recursive?: boolean): Promise<void> {
    await this.plugin.localRemove({ path, recursive });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.plugin.localRename({ oldPath, newPath });
  }

  copy(): Promise<void> {
    return Promise.reject(new Error('Phone-to-phone copies are not supported'));
  }

  async hash(path: string): Promise<string> {
    return (await this.plugin.localHash({ path })).hash;
  }

  // The relay is always the *other* side of a leg — the remote transport
  // drives download/uploadFile against local paths directly.
  download(): Promise<void> {
    return Promise.reject(new Error('Phone-to-phone copies are not supported'));
  }
  uploadFile(): Promise<void> {
    return Promise.reject(new Error('Phone-to-phone copies are not supported'));
  }
  upload(): Promise<string> {
    return Promise.reject(new Error('Phone-to-phone copies are not supported'));
  }
  readFile(): Promise<string> {
    return Promise.reject(notAHost());
  }
  writeFile(): Promise<void> {
    return Promise.reject(notAHost());
  }
  shell(): Promise<ShellChannel> {
    return Promise.reject(notAHost());
  }
  shellCommand(): Promise<ShellChannel> {
    return Promise.reject(notAHost());
  }
  exec(): Promise<ExecResult> {
    return Promise.reject(notAHost());
  }
}
