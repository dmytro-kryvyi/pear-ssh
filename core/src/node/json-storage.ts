import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HostStorage } from '../hosts/store';
import type { HistoryStorage } from '../history/store';

/** A JSON file on disk, satisfying the storage contracts core injects. */
export class JsonFileStorage implements HostStorage, HistoryStorage {
  constructor(private readonly filePath: string) {}

  read(): string | null {
    try {
      return readFileSync(this.filePath, 'utf8');
    } catch {
      return null;
    }
  }

  write(data: string): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, data);
  }
}
