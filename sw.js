// sw.js — mise en cache de l'appli pour un usage hors ligne (sous-sols, parkings).
// Stratégie « réseau d'abord » : toujours la dernière version si on est en ligne,
// la copie en cache sinon. Incrémenter VERSION quand la liste APP change.
const VERSION = 'v6';
const CACHE = `tetra-walktest-${VERSION}`;
const APP = [
  './', 'index.html', 'manifest.webmanifest', 'icon.svg', 'css/app.css',
  'js/app.js', 'js/protocol.js', 'js/atp.js', 'js/geometry.js', 'js/planview.js', 'js/project.js',
  'js/radio.js', 'js/thresholds.js', 'js/session.js', 'js/simport.js', 'js/render.js', 'js/export.js', 'js/autosave.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(APP)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('tetra-walktest-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
