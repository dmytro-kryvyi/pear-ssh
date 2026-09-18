import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Persisting every request would be silly; a day's slack on a 30-day TTL is fine. */
const TOUCH_SLACK_MS = 24 * 60 * 60 * 1000;

interface StoredSession {
  /** sha256 of the token — a stolen sessions.json must not be a bag of logins. */
  hash: string;
  expiresAt: number;
}

/**
 * Login sessions, on disk: restarting the server must not log the iPad out
 * (a home-screen web app has no password manager handy).
 */
export class SessionStore {
  private sessions: StoredSession[] = [];

  constructor(
    private readonly file: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    try {
      this.sessions = JSON.parse(readFileSync(file, 'utf8')) as StoredSession[];
    } catch {
      this.sessions = [];
    }
  }

  create(): string {
    const token = randomBytes(32).toString('base64url');
    this.prune();
    this.sessions.push({ hash: digest(token), expiresAt: this.now() + TTL_MS });
    this.persist();
    return token;
  }

  /** Valid → slides the expiry forward. */
  check(token: string | undefined): boolean {
    if (!token) return false;
    const hash = digest(token);
    const s = this.sessions.find((x) => x.hash === hash);
    if (!s || s.expiresAt < this.now()) return false;
    if (s.expiresAt - this.now() < TTL_MS - TOUCH_SLACK_MS) {
      s.expiresAt = this.now() + TTL_MS;
      this.persist();
    }
    return true;
  }

  revoke(token: string | undefined): void {
    if (!token) return;
    const hash = digest(token);
    this.sessions = this.sessions.filter((s) => s.hash !== hash);
    this.persist();
  }

  revokeAll(): void {
    this.sessions = [];
    this.persist();
  }

  private prune(): void {
    this.sessions = this.sessions.filter((s) => s.expiresAt >= this.now());
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify(this.sessions), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }
}

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
