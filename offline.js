/* Downloads stay in this browser's website storage, which the device can clear. */
(() => {
  'use strict';
  const base = new URL('.', document.currentScript.src);
  const prefix = 'pt-commute-lesson-v1-';
  const downloads = new Map();
  let registrationPromise;

  function ready() {
    if (!registrationPromise) {
      registrationPromise = (async () => {
        if (!window.isSecureContext || !('serviceWorker' in navigator) || !('caches' in window)) {
          return { supported: false, reason: 'Offline downloads need this app opened over HTTPS in Safari, not as a file preview.' };
        }
        const registration = await navigator.serviceWorker.register(new URL('sw.js', base), { scope: base.pathname });
        if (registration.active?.state !== 'activated') {
          const worker = registration.installing || registration.waiting || registration.active;
          if (!worker) throw new Error('Offline setup could not start. Reload while online and try again.');
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => finish(new Error('Offline setup did not finish. Reload while online and try again.')), 30000);
            const check = () => {
              if (worker.state === 'activated') finish();
              if (worker.state === 'redundant') finish(new Error('Offline setup failed. Open the app online, sign in if needed, then reload.'));
            };
            const finish = error => {
              clearTimeout(timer);
              worker.removeEventListener('statechange', check);
              error ? reject(error) : resolve();
            };
            worker.addEventListener('statechange', check);
            check();
          });
        }
        return { supported: true, registration };
      })();
      registrationPromise.catch(() => { registrationPromise = undefined; });
    }
    return registrationPromise;
  }

  function assetsFor(lesson) {
    if (!lesson || typeof lesson.id !== 'string' || !lesson.id) throw new Error('This lesson has no download identifier.');
    const assets = new Map();
    const pages = [...(lesson.pages || []), { src: 'pages/326.webp' }, { src: 'pages/327.webp' }];
    for (const [items, type] of [[lesson.tracks || [], 'audio'], [pages, 'image']]) {
      for (const item of items) {
        const url = new URL(item.src, base);
        if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.hash || !item.src) {
          throw new Error('A lesson file is outside this app. It cannot be saved for offline use.');
        }
        if (assets.has(url.href) && assets.get(url.href) !== type) throw new Error('Conflicting lesson file types.');
        assets.set(url.href, type);
      }
    }
    if (!(lesson.tracks?.length || lesson.pages?.length)) throw new Error('This lesson has no files to download yet.');
    return [...assets].map(([url, type]) => ({ url, type }));
  }

  function cacheName(lesson) { return prefix + encodeURIComponent(lesson.id); }
  function valid(response, type) {
    return response && response.status === 200 && !response.redirected &&
      (response.headers.get('content-type') || '').toLowerCase().startsWith(type + '/') &&
      response.headers.get('content-length') !== '0';
  }

  async function isLessonSaved(lesson) {
    if (!('caches' in window)) return false;
    const assets = assetsFor(lesson);
    if (!(await caches.has(cacheName(lesson)))) return false;
    const cache = await caches.open(cacheName(lesson));
    for (const asset of assets) {
      if (!valid(await cache.match(asset.url), asset.type)) return false;
    }
    return true;
  }

  async function requestPersistence() {
    try {
      if (await navigator.storage?.persisted?.()) return true;
      return Boolean(await navigator.storage?.persist?.());
    } catch { return false; }
  }

  function downloadLesson(lesson, callback = () => {}) {
    const assets = assetsFor(lesson);
    const name = cacheName(lesson);
    if (downloads.has(name)) return downloads.get(name);
    const job = (async () => {
      const state = await ready();
      if (!state.supported) throw new Error(state.reason);
      await requestPersistence();
      const cache = await caches.open(name);
      let completed = 0;
      let bytes = 0;
      callback({ completed, total: assets.length, bytes });
      for (const asset of assets) {
        let response = await cache.match(asset.url);
        if (!valid(response, asset.type)) {
          response = await fetch(asset.url, { cache: 'no-store', credentials: 'same-origin' });
          if (!valid(response, asset.type)) {
            throw new Error('A lesson file was unavailable or returned a sign-in page. Open the app online, sign in if needed, then retry.');
          }
          const body = await response.arrayBuffer();
          if (!body.byteLength) throw new Error('A lesson file was empty. Please retry while online.');
          const headers = new Headers(response.headers);
          headers.set('content-length', String(body.byteLength));
          headers.delete('content-encoding');
          await cache.put(asset.url, new Response(body, { status: 200, headers }));
          bytes += body.byteLength;
        } else {
          bytes += Number(response.headers.get('content-length')) || 0;
        }
        completed++;
        callback({ completed, total: assets.length, bytes });
      }
      if (!(await isLessonSaved(lesson))) throw new Error('Some files were not retained. Free device space and retry the download.');
      return { saved: true, completed, total: assets.length, bytes };
    })().catch(error => {
      if (error.name === 'QuotaExceededError') throw new Error('There is not enough browser storage. Remove another downloaded lesson or free device space, then retry.');
      if (error.name === 'TypeError') throw new Error('The download could not finish. Check your connection and retry; completed files are kept.');
      throw error;
    }).finally(() => { downloads.delete(name); });
    downloads.set(name, job);
    return job;
  }

  async function removeLesson(lesson) {
    assetsFor(lesson);
    if (downloads.has(cacheName(lesson))) throw new Error('Wait for this download to finish before removing it.');
    if ('caches' in window) await caches.delete(cacheName(lesson));
    return { saved: false };
  }

  window.PortugueseOffline = Object.freeze({ ready, downloadLesson, isLessonSaved, removeLesson, requestPersistence });
})();
