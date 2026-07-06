// ============================================================================
//  sw.js — minimal service worker for offline/installability.
//  Network-first (so the app never serves stale code during development), with
//  a runtime cache fallback for offline. The Supabase API is never cached —
//  those requests must always hit the network for fresh data + auth.
// ============================================================================
const CACHE = "hp-cache-v1";
const SHELL = [
  "./", "./index.html", "./manifest.webmanifest", "./icon.svg",
  "./js/app.js", "./js/store.js", "./js/engine.js", "./js/sheet.js",
  "./js/finances.js", "./js/projects.js", "./js/forecast.js",
  "./js/tasks.js", "./js/settings.js",
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Never intercept cross-origin (Supabase, esm.sh, fonts, CDNs) — let them pass.
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy).catch(() => {}));
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html")))
  );
});
