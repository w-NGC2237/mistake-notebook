/* 考公错题本 · 离线缓存
 * 只缓存界面外壳和本地识别引擎；所有 /api/ 请求一律走网络，不缓存。
 */
const CACHE = "cuotiben-v3";
const SHELL = [
  "./",
  "index.html",
  "app.js",
  "style.css",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "lib/classifier.js",
  "lib/classifier_data.js",
  "lib/parser.js",
  "lib/localdb.js",
  "lib/localocr.js",
  "lib/imageproc.js",
  "lib/crop.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  if (url.origin !== location.origin) return;

  // 模型和 wasm 内容不会变，缓存优先，省流量也更快
  if (url.pathname.includes("/vendor/")) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      }))
    );
    return;
  }

  // 界面代码用网络优先，避免改了代码还看到旧的
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(e.request).then((hit) => hit || caches.match("index.html")))
  );
});
