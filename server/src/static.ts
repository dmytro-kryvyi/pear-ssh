import { createReadStream, promises as fsp } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/** Angular's hashed output: main-GMNDPBRJ.js, chunk-0bT59GVO2.js, styles-….css */
const HASHED = /-[A-Za-z0-9_-]{8,}\.(js|css|woff2?|ttf|svg|png)$/;

/** Resolve a URL path under a root, or null if it tries to climb out. */
export function resolveUnder(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const file = join(root, normalize('/' + decoded));
  return file === root || file.startsWith(root + sep) ? file : null;
}

/**
 * Both Angular builds are the same artifacts Electron and Capacitor ship —
 * untouched on disk. What a browser needs on top is added here, at serve time.
 */
export function transformIndex(html: string, opts: { mobile: boolean; build: string }): string {
  const head = [
    // First and synchronous: it may redirect to the other UI before the
    // module graph (several MB for the desktop build) starts downloading.
    `<script src="/boot.js"></script>`,
    `<link rel="manifest" href="/manifest.webmanifest">`,
    `<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">`,
    `<meta name="apple-mobile-web-app-capable" content="yes">`,
    `<meta name="mobile-web-app-capable" content="yes">`,
    `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`,
    `<meta name="apple-mobile-web-app-title" content="Pear">`,
    `<meta name="pear-remote" content="1">`,
    `<meta name="pear-build" content="${opts.build}">`,
    ...(opts.mobile ? [] : [`<meta name="theme-color" content="#1b1e24">`]),
  ].join('\n  ');
  return (
    html
      // Angular defers the stylesheet with an inline onload handler; the CSP
      // forbids inline script, so the stylesheet would stay media=print forever.
      .replace(/\s+media="print"\s+onload="this\.media='all'"/g, '')
      .replace(/<head>/i, `<head>\n  ${head}`)
  );
}

export async function sendFile(
  res: ServerResponse,
  file: string,
  opts: { head?: boolean; transform?: (html: string) => string } = {},
): Promise<boolean> {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.setHeader('Content-Type', type);
  res.setHeader(
    'Cache-Control',
    HASHED.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
  );
  if (opts.transform) {
    const body = opts.transform(await fsp.readFile(file, 'utf8'));
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(opts.head ? undefined : body);
    return true;
  }
  res.setHeader('Content-Length', stat.size);
  if (opts.head) {
    res.end();
    return true;
  }
  await new Promise<void>((resolve) => {
    createReadStream(file)
      .on('error', () => res.destroy())
      .on('close', resolve)
      .pipe(res);
  });
  return true;
}
