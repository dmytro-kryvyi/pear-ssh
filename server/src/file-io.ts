import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ConflictPolicy, TransferJobSnapshot } from '@pear/core';
import { makeStagingDir, removeStaging, type PearService } from '@pear/core/node';

const CONFLICTS: ConflictPolicy[] = ['overwrite', 'skip', 'rename'];
/** A finished download nobody fetched is deleted after this long. */
const DOWNLOAD_TTL_MS = 10 * 60 * 1000;
const SETTLED = new Set(['done', 'error', 'canceled']);

interface PendingDownload {
  staging: string;
  names: string[];
  ready: boolean;
  timer: NodeJS.Timeout | null;
}

/** One path segment, as the browser named the file — never a path. */
export function safeFileName(raw: string | undefined): string | null {
  if (!raw) return null;
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  if (!name || name === '.' || name === '..' || /[/\\\x00-\x1f]/.test(name) || name.length > 255) {
    return null;
  }
  return name;
}

/**
 * Files between a browser and a host, through the server's disk.
 *
 * Electron hands core absolute local paths and a Downloads folder; a browser
 * has neither. So the server's staging dir plays the local machine: an upload
 * streams into it over HTTP and then rides the ordinary TransferEngine job to
 * the host; a download is an ordinary job *into* it, fetched afterwards with a
 * plain same-origin GET (blob: URLs are unreliable in iOS home-screen apps,
 * and a GET carries the session cookie by itself).
 */
export class FileIo {
  /** jobId → staging dir to delete once the job settles. */
  private readonly uploads = new Map<string, string>();
  private readonly downloads = new Map<string, PendingDownload>();

  constructor(private readonly service: PearService) {
    service.override('transfers:download', ([srcHostId, srcDir, names, conflict, verify]) =>
      this.startDownload(
        String(srcHostId),
        String(srcDir),
        (names as unknown[]).map(String),
        conflict as ConflictPolicy,
        verify === true,
      ),
    );
    // The file picker lives in the browser; it POSTs to /api/upload instead.
    service.override('fs:upload', () => {
      throw new Error('Pick files in the browser — this server cannot open a dialog');
    });
  }

  /** Feed every transfer:update through here (before it goes to clients). */
  onTransferUpdate(job: TransferJobSnapshot): void {
    if (!SETTLED.has(job.status)) return;
    const staging = this.uploads.get(job.id);
    if (staging) {
      this.uploads.delete(job.id);
      void removeStaging(staging);
    }
    const dl = this.downloads.get(job.id);
    if (!dl) return;
    if (job.status === 'done') {
      dl.ready = true;
      dl.timer = setTimeout(() => this.forget(job.id), DOWNLOAD_TTL_MS);
      dl.timer.unref();
    } else this.forget(job.id);
  }

  /** POST /api/upload?hostId&dir&conflict&verify  — raw body, name in X-Pear-Filename. */
  async upload(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): Promise<void> {
    const reply = (status: number, body: unknown): void => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(body));
    };
    const hostId = query.get('hostId') ?? '';
    const dir = query.get('dir') ?? '';
    const conflict = (query.get('conflict') ?? 'rename') as ConflictPolicy;
    const name = safeFileName(String(req.headers['x-pear-filename'] ?? ''));
    if (!this.service.resolveHost(hostId)) return reply(404, { error: 'Unknown host' });
    if (!dir.startsWith('/') && dir !== '~') return reply(400, { error: 'Bad destination' });
    if (!name) return reply(400, { error: 'Bad file name' });
    if (!CONFLICTS.includes(conflict)) return reply(400, { error: 'Bad conflict policy' });

    const staging = await makeStagingDir();
    try {
      await pipeline(req, createWriteStream(join(staging, name), { mode: 0o600 }));
      const [jobId] = await this.service.startLocalUpload(
        hostId,
        dir,
        [join(staging, name)],
        conflict,
        query.get('verify') === '1',
      );
      this.uploads.set(jobId, staging);
      reply(200, { jobId });
    } catch (err) {
      void removeStaging(staging);
      if (!res.headersSent) reply(500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** GET /api/dl/<jobId> — one file as itself, anything more as a tar. */
  async download(res: ServerResponse, jobId: string): Promise<void> {
    const dl = this.downloads.get(jobId);
    if (!dl?.ready) {
      res.statusCode = 404;
      return void res.end('No such download (it may have expired)\n');
    }
    // A file from a remote host is untrusted content served from the origin
    // that holds every SSH credential. It must never render: force a download,
    // forbid sniffing, and sandbox it in case a browser displays it anyway.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/octet-stream');

    const single = dl.names.length === 1 ? join(dl.staging, dl.names[0]) : null;
    const stat = single ? await fsp.stat(single).catch(() => null) : null;
    try {
      if (single && stat?.isFile()) {
        res.setHeader('Content-Disposition', disposition(dl.names[0]));
        res.setHeader('Content-Length', stat.size);
        await pipeline(createReadStream(single), res);
      } else {
        const label = dl.names.length === 1 ? dl.names[0] : 'pear-download';
        res.setHeader('Content-Disposition', disposition(`${label}.tar`));
        res.setHeader('Content-Type', 'application/x-tar');
        // `--` ends option parsing: a file named "-rf" stays a file name.
        const tar = spawn('tar', ['-C', dl.staging, '-cf', '-', '--', ...dl.names], {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        res.on('close', () => tar.kill());
        await pipeline(tar.stdout, res);
      }
    } catch {
      res.destroy();
    } finally {
      this.forget(jobId);
    }
  }

  dispose(): void {
    for (const id of [...this.downloads.keys()]) this.forget(id);
    for (const staging of this.uploads.values()) void removeStaging(staging);
    this.uploads.clear();
  }

  private async startDownload(
    srcHostId: string,
    srcDir: string,
    names: string[],
    conflict: ConflictPolicy,
    verify: boolean,
  ): Promise<string> {
    if (!names.length || names.some((n) => !safeFileName(encodeURIComponent(n)))) {
      throw new Error('Nothing to download');
    }
    this.service.requireHost(srcHostId);
    const staging = await makeStagingDir();
    try {
      const jobId = (await this.service.transfers.start({
        src: { hostId: srcHostId, dir: srcDir },
        dest: { hostId: null, dir: staging },
        names,
        op: 'copy',
        conflict,
        verify,
      })) as string;
      this.downloads.set(jobId, { staging, names, ready: false, timer: null });
      return jobId;
    } catch (err) {
      void removeStaging(staging);
      throw err;
    }
  }

  private forget(jobId: string): void {
    const dl = this.downloads.get(jobId);
    if (!dl) return;
    if (dl.timer) clearTimeout(dl.timer);
    this.downloads.delete(jobId);
    void removeStaging(dl.staging);
  }
}

/** RFC 6266: an ASCII fallback plus the real name, percent-encoded. */
function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
