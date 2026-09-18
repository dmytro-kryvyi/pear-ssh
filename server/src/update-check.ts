/** `1.2.3` / `v1.2.3` → [1,2,3]; anything unparsable → null. Pre-release tags never count as newer. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export interface UpdateInfo {
  /** Without the leading `v`. */
  latest: string;
  url: string;
}

export interface UpdateCheckOpts {
  current: string;
  /** owner/name on GitHub. */
  repo: string;
  onUpdate(info: UpdateInfo): void;
  fetchJson?: (url: string) => Promise<unknown>;
  firstDelayMs?: number;
  intervalMs?: number;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Once a day, ask GitHub what the latest release is. One anonymous GET that
 * carries nothing but the usual request metadata — and `--no-update-check`
 * turns it off. It only ever *tells*: installing is the installer's job, run by
 * a person or by the optional systemd timer, never by the server on itself.
 */
export class UpdateCheck {
  private timer: NodeJS.Timeout | null = null;
  private found: UpdateInfo | null = null;

  constructor(private readonly opts: UpdateCheckOpts) {}

  get update(): UpdateInfo | null {
    return this.found;
  }

  start(): void {
    const tick = (): void => {
      void this.checkNow();
      this.timer = setTimeout(tick, this.opts.intervalMs ?? DAY);
      this.timer.unref();
    };
    this.timer = setTimeout(tick, this.opts.firstDelayMs ?? 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Never throws: no network, rate limits and odd payloads all mean "don't know". */
  async checkNow(): Promise<UpdateInfo | null> {
    try {
      const fetchJson = this.opts.fetchJson ?? defaultFetchJson;
      const release = (await fetchJson(
        `https://api.github.com/repos/${this.opts.repo}/releases/latest`,
      )) as { tag_name?: unknown; html_url?: unknown };
      const tag = typeof release?.tag_name === 'string' ? release.tag_name : '';
      if (!isNewer(tag, this.opts.current)) return null;
      const info: UpdateInfo = {
        latest: tag.replace(/^v/, ''),
        url:
          typeof release.html_url === 'string' && release.html_url.startsWith('https://github.com/')
            ? release.html_url
            : `https://github.com/${this.opts.repo}/releases/latest`,
      };
      if (this.found?.latest !== info.latest) {
        this.found = info;
        this.opts.onUpdate(info);
      }
      return info;
    } catch {
      return null;
    }
  }
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'pear-server' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
