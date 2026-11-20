// Service worker mínimo: deja la app instalable y abre rápido. Spotify y la librería de QR van siempre a la red.
const CACHE = "vinilo-v4";
const ARCHIVOS = ["./", "index.html", "style.css", "app.js", "config.js", "cartas.json", "reglas.txt", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;            // Spotify, jsQR: directo a la red
  // Primero red (así los cambios del mazo llegan), con la caché como respaldo sin conexión.
  e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
});
