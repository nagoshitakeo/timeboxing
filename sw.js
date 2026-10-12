// 開くたびに最新のファイルを取りに行く（GitHub Pages の10分キャッシュで更新が遅れるのを防ぐ）。
// 変更がなければサーバーは「変わっていない」とだけ返すので軽い。電波がないときは前回の分で起動する。
const CACHE = 'timebox';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return; // Supabase などはそのまま
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      return (await cache.match(req, { ignoreSearch: true })) || Response.error();
    }
  })());
});
