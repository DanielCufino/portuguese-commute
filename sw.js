'use strict';
const SHELL_CACHE = 'pt-commute-shell-v3';
const LESSON_PREFIX = 'pt-commute-lesson-v1-';
const BASE = new URL(self.registration.scope);
const SHELL_FILES = new Map([
  ['index.html', 'text/html'],
  ['styles.css', 'text/css'],
  ['app.js', 'javascript'],
  ['offline.js', 'javascript'],
  ['manifest.webmanifest', 'json'],
  ['icon.svg', 'image/svg+xml'],
  ['apple-touch-icon.png', 'image/png'],
  ['course-data.json', 'json']
].map(([path, type]) => [new URL(path, BASE).href, type]));

async function validShell(response, type) {
  if (!response.ok || response.status !== 200 || response.redirected) return false;
  const mime = (response.headers.get('content-type') || '').toLowerCase();
  if (!mime.includes(type)) return false;
  if (type === 'text/html') {
    const html = await response.clone().text();
    return /<meta\s+name=["']portuguese-commute["']\s+content=["']offline-study["']\s*\/?\s*>/i.test(html);
  }
  if (type === 'json') {
    try { await response.clone().json(); } catch { return false; }
  }
  return true;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // Validate the full shell first so a host's authentication page never replaces it.
    const files = await Promise.all([...SHELL_FILES].map(async ([url, type]) => {
      const response = await fetch(url, { cache: 'reload', credentials: 'same-origin' });
      if (!(await validShell(response, type))) throw new Error('App shell unavailable: ' + new URL(url).pathname);
      return [url, response];
    }));
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(files.map(([url, response]) => cache.put(url, response)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('pt-commute-shell-') && name !== SHELL_CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

// null means an invalid/unsupported range (serve 200); false means unsatisfiable (416).
function parseRange(header, length) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!length) return false;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!suffix) return false;
    return { start: Math.max(0, length - suffix), end: length - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : length - 1;
  if (start >= length || end < start) return false;
  return { start, end: Math.min(end, length - 1) };
}

async function rangeResponse(response, header) {
  const body = await response.arrayBuffer();
  const range = parseRange(header, body.byteLength);
  const headers = new Headers(response.headers);
  headers.set('accept-ranges', 'bytes');
  headers.delete('content-encoding');
  if (range === false) {
    headers.set('content-range', 'bytes */' + body.byteLength);
    headers.set('content-length', '0');
    return new Response(null, { status: 416, statusText: 'Range Not Satisfiable', headers });
  }
  if (range === null) {
    headers.set('content-length', String(body.byteLength));
    headers.delete('content-range');
    return new Response(body, { status: 200, headers });
  }
  headers.set('content-range', `bytes ${range.start}-${range.end}/${body.byteLength}`);
  headers.set('content-length', String(range.end - range.start + 1));
  return new Response(body.slice(range.start, range.end + 1), { status: 206, statusText: 'Partial Content', headers });
}

async function findLessonAsset(request) {
  for (const name of await caches.keys()) {
    if (!name.startsWith(LESSON_PREFIX)) continue;
    const cached = await (await caches.open(name)).match(request.url);
    if (cached && cached.status === 200) return cached;
  }
}

async function serveShell(request, key, type) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(key);
  if (cached) return cached;
  const response = await fetch(request);
  if (await validShell(response, type)) await cache.put(key, response.clone());
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname)) return;
  const indexURL = new URL('index.html', BASE).href;
  if (request.mode === 'navigate' && (url.pathname === BASE.pathname || url.pathname === new URL(indexURL).pathname)) {
    event.respondWith(serveShell(request, indexURL, 'text/html'));
    return;
  }
  if (SHELL_FILES.has(url.href)) {
    event.respondWith(serveShell(request, url.href, SHELL_FILES.get(url.href)));
    return;
  }
  if (url.pathname.startsWith(new URL('media/', BASE).pathname) || url.pathname.startsWith(new URL('pages/', BASE).pathname)) {
    event.respondWith((async () => {
      const cached = await findLessonAsset(request);
      if (cached) return request.headers.has('range') ? rangeResponse(cached, request.headers.get('range')) : cached;
      // Preserve the original Range header for files that have not been downloaded.
      return fetch(request);
    })());
  }
});
