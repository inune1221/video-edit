// オフラインでも使えるようにするための Service Worker
// アプリ本体: ネット優先（更新がすぐ反映される）、つながらなければキャッシュを使う
// フォント: キャッシュ優先（一度使ったフォントはオフラインでも使える）
const APP = 'app-v1';
const FONTS = 'fonts-v1';
const SHELL = ['./', 'index.html', 'style.css', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png',
  'js/app.js', 'js/project.js', 'js/render.js', 'js/fonts.js', 'js/audio.js', 'js/media.js', 'js/vendor/mediabunny.min.mjs'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== APP && k !== FONTS).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(APP).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
});
