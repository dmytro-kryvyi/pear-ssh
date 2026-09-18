import {
  createRemoteBackend,
  type ConflictPolicy,
  type HostKeyGate,
  type RemoteBackend,
  type WebSocketLike,
} from '@pear/core';

/** What a browser can do that PearApi has no shape for. */
export interface WebFiles {
  /** Stream File objects (picker, drag-and-drop) to a directory on a host. */
  uploadFiles(
    hostId: string,
    dir: string,
    files: File[],
    conflict?: ConflictPolicy,
    verify?: boolean,
  ): Promise<void>;
  /** Open the system file picker, then upload. Resolves null when cancelled. */
  pickAndUpload(hostId: string, dir: string): Promise<string | null>;
}

export type PearServerBackend = RemoteBackend & WebFiles;

function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve([...(input.files ?? [])]);
      input.remove();
    });
    // Safari fires nothing on cancel in older versions; `cancel` where it exists.
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.appendChild(input); // iOS ignores clicks on detached inputs
    input.click();
  });
}

async function uploadFiles(
  hostId: string,
  dir: string,
  files: File[],
  conflict: ConflictPolicy = 'rename',
  verify = false,
): Promise<void> {
  const query = new URLSearchParams({ hostId, dir, conflict, verify: verify ? '1' : '0' });
  // One request per file, in order: each becomes its own transfer job, and a
  // phone uplink gains nothing from parallel bodies.
  for (const file of files) {
    const res = await fetch(`/api/upload?${query}`, {
      method: 'POST',
      headers: { 'X-Pear-Filename': encodeURIComponent(file.name) },
      body: file,
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error((detail as { error?: string }).error ?? `Upload failed (${res.status})`);
    }
  }
}

/**
 * Trust-on-first-use with the browser's own dialog — the fallback for a UI
 * that has not supplied a nicer one. Wording follows OpenSSH: the user should
 * recognise the moment.
 */
export const browserHostKeyGate: HostKeyGate = {
  confirm: async (p) =>
    window.confirm(
      p.knownFingerprint
        ? `WARNING: the host key for ${p.host}:${p.port} has CHANGED.\n\n` +
            `Was:  ${p.knownFingerprint}\nNow:  ${p.fingerprint} (${p.keyType})\n\n` +
            `The server may have been reinstalled — or someone may be intercepting this connection. ` +
            `Continue only if you know why the key changed.`
        : `The authenticity of ${p.host}:${p.port} can't be established.\n\n` +
            `${p.keyType} key fingerprint:\n${p.fingerprint}\n\n` +
            `Trust this host and continue connecting?`,
    ),
};

/** Hand a finished server-side download to the browser's own download UI. */
function saveToDevice(jobId: string): void {
  const a = document.createElement('a');
  a.href = `/api/dl/${encodeURIComponent(jobId)}`;
  a.download = ''; // the server names it (Content-Disposition)
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** pear-server stamps this into index.html when it serves the app. */
export function servedByPearServer(): boolean {
  return document.querySelector('meta[name="pear-remote"]') !== null;
}

/**
 * The browser half of core's remote client: a real WebSocket, the login
 * probe, and the page-lifecycle hooks. iPadOS freezes a home-screen app the
 * moment it leaves the foreground and thaws it with sockets that look open
 * and are not — so every return to the foreground re-proves the link.
 */
export function connectToPearServer(
  hostKeyGate: HostKeyGate = browserHostKeyGate,
  locals: Parameters<typeof createRemoteBackend>[0]['locals'] = {},
): PearServerBackend {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const backend = createRemoteBackend({
    url: `${scheme}//${location.host}/api/ws`,
    socket: (url) => new WebSocket(url) as unknown as WebSocketLike,
    checkAuth: async () => (await fetch('/api/session', { cache: 'no-store' })).status !== 401,
    hostKeyGate,
    locals,
  });

  backend.remote.onState((state) => {
    if (state === 'unauthorized') location.assign('/login');
  });
  const wake = (): void => {
    if (document.visibilityState === 'visible') backend.remote.resume();
  };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('pageshow', wake);
  window.addEventListener('online', wake);

  // "Download to my machine": the server stages the files; when its job is
  // done the browser fetches them with an ordinary same-origin GET.
  const mine = new Set<string>();
  const startDownload = backend.transfers.download;
  backend.transfers.download = async (...args) => {
    const jobId = await startDownload(...args);
    mine.add(jobId);
    return jobId;
  };
  backend.transfers.onUpdate((job) => {
    if (!mine.has(job.id) || job.status === 'queued' || job.status === 'running') return;
    mine.delete(job.id);
    if (job.status === 'done') saveToDevice(job.id);
  });

  // The native-dialog upload of the desktop API, done the browser's way.
  backend.fs.upload = async (hostId, remoteDir, conflict, verify) => {
    const files = await pickFiles();
    if (files.length) await uploadFiles(hostId, remoteDir, files, conflict, verify);
  };

  return Object.assign(backend, {
    uploadFiles,
    pickAndUpload: async (hostId: string, dir: string) => {
      const files = await pickFiles();
      if (!files.length) return null;
      await uploadFiles(hostId, dir, files);
      return 'uploaded';
    },
  });
}
