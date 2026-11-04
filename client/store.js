// Everything stays in this browser: small things (keys, chat lists, messages)
// in localStorage, photos and files in IndexedDB. Both can be missing or
// refuse to save (private windows, full disks), so every call is guarded and
// files fall back to memory for the session.

export const store = {
  get(k, fallback) {
    try { const v = localStorage.getItem("fm." + k); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(k, v) {
    try { localStorage.setItem("fm." + k, JSON.stringify(v)); return true; } catch { return false; }
  },
  remove(k) { try { localStorage.removeItem("fm." + k); } catch {} },
  keys(prefix) {
    try { return Object.keys(localStorage).filter((k) => k.startsWith("fm." + prefix)).map((k) => k.slice(3)); } catch { return []; }
  },
  clearAll() {
    try { Object.keys(localStorage).filter((k) => k.startsWith("fm.")).forEach((k) => localStorage.removeItem(k)); } catch {}
  },
};

// ---------- files (IndexedDB) ----------

const memory = new Map();
let dbPromise = null;

function db() {
  dbPromise ||= new Promise((resolve) => {
    try {
      const req = indexedDB.open("freemessenger", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("files");
      req.onsuccess = () => resolve(req.result);
      req.onerror = req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx(mode, run) {
  return db().then((d) => new Promise((resolve) => {
    if (!d) return resolve(undefined);
    try {
      const t = d.transaction("files", mode);
      const req = run(t.objectStore("files"));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = t.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  }));
}

export const files = {
  async put(id, blob) {
    memory.set(id, blob);
    await tx("readwrite", (s) => s.put(blob, id));
  },
  async get(id) {
    if (memory.has(id)) return memory.get(id);
    const blob = await tx("readonly", (s) => s.get(id));
    if (blob) memory.set(id, blob);
    return blob || null;
  },
  async remove(id) {
    memory.delete(id);
    await tx("readwrite", (s) => s.delete(id));
  },
  async clearAll() {
    memory.clear();
    await tx("readwrite", (s) => s.clear());
  },
};
