// 앱 파일만 캐시합니다. 상담 자료(IndexedDB, PC 폴더)는 건드리지 않고, 외부 요청은 차단합니다.
const CACHE = 'consult-pwa-v3';
const FILES = ['./', './index.html', './core.js', './store.js', './app.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(n => n !== CACHE && n.startsWith('consult-pwa-')).map(n => caches.delete(n)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (new URL(e.request.url).origin !== location.origin) { e.respondWith(Response.error()); return; }
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).catch(() => e.request.mode === 'navigate' ? caches.match('./index.html') : Response.error())));
});
