// FreeMessenger's service worker: lets the app open without a connection,
// and shows notifications the relay sends while the site is closed.
// Only browsers new enough to have service workers run this file.

const CACHE = "freemessenger-v7";

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

// ---------- big file downloads, streamed straight to disk ----------
//
// The page hands over the file's details; a hidden frame then opens
// ./__download/<id>/<name>, and this answers it with the file, fetched and
// decrypted a few pieces ahead, so even 10 GB never has to fit in memory.

const downloads = new Map();
self.addEventListener("message", (e) => {
  const d = e.data;
  if (d && d.type === "download" && typeof d.id === "string") {
    downloads.set(d.id, d);
    setTimeout(() => downloads.delete(d.id), 3 * 3600e3);
  }
});

const counter = (i) => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, i); return a; };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function getPiece(d, key, i) {
  for (let attempt = 0, waited = 0; ; attempt++) {
    try {
      const r = await fetch(`${d.base}/api/blob/${d.token}/${d.bid}/${i}`);
      if (r.status === 425 && waited < 2 * 3600e3) { await new Promise((ok) => setTimeout(ok, 1500)); waited += 1500; attempt--; continue; }
      if (!r.ok) throw Object.assign(new Error("download " + r.status), { fatal: r.status === 404 || r.status === 410 || r.status === 403 });
      const data = new Uint8Array(await r.arrayBuffer());
      return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: data.subarray(0, 12), additionalData: counter(i) }, key, data.subarray(12)));
    } catch (err) {
      if (err.fatal || attempt >= 5) throw err;
      await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1)));
    }
  }
}

function streamDownload(d) {
  let key = null;
  let next = 0;
  let out = 0;
  const pending = new Map();
  const ahead = () => { while (next < d.chunks && pending.size < 4) { const i = next++; pending.set(i, getPiece(d, key, i)); } };
  const body = new ReadableStream({
    async start() {
      key = await crypto.subtle.importKey("raw", unb64(d.key), "AES-GCM", false, ["decrypt"]);
    },
    async pull(controller) {
      if (out >= d.chunks) return controller.close();
      ahead();
      try {
        const data = await pending.get(out);
        pending.delete(out);
        out++;
        controller.enqueue(data);
        ahead();
      } catch (err) {
        controller.error(err);
      }
    },
  });
  const name = encodeURIComponent(d.name || "file").replace(/['()]/g, escape);
  return new Response(body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${name}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// The network first, so updates show up right away; the saved copy when offline.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const dl = new URL(req.url).pathname.match(/\/__download\/([a-z0-9]+)\//);
  if (dl && downloads.has(dl[1])) {
    const d = downloads.get(dl[1]);
    downloads.delete(dl[1]);
    e.respondWith(streamDownload(d));
    return;
  }
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
