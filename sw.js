// Service worker: makes the game load and play offline after the first visit.
//   install   walks the import graph from index.html / main.js and caches every file, so one online
//             visit is enough (no file list to keep in sync).
//   fetch     network-first for same-origin GETs (a new deploy shows up right away when online; the
//             request revalidates so the HTTP cache cannot serve a mix of old and new modules), and the
//             cached copy when the network fails.
// Bump CACHE to drop every old entry. docs/architecture.md (M8, offline).
// Several games can share one origin (github.io/<repo>/ pages do), and caches are per origin, so a worker
// only ever deletes caches that carry its own prefix.

const PREFIX = 'overforged-';
const CACHE = PREFIX + 'v3';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/icon-maskable-512.png'];

// Every module reachable from main.js through static import/export-from statements.
async function moduleGraph() {
  const seen = new Set();
  const queue = ['./src/main.js'];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    try {
      const res = await fetch(rel, { cache: 'no-cache' });
      if (!res.ok) continue;
      const text = await res.text();
      const dir = rel.replace(/[^/]*$/, '');
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
        queue.push(new URL(m[1], new URL(dir, 'http://x/')).pathname.replace(/^\//, './'));
      }
    } catch (e) { /* offline or blocked: skip, runtime caching fills the gap */ }
  }
  return [...seen];
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then(async (c) => {
        await c.addAll(SHELL).catch(() => {});
        const mods = await moduleGraph();
        await Promise.all(mods.map((u) => c.add(u).catch(() => {})));
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
