// FreeMessenger's service worker: lets the app open without a connection,
// and shows notifications the relay sends while the site is closed.
// Only browsers new enough to have service workers run this file.

const CACHE = "freemessenger-v6";

// Do Not Disturb hours, saved by the app in IndexedDB.
function dndNow() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open("freemessenger", 1);
      req.onsuccess = () => {
        try {
          const g = req.result.transaction("files").objectStore("files").get("dnd");
          g.onsuccess = () => {
            const d = g.result;
            if (!d || !d.on) return resolve(false);
            const now = new Date();
            const mins = now.getHours() * 60 + now.getMinutes();
            const [a, b] = [d.from, d.to].map((t) => { const [h, m] = String(t || "0:0").split(":").map(Number); return h * 60 + m; });
            resolve(a <= b ? mins >= a && mins < b : mins >= a || mins < b);
          };
          g.onerror = () => resolve(false);
        } catch { resolve(false); }
      };
      req.onerror = () => resolve(false);
    } catch { resolve(false); }
  });
}
const SHELL = ["./", "index.html", "style.css", "app.min.js", "crypto-fallback.min.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-192.png", "icon-maskable-512.png", "apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The network first, so updates show up right away; the saved copy when offline.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : undefined))),
  );
});

self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch {}
  const from = typeof data.from === "string" ? "@" + data.from : "Someone";
  const call = data.kind === "call";
  const title = call ? `Missed call from ${from}` : `New message from ${from}`;
  e.waitUntil(
    Promise.all([self.clients.matchAll({ type: "window", includeUncontrolled: true }), dndNow()]).then(([list, quiet]) => {
      // The open page already shows it.
      if (list.some((c) => c.visibilityState === "visible")) return;
      return self.registration.showNotification(title, {
        silent: quiet,
        body: call ? "Open FreeMessenger to call back." : "Open FreeMessenger to read it.",
        tag: data.from ? "chat:" + data.from : "freemessenger",
        data: { chat: typeof data.from === "string" ? data.from : null },
        icon: "icon-192.png",
        badge: "icon-192.png",
        renotify: true,
      });
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const chat = e.notification.data && e.notification.data.chat;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => "focus" in c);
      if (open) {
        if (chat) open.postMessage({ type: "open", chat });
        return open.focus();
      }
      return self.clients.openWindow(chat ? "./?open=" + encodeURIComponent(chat) : "./");
    }),
  );
});
