/**
 * `crypto.randomUUID()` off globalThis rather than `node:crypto`, so the pure
 * layer builds without @types/node. Present in Node 19+ and every WebView we
 * target; the cast is only needed because `lib` here is ES2022, not DOM.
 */
export function uuid(): string {
  return (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();
}
