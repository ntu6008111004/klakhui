// Service worker: cache ตัวแอป + คลังคำ + ฟอนต์ ให้เปิดได้ตอนออฟไลน์
// เสียงประโยคด่วนเก็บใน "qp-audio-v1" (ฝั่งแอปเป็นคนใส่) — ไม่ลบตอนอัปเดตเวอร์ชัน
const VERSION = "v4-2026-11-16";
const SHELL = `shell-${VERSION}`;
const RUNTIME = "runtime-v1";
const KEEP = new Set([SHELL, RUNTIME, "qp-audio-v1"]);

const FILES = [
  "./", "index.html", "manifest.webmanifest", "css/app.css",
  "js/app.js", "js/api.js", "js/audio.js", "js/config.js", "js/db.js", "js/headset.js", "js/listen-mode.js", "js/stt.js", "js/ui.js", "js/camera.js",
  "js/core/glossary.js", "js/core/id.js", "js/core/image.js", "js/core/limiter.js", "js/core/listen.js", "js/core/retry.js", "js/core/sse.js", "js/core/text.js", "js/core/tone.js",
  "data/quick-phrases.json", "data/glossary/zh.json", "data/glossary/en.json", "data/glossary/ja.json", "data/glossary/ko.json", "data/glossary/th.json", "data/glossary/learned.json",
  "icons/logo.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/favicon-32.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => !KEEP.has(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // API ไม่ cache (network-only)
  if (url.pathname.startsWith("/api/")) return;
  // ฟอนต์ Google: stale-while-revalidate
  if (url.host === "fonts.googleapis.com" || url.host === "fonts.gstatic.com") {
    e.respondWith(
      caches.open(RUNTIME).then(async (c) => {
        const hit = await c.match(req);
        const net = fetch(req).then((r) => { if (r.ok || r.type === "opaque") c.put(req, r.clone()); return r; }).catch(() => hit);
        return hit || net;
      }),
    );
    return;
  }
  if (url.origin !== location.origin) return;
  // เสียงประโยคด่วนที่ cache ไว้
  if (url.pathname.includes("/__tts/")) {
    e.respondWith(caches.open("qp-audio-v1").then((c) => c.match(req)).then((r) => r || new Response("", { status: 404 })));
    return;
  }
  // ไฟล์แอป: network-first (ได้ของใหม่เสมอเมื่อออนไลน์) → ล้มแล้วใช้ cache
  e.respondWith(
    fetch(req)
      .then((r) => { if (r.ok) caches.open(SHELL).then((c) => c.put(req, r.clone())); return r; })
      .catch(async () => (await caches.match(req)) || (req.mode === "navigate" ? caches.match("index.html") : Response.error())),
  );
});
