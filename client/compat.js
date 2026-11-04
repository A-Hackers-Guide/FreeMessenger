// Small stand-ins for browser features that older browsers, privacy browsers
// and pages opened through proxies don't have. The build turns newer
// JavaScript syntax into older syntax; these cover the missing functions.

if (!String.prototype.padStart) {
  String.prototype.padStart = function (len, fill) {
    const s = String(this);
    if (s.length >= len) return s;
    let pad = "";
    while (pad.length + s.length < len) pad += fill === undefined ? " " : String(fill);
    return (pad + s).slice(-len);
  };
}
if (!Object.values) Object.values = (o) => Object.keys(o).map((k) => o[k]);
if (!Object.entries) Object.entries = (o) => Object.keys(o).map((k) => [k, o[k]]);
if (!Array.prototype.includes) {
  Array.prototype.includes = function (x) { return this.indexOf(x) !== -1; };
}
if (typeof Promise !== "undefined" && !Promise.prototype.finally) {
  Promise.prototype.finally = function (f) {
    return this.then((v) => Promise.resolve(f()).then(() => v), (e) => Promise.resolve(f()).then(() => { throw e; }));
  };
}

const rand = (n) => {
  const c = window.crypto || window.msCrypto;
  return c.getRandomValues(new Uint8Array(n));
};

export function uuid() {
  if (window.crypto && crypto.randomUUID) {
    try { return crypto.randomUUID(); } catch {}
  }
  const b = rand(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.prototype.map.call(b, (x) => (x + 0x100).toString(16).slice(1)).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const randomBytes = rand;

export function utf8(text) {
  if (window.TextEncoder) return new TextEncoder().encode(text);
  const s = unescape(encodeURIComponent(text));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function fromUtf8(bytes) {
  if (window.TextDecoder) return new TextDecoder().decode(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return decodeURIComponent(escape(s));
}

export function b64(bytes) {
  bytes = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function clear(el) {
  if (el.replaceChildren) el.replaceChildren();
  else while (el.firstChild) el.removeChild(el.firstChild);
}

export function readFileText(file) {
  if (file.text) return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

// <dialog> arrived in Safari only in 2022; older browsers get the same box
// shown as a plain overlay.
export function openDialog(d) {
  if (d.showModal) return d.showModal();
  d.setAttribute("open", "");
  d.classList.add("dialog-fallback");
}
export function closeDialog(d) {
  if (d.close) return d.close();
  d.removeAttribute("open");
  d.classList.remove("dialog-fallback");
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext !== false) return await navigator.clipboard.writeText(text);
  } catch {}
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  document.body.removeChild(ta);
  if (!ok) window.prompt("Copy this link:", text);
}

export const AudioCtx = window.AudioContext || window.webkitAudioContext;

export const canCall = () =>
  !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
