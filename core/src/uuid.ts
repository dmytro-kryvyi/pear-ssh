/**
 * RFC 4122 v4 ids off globalThis.crypto rather than `node:crypto`, so the pure
 * layer builds without @types/node. `randomUUID` exists in Node 19+ and in
 * browsers on secure origins only; a Pear server reached over plain http on
 * the LAN has `getRandomValues` but not `randomUUID`, so build one by hand
 * there. The cast is only needed because `lib` here is ES2022, not DOM.
 */
export function uuid(): string {
  const c = (globalThis as unknown as {
    crypto: { randomUUID?: () => string; getRandomValues(a: Uint8Array): Uint8Array };
  }).crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  return uuidFromBytes(c.getRandomValues(new Uint8Array(16)));
}

/** Format 16 random bytes as a v4 UUID (version and variant bits set). */
export function uuidFromBytes(b: Uint8Array): string {
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
