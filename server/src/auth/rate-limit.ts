/**
 * Failed-login throttle. Two windows per key (a burst and a slow-drip cap),
 * plus a global bucket so a distributed guesser can't scale past it. Only
 * failures count: a correct password is never locked out by someone else's
 * wrong ones on a different address.
 */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly perMinute = 5,
    private readonly perHour = 20,
    private readonly globalPerMinute = 30,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Seconds until this key may try again; 0 = go ahead. */
  retryAfter(key: string): number {
    const t = this.now();
    return Math.max(
      this.wait(this.recent(key, t), t, this.perMinute, 60_000),
      this.wait(this.recent(key, t), t, this.perHour, 3_600_000),
      this.wait(this.recent('*', t), t, this.globalPerMinute, 60_000),
    );
  }

  fail(key: string): void {
    const t = this.now();
    for (const k of [key, '*']) this.failures.set(k, [...this.recent(k, t), t]);
  }

  succeed(key: string): void {
    this.failures.delete(key);
  }

  private recent(key: string, t: number): number[] {
    const kept = (this.failures.get(key) ?? []).filter((at) => t - at < 3_600_000);
    if (kept.length) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }

  private wait(times: number[], t: number, limit: number, windowMs: number): number {
    const inWindow = times.filter((at) => t - at < windowMs);
    if (inWindow.length < limit) return 0;
    const oldestCounted = inWindow[inWindow.length - limit];
    return Math.ceil((oldestCounted + windowMs - t) / 1000);
  }
}
