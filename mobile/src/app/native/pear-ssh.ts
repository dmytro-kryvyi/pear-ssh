import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/**
 * TS contract for the PearSsh Capacitor plugin
 * (android/app/.../PearSshPlugin.kt over android/ssh-engine).
 *
 * One `connect` = one authenticated connection to one endpoint — endpoint
 * failover stays in core's SessionManager.dialEndpoints, which M3's
 * CapacitorSshTransport plugs into. Rejections carry a code from SshError
 * (UNKNOWN_HOST_KEY, HOST_KEY_CHANGED, AUTH_FAILED, ...) plus `data` details;
 * the TOFU flow is: connect → UNKNOWN_HOST_KEY with `fingerprint` → user
 * confirms → connect again with `trustFingerprint`.
 */

export interface SshAuthSpec {
  method: 'password' | 'key';
  password?: string;
  /** Private key text (OpenSSH/PEM); resolved from the secret store. */
  privateKey?: string;
  passphrase?: string;
}

export interface SshConnectSpec {
  host: string;
  port: number;
  user: string;
  auth: SshAuthSpec;
  timeoutMs?: number;
  /** Fingerprint ("SHA256:…") the user accepted on the TOFU prompt. */
  trustFingerprint?: string;
}

/** Mirrors core FileEntry. */
export interface SshEntry {
  name: string;
  kind: 'file' | 'dir' | 'link';
  size: number;
  mtimeMs: number;
  mode: string;
}

export interface ShellDataEvent {
  channelId: string;
  data: string;
}

export interface ShellExitEvent {
  channelId: string;
  code: number;
}

export interface SessionClosedEvent {
  sessionId: string;
}

export interface PearSshPlugin {
  connect(spec: SshConnectSpec): Promise<{ sessionId: string }>;
  disconnect(opts: { sessionId: string }): Promise<void>;
  isConnected(opts: { sessionId: string }): Promise<{ connected: boolean }>;
  forgetHostKey(opts: { host: string; port: number }): Promise<void>;
  probe(opts: { host: string; port: number; timeoutMs?: number }): Promise<{ ms: number }>;

  exec(opts: { sessionId: string; command: string }): Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>;

  /** PTY channel: login shell when `command` is omitted. */
  shellOpen(opts: {
    sessionId: string;
    command?: string;
    cols: number;
    rows: number;
  }): Promise<{ channelId: string }>;
  shellWrite(opts: { channelId: string; data: string }): Promise<void>;
  shellResize(opts: { channelId: string; cols: number; rows: number }): Promise<void>;
  shellClose(opts: { channelId: string }): Promise<void>;

  sftpList(opts: { sessionId: string; path: string }): Promise<{
    path: string;
    entries: SshEntry[];
  }>;
  sftpRead(opts: { sessionId: string; path: string; maxBytes?: number }): Promise<{
    content: string;
  }>;
  sftpWrite(opts: { sessionId: string; path: string; content: string }): Promise<void>;
  sftpStat(opts: { sessionId: string; path: string }): Promise<{
    exists: boolean;
    entry?: SshEntry;
  }>;
  sftpMkdir(opts: { sessionId: string; path: string }): Promise<void>;
  sftpRemove(opts: { sessionId: string; path: string; recursive?: boolean }): Promise<void>;
  sftpRename(opts: { sessionId: string; oldPath: string; newPath: string }): Promise<void>;
  sftpCopy(opts: { sessionId: string; src: string; dest: string }): Promise<void>;
  sftpHash(opts: { sessionId: string; path: string }): Promise<{ hash: string }>;

  /** Keystore-backed SecretCipher (core hosts/store.ts contract). */
  cipherAvailable(): Promise<{ available: boolean }>;
  cipherEncrypt(opts: { plain: string }): Promise<{ cipher: string }>;
  cipherDecrypt(opts: { cipher: string }): Promise<{ plain: string }>;

  addListener(
    event: 'shellData',
    cb: (e: ShellDataEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: 'shellExit',
    cb: (e: ShellExitEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: 'sessionClosed',
    cb: (e: SessionClosedEvent) => void,
  ): Promise<PluginListenerHandle>;
}

export const PearSsh = registerPlugin<PearSshPlugin>('PearSsh');

/**
 * Device half of the M2 throughput spike (the engine half lives in
 * ssh-engine's ThroughputTest: 28 MB/s on a dev machine). Run this from a
 * devtools console on a real device against any reachable host; it measures
 * PTY bytes crossing sshj + the batched Capacitor bridge into the WebView.
 * Terminal-grade is ~1 MB/s; if a device lands far below, the fallback is a
 * plugin-local socket stream (see docs/ANDROID.md risks).
 */
export async function benchPty(
  sessionId: string,
  megabytes = 8,
): Promise<{ chars: number; seconds: number; mbPerSec: number }> {
  const payload = megabytes * 1024 * 1024;
  let chars = 0;
  const started = performance.now();
  const done = new Promise<void>((resolve) => {
    void PearSsh.addListener('shellExit', () => resolve());
  });
  const dataSub = await PearSsh.addListener('shellData', (e) => (chars += e.data.length));
  await PearSsh.shellOpen({
    sessionId,
    command: `head -c ${payload} /dev/zero | base64`,
    cols: 80,
    rows: 24,
  });
  await done;
  const seconds = (performance.now() - started) / 1000;
  await dataSub.remove();
  return { chars, seconds, mbPerSec: chars / 1024 / 1024 / seconds };
}
