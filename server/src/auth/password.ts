import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt ships with Node — argon2 would mean a native dependency on a package
// people install with npx. Parameters travel in the hash so they can be raised
// later without invalidating stored ones.
const N = 1 << 15;
const R = 8;
const P = 1;
const KEYLEN = 32;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, len: number) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, len, { N: n, r, p, maxmem: 128 * n * r * 2 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P, KEYLEN);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  try {
    const got = await derive(
      password,
      Buffer.from(salt, 'base64'),
      Number(n),
      Number(r),
      Number(p),
      expected.length,
    );
    return got.length === expected.length && timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}
