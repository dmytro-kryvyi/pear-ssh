// Pear's service worker. One worker, root scope, for both UIs.
//
// An SSH client is useless offline, so this is not an offline app. The worker
// exists for two things: cold starts that don't re-download megabytes of
// hashed bundles, and a legible page — instead of the browser's error — when
// the server cannot be reached.
//
// There is deliberately no precache list: caching happens as files are used,
// so an iPad on the touch UI never downloads the desktop build (Monaco).

const CACHE = 'pear-assets-v1';
// Angular's content-hashed output: main-GMNDPBRJ.js, chunk-0bT59GVO2.js, media/*.woff2
const HASHED = /-[A-Za-z0-9_-]{8,}\.(js|css|woff2?|ttf|svg|png)$/;

const OFFLINE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark"><title>Pear</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#1b1e24;color:#c9ccd3;font:15px system-ui,sans-serif;text-align:center">
<div><p style="font-size:17px;color:#f1f2f4">Can't reach the Pear server</p>
<p>Your terminals keep running there. Check the network or VPN, then</p>
<p><a href="" style="color:#57b8b0">try again</a></p></div>`;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // Never touch the API, the login flow, or the worker's own plumbing.
  if (url.pathname.startsWith('/api/') || url.pathname === '/login' || url.pathname === '/sw.js') return;

  if (HASHED.test(url.pathname)) {
    // The name changes when the content does: a hit is always right.
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  if (req.mode === 'navigate') {
    // Always the network's index.html (it names the current bundles, and the
    // server may answer with a redirect to /login). Offline → say so.
    event.respondWith(
      fetch(req).catch(
        () => new Response(OFFLINE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
      ),
    );
  }
});
