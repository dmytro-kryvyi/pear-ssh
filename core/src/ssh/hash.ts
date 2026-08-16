import { shq } from '../shq';
import type { ExecResult } from './transport';

/**
 * POSIX command that prints a file's SHA-256 hex digest, used for
 * post-transfer verification. Prefers coreutils `sha256sum`, falling back to
 * `shasum -a 256` on systems without it (e.g. macOS).
 */
export function sha256Command(path: string): string {
  return `sha256sum -- ${shq(path)} 2>/dev/null || shasum -a 256 -- ${shq(path)}`;
}

/** Pull the 64-char hex digest out of `sha256sum`/`shasum` stdout. */
export function parseSha256(result: ExecResult, path: string): string {
  const token = result.stdout.trim().split(/\s+/)[0] ?? '';
  if (result.code !== 0 || !/^[0-9a-f]{64}$/i.test(token)) {
    throw new Error(
      `checksum failed for ${path}: ${result.stderr.trim() || `exit ${result.code}`}`,
    );
  }
  return token.toLowerCase();
}
