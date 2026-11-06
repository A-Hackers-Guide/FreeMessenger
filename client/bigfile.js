// Big files (over 10 MB, up to 10 GB). They're encrypted here in 4 MB pieces
// with a key made just for that file (AES-256-GCM; each piece's number is
// part of its encryption, so pieces can't be swapped or reordered), uploaded
// to the home server, and the key travels inside the chat message.
//
// Fast: the message goes out as soon as the upload starts, and people can
// download pieces while the rest is still uploading; several pieces move at
// once in both directions.
//
// Short-lived: the home server deletes a big file a few minutes after the
// upload finishes, unless enough people download it in time (the admin sets
// how many, how quickly, and how long it's then kept).

import { b64, unb64 } from "./compat.js";

export const MAX_BIG = 10 * 1024 ** 3;
export const INLINE_MAX = 100 * 1024 * 1024; // up to this, it's downloaded automatically and shown in the chat
const PARALLEL = 4;

let token = null; // { value, until }

async function getToken(conn) {
  if (token && token.until > Date.now()) return token.value;
  const r = await conn.op("blob-token", {});
  if (r.error) throw new Error(r.error);
  token = { value: r.token, until: Date.now() + 10 * 3600e3 };
  return token.value;
}

const counter = (i) => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, i); return a; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const supported = () => !!(window.crypto && crypto.subtle && window.fetch);

// Step 1: reserve the upload and make the key (fast, so the message can go out).
export async function prepare(conn, size) {
  if (!supported()) throw new Error("Files over 10 MB need a newer browser.");
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const start = await conn.op("blob-start", { size });
  if (start.error) throw new Error(start.error);
  return {
    big: { bid: start.bid, key: b64(new Uint8Array(await crypto.subtle.exportKey("raw", key))), chunks: start.chunks, cs: start.chunk },
    cryptoKey: key,
  };
}

// Step 2: upload every piece, a few at a time.
export async function upload({ conn, base, file, prep, onProgress }) {
  const { big, cryptoKey } = prep;
  const tok = await getToken(conn);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < big.chunks) {
      const i = next++;
      const plain = await file.slice(i * big.cs, (i + 1) * big.cs).arrayBuffer();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: counter(i) }, cryptoKey, plain));
      const body = new Uint8Array(12 + ct.length);
      body.set(iv);
      body.set(ct, 12);
      for (let attempt = 0; ; attempt++) {
        try {
          // text/plain keeps it a "simple" request: no extra round trip through proxies.
          const r = await fetch(`${base}/api/blob/${tok}/${big.bid}/${i}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body });
          if (r.ok) break;
          if (r.status === 403 || r.status === 413 || r.status === 404) throw Object.assign(new Error((await r.json().catch(() => ({}))).error || "Upload refused."), { fatal: true });
          throw new Error("upload " + r.status);
        } catch (e) {
          if (e.fatal || attempt >= 6) throw e;
          await sleep(1500 * (attempt + 1));
        }
      }
      done++;
      onProgress && onProgress(done / big.chunks);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, big.chunks) }, worker));
  const fin = await conn.op("blob-finish", { bid: big.bid });
  if (fin.error) throw new Error(fin.error);
}

async function importKey(big) {
  return crypto.subtle.importKey("raw", unb64(big.key), "AES-GCM", false, ["decrypt"]);
}

// One piece, waiting for it if the sender is still uploading it.
async function piece(base, tok, big, key, i) {
  for (let attempt = 0, waited = 0; ; attempt++) {
    try {
      const r = await fetch(`${base}/api/blob/${tok}/${big.bid}/${i}`);
      if (r.status === 425) {
        if (waited > 2 * 3600e3) throw Object.assign(new Error("The sender stopped uploading."), { fatal: true });
        await sleep(1500);
        waited += 1500;
        attempt--;
        continue;
      }
      if (!r.ok) {
        const gone = r.status === 404 || r.status === 410;
        throw Object.assign(new Error(gone ? "This file expired: big files are only kept on the server for a few minutes." : r.status === 403 ? "Not allowed to download this." : "Download failed (" + r.status + ")."), { fatal: gone || r.status === 403, expired: gone });
      }
      const data = new Uint8Array(await r.arrayBuffer());
      return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: data.subarray(0, 12), additionalData: counter(i) }, key, data.subarray(12)));
    } catch (e) {
      if (e.fatal || attempt >= 5) throw e;
      await sleep(1500 * (attempt + 1));
    }
  }
}

// Downloads pieces several at a time but hands them over in order.
async function eachPiece(conn, base, big, onPiece, onProgress) {
  const tok = await getToken(conn);
  const key = await importKey(big);
  const pending = new Map();
  let next = 0;
  const fetchNext = () => {
    if (next >= big.chunks) return;
    const i = next++;
    pending.set(i, piece(base, tok, big, key, i));
  };
  for (let k = 0; k < PARALLEL; k++) fetchNext();
  for (let i = 0; i < big.chunks; i++) {
    const data = await pending.get(i);
    pending.delete(i);
    fetchNext();
    await onPiece(data, i);
    onProgress && onProgress((i + 1) / big.chunks);
  }
}

// The whole file in memory (for ones small enough to show in the chat).
export async function fetchAll({ conn, base, big, type, onProgress }) {
  const parts = [];
  await eachPiece(conn, base, big, (d) => { parts.push(d); }, onProgress);
  return new Blob(parts, { type: type || "application/octet-stream" });
}

// Saves to disk without holding the whole file in memory: straight to a file
// where the browser allows picking one, otherwise as a streamed download
// through the service worker, otherwise (old browsers) in memory.
export async function save({ conn, base, big, name, type, onProgress }) {
  if (!supported()) throw new Error("This browser can't open big files.");
  if (window.showSaveFilePicker) {
    let handle = null;
    try {
      handle = await window.showSaveFilePicker({ suggestedName: name });
    } catch (e) {
      if (e && e.name === "AbortError") return "cancelled";
    }
    if (handle) {
      const out = await handle.createWritable();
      try {
        await eachPiece(conn, base, big, (d) => out.write(d), onProgress);
      } finally {
        await out.close();
      }
      return "saved";
    }
  }
  const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (sw) {
    const tok = await getToken(conn);
    const id = Math.random().toString(36).slice(2);
    sw.postMessage({ type: "download", id, base, token: tok, bid: big.bid, chunks: big.chunks, key: big.key, name, mime: type });
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.src = `./__download/${id}/${encodeURIComponent(name)}`;
    document.body.appendChild(frame);
    setTimeout(() => frame.remove(), 3 * 3600e3);
    return "streaming";
  }
  const blob = await fetchAll({ conn, base, big, type, onProgress });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60e3);
  return "saved";
}

export function cleanBig(big) {
  if (!big || typeof big !== "object") return null;
  if (!/^[0-9a-f]{32}$/.test(String(big.bid)) || typeof big.key !== "string" || big.key.length < 40 || big.key.length > 64) return null;
  const chunks = Number(big.chunks);
  if (!Number.isInteger(chunks) || chunks < 1 || chunks > 4000) return null;
  return { bid: big.bid, key: big.key, chunks, cs: Number(big.cs) || 4194304 };
}
