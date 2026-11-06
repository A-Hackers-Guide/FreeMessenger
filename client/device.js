// This browser's admin device key. The private half is made non-extractable,
// so it can be used to sign but can never be read out or copied, not even by
// this site's own code, and it isn't part of the backup file. The admin's
// home relay trusts the browsers whose keys it knows.

const DB = "fm-device";
let cached = null;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("keys");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, run) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction("keys", mode);
    const req = run(t.objectStore("keys"));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = t.onabort = () => reject(t.error);
  }));
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (buf) => btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));

export function deviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad|iPod/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${browser} on ${os}`;
}

// The saved key, or a new one.
export async function get() {
  if (cached) return cached;
  if (!window.indexedDB || !window.crypto || !crypto.subtle) throw new Error("This browser can't keep a device key.");
  let d = await tx("readonly", (s) => s.get("admin"));
  if (!d) {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    d = { id: hex(crypto.getRandomValues(new Uint8Array(16))), priv: pair.privateKey, pub: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } };
    await tx("readwrite", (s) => s.put(d, "admin"));
  }
  cached = d;
  return d;
}

export async function known() {
  try { return !!(await tx("readonly", (s) => s.get("admin"))); } catch { return false; }
}

export async function sign(text) {
  const d = await get();
  return b64(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, d.priv, new TextEncoder().encode(text)));
}

export async function publicInfo() {
  const d = await get();
  return { id: d.id, pub: d.pub, name: deviceName() };
}
