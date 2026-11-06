// Code shared by the Cloudflare relay (src/index.js) and the home-PC relay
// (server/server.js). Only uses Web APIs both of them have: WebCrypto,
// fetch, TextEncoder, atob/btoa.

export const USERNAME = /^[a-z0-9_]{3,20}$/;
export const RESERVED = new Set([
  "admin", "administrator", "root", "system", "support", "help", "official",
  "freemessenger", "moderator", "mod", "staff", "security", "null", "undefined",
]);
// A file piece is 32 KB, sent once for the person and once for the admin copy.
export const MAX_ENVELOPE_BYTES = 160 * 1024;
export const SITE = "https://a-hackers-guide.github.io/FreeMessenger/";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export function isPublicJwk(k) {
  return !!k && typeof k === "object" && k.kty === "EC" && k.crv === "P-256" &&
    typeof k.x === "string" && typeof k.y === "string" && !("d" in k);
}

export async function verify(jwk, signatureB64, text) {
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const sig = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, new TextEncoder().encode(text));
  } catch {
    return false;
  }
}

export const randomHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

// ---------- send limits ----------
//
// Chat messages (the ones that would notify someone) are limited to one a
// second, with a few allowed back to back. Everything else a client sends on
// its own — file pieces, receipts, typing, call setup — gets a much larger
// allowance, just enough to stop floods.

export class RateLimit {
  constructor() { this.buckets = new Map(); }
  take(key, perSecond, burst) {
    const now = Date.now();
    const b = this.buckets.get(key) || { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * perSecond);
    b.at = now;
    this.buckets.set(key, b);
    if (this.buckets.size > 5000) this.buckets.clear();
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

// One message sent to a whole group is one envelope per member, all with the
// same message id, so it only counts once.
export function allowSend(limiter, username, hint, meta) {
  if (hint !== "msg") return limiter.take("o:" + username, 100, 400);
  const mid = meta && meta.mid;
  const recent = limiter.recent || (limiter.recent = new Map());
  const key = username + ":" + mid;
  if (mid && Date.now() - (recent.get(key) || 0) < 60e3) return limiter.take("o:" + username, 100, 400);
  if (!limiter.take("m:" + username, 1, 5)) return false;
  if (mid) {
    if (recent.size > 5000) recent.clear();
    recent.set(key, Date.now());
  }
  return true;
}

// ---------- profiles ----------

const PROFILE_LIMITS = { display: 40, real: 60, status: 80, bio: 300 };
export const MAX_AVATAR = 90 * 1024;

export function cleanProfile(p) {
  const out = {};
  if (!p || typeof p !== "object") return out;
  for (const [k, max] of Object.entries(PROFILE_LIMITS)) {
    if (typeof p[k] === "string" && p[k].trim()) out[k] = p[k].trim().slice(0, max);
  }
  if (typeof p.avatar === "string" && p.avatar.length <= MAX_AVATAR && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p.avatar)) {
    out.avatar = p.avatar;
  }
  return out;
}

// Small extra details a client may attach to an envelope so the admin panel
// can skip file pieces and put files back together. Never trusted for anything else.
export function cleanMeta(meta) {
  if (!meta || typeof meta !== "object") return undefined;
  const out = {};
  if (meta.k === "chunk" || meta.k === "msg" || meta.k === "control") out.k = meta.k;
  if (typeof meta.fid === "string" && meta.fid.length <= 64) out.fid = meta.fid;
  if (Number.isInteger(meta.i) && meta.i >= 0 && meta.i < 100000) out.i = meta.i;
  if (Number.isInteger(meta.n) && meta.n > 0 && meta.n < 100000) out.n = meta.n;
  if (typeof meta.mid === "string" && meta.mid.length <= 64) out.mid = meta.mid;
  return Object.keys(out).length ? out : undefined;
}

// ---------- TURN (coturn "use-auth-secret" logins) ----------

export async function coturnServers(turn, username) {
  if (!turn || !turn.secret || !turn.host) return [];
  const user = `${Math.floor(Date.now() / 1000) + 6 * 3600}:${username || "guest"}`;
  const key = await crypto.subtle.importKey("raw", enc.encode(turn.secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const credential = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(user)))));
  const port = turn.port || 3478;
  const host = turn.host.includes(":") ? `[${turn.host}]` : turn.host;
  return [{ urls: [`turn:${host}:${port}?transport=udp`, `turn:${host}:${port}?transport=tcp`], username: user, credential }];
}

export const STUN = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

// ---------- signed sync between the home PC and Cloudflare ----------
//
// The home PC holds a private key; Cloudflare only knows the public half
// (PRIMARY_KEY in wrangler.toml), so nothing secret is stored there.

export async function signSync(privateJwk, body) {
  const text = JSON.stringify(body);
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(text));
  return JSON.stringify({ text, sig: btoa(String.fromCharCode(...new Uint8Array(sig))) });
}

export async function openSync(publicJwk, raw) {
  try {
    const { text, sig } = JSON.parse(raw);
    if (!(await verify(publicJwk, sig, text))) return null;
    const body = JSON.parse(text);
    if (!Number.isFinite(body.ts) || Math.abs(Date.now() - body.ts) > 5 * 60e3) return null;
    return body;
  } catch {
    return null;
  }
}

// ---------- Web Push (RFC 8291 encryption, RFC 8292 VAPID) ----------

const enc = new TextEncoder();
export const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

export async function sha256Hex(text) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return [...h.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function makeVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    publicKey: b64u(await crypto.subtle.exportKey("raw", pair.publicKey)),
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
}

export function validPushSub(sub) {
  const endpoint = sub && String(sub.endpoint || "");
  const keys = sub && sub.keys;
  if (!/^https:\/\/[^\s]{10,1000}$/.test(endpoint) || !keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return null;
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

export async function sendPush(sub, payload, vapid, ttl) {
  // Encrypt the payload for this browser (aes128gcm content encoding).
  const uaPublic = unb64u(sub.keys.p256dh);
  const auth = unb64u(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(payload, new Uint8Array([2]))));
  const header = concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPublic.length]), asPublic);

  // Sign a VAPID token so the push service knows which server is sending.
  const aud = new URL(sub.endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SITE })));
  const signKey = await crypto.subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signKey, enc.encode(`${head}.${claims}`));

  return fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${head}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: "high",
    },
    body: concat(header, sealed),
  });
}
