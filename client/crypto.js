// End-to-end encryption. Each user has two P-256 key pairs:
//   sig  — ECDSA, proves to the relay that you own your username
//   ecdh — key agreement; two users derive the same AES-256-GCM key from
//          their own private key and the other person's public key.
//
// It uses the browser's built-in WebCrypto. Browsers only offer WebCrypto on
// https:// pages, so when FreeMessenger is opened through a plain-http proxy
// (or in a browser whose WebCrypto lacks these algorithms) it loads the
// audited @noble libraries instead. Both produce exactly the same keys,
// signatures and ciphertext, so the two kinds of users can talk to each other.

import { utf8, fromUtf8, b64, unb64, randomBytes } from "./compat.js";

const SIG = { name: "ECDSA", namedCurve: "P-256" };
const ECDH = { name: "ECDH", namedCurve: "P-256" };

const b64url = (bytes) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s) => unb64(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

// ---------- WebCrypto ----------

const web = {
  subtle: () => window.crypto.subtle,
  async createKeys() {
    const subtle = this.subtle();
    const sig = await subtle.generateKey(SIG, true, ["sign", "verify"]);
    const ecdh = await subtle.generateKey(ECDH, true, ["deriveKey"]);
    return {
      sigPriv: await subtle.exportKey("jwk", sig.privateKey),
      sigPub: await subtle.exportKey("jwk", sig.publicKey),
      ecdhPriv: await subtle.exportKey("jwk", ecdh.privateKey),
      ecdhPub: await subtle.exportKey("jwk", ecdh.publicKey),
    };
  },
  async sign(sigPriv, bytes) {
    const key = await this.subtle().importKey("jwk", sigPriv, SIG, false, ["sign"]);
    return new Uint8Array(await this.subtle().sign({ name: "ECDSA", hash: "SHA-256" }, key, bytes));
  },
  async sharedKey(ecdhPriv, theirPub) {
    const subtle = this.subtle();
    const priv = await subtle.importKey("jwk", ecdhPriv, ECDH, false, ["deriveKey"]);
    const pub = await subtle.importKey("jwk", theirPub, ECDH, false, []);
    return subtle.deriveKey({ name: "ECDH", public: pub }, priv, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  },
  async encrypt(key, iv, bytes) {
    return new Uint8Array(await this.subtle().encrypt({ name: "AES-GCM", iv }, key, bytes));
  },
  async decrypt(key, iv, bytes) {
    return new Uint8Array(await this.subtle().decrypt({ name: "AES-GCM", iv }, key, bytes));
  },
  async sha256(bytes) {
    return new Uint8Array(await this.subtle().digest("SHA-256", bytes));
  },
};

// ---------- @noble fallback ----------

function loadNoble() {
  if (window.FMNoble) return Promise.resolve(window.FMNoble);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    const me = document.querySelector('script[src*="app.min.js"]');
    s.src = me ? me.src.replace(/app\.min\.js.*$/, "crypto-fallback.min.js") : "crypto-fallback.min.js";
    s.onload = () => (window.FMNoble ? resolve(window.FMNoble) : reject(new Error("no FMNoble")));
    s.onerror = () => reject(new Error("couldn't load crypto-fallback.min.js"));
    document.head.appendChild(s);
  });
}

const noble = (N) => {
  const pubBytes = (jwk) => concat(new Uint8Array([4]), unb64url(jwk.x), unb64url(jwk.y));
  const keyPair = () => {
    const d = N.p256.utils.randomPrivateKey();
    const pub = N.p256.getPublicKey(d, false);
    const jwk = { kty: "EC", crv: "P-256", x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33)), ext: true };
    return { priv: Object.assign({ d: b64url(d) }, jwk), pub: jwk };
  };
  return {
    async createKeys() {
      const sig = keyPair();
      const ecdh = keyPair();
      return { sigPriv: sig.priv, sigPub: sig.pub, ecdhPriv: ecdh.priv, ecdhPub: ecdh.pub };
    },
    async sign(sigPriv, bytes) {
      return N.p256.sign(N.sha256(bytes), unb64url(sigPriv.d)).toCompactRawBytes();
    },
    async sharedKey(ecdhPriv, theirPub) {
      // WebCrypto's ECDH → AES-256 key is the shared point's x coordinate.
      return N.p256.getSharedSecret(unb64url(ecdhPriv.d), pubBytes(theirPub), true).slice(1);
    },
    async encrypt(key, iv, bytes) { return N.gcm(key, iv).encrypt(bytes); },
    async decrypt(key, iv, bytes) { return N.gcm(key, iv).decrypt(bytes); },
    async sha256(bytes) { return N.sha256(bytes); },
  };
};

// Checks once that this browser's WebCrypto can do everything we need.
async function webCryptoWorks() {
  try {
    if (!window.crypto || !window.crypto.subtle || window.isSecureContext === false) return false;
    const k = await web.createKeys();
    const key = await web.sharedKey(k.ecdhPriv, k.ecdhPub);
    const iv = randomBytes(12);
    const ct = await web.encrypt(key, iv, utf8("test"));
    await web.sign(k.sigPriv, ct);
    return fromUtf8(await web.decrypt(key, iv, ct)) === "test";
  } catch {
    return false;
  }
}

let enginePromise = null;
function engine() {
  enginePromise ||= webCryptoWorks().then(async (ok) => {
    if (ok) return web;
    try {
      return noble(await loadNoble());
    } catch {
      throw new Error("This browser can't encrypt messages. Open FreeMessenger in a newer browser, or with https:// in the address.");
    }
  });
  return enginePromise;
}

export const ready = () => engine().then(() => true);

// ---------- what the app uses ----------

export async function createIdentity(username) {
  return { username, ...(await (await engine()).createKeys()) };
}

export async function signChallenge(identity, challenge) {
  return b64(await (await engine()).sign(identity.sigPriv, utf8(challenge)));
}

const sharedKeys = new Map();

async function sharedKey(identity, theirEcdhPub) {
  const cacheKey = theirEcdhPub.x + theirEcdhPub.y;
  if (!sharedKeys.has(cacheKey)) {
    sharedKeys.set(cacheKey, await (await engine()).sharedKey(identity.ecdhPriv, theirEcdhPub));
  }
  return sharedKeys.get(cacheKey);
}

export async function encrypt(identity, theirEcdhPub, payload) {
  const key = await sharedKey(identity, theirEcdhPub);
  const iv = randomBytes(12);
  const ct = await (await engine()).encrypt(key, iv, utf8(JSON.stringify(payload)));
  return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) });
}

// Throws if the message wasn't really encrypted by the claimed sender.
export async function decrypt(identity, theirEcdhPub, body) {
  const { iv, ct } = JSON.parse(body);
  const key = await sharedKey(identity, theirEcdhPub);
  const pt = await (await engine()).decrypt(key, unb64(iv), unb64(ct));
  return JSON.parse(fromUtf8(pt));
}

// Short code both people can compare out loud to confirm nobody is in the middle.
export async function safetyCode(pubA, pubB) {
  const [a, b] = [pubA.x + pubA.y, pubB.x + pubB.y].sort();
  const hash = await (await engine()).sha256(utf8(a + b));
  return Array.prototype.slice.call(hash, 0, 6).map((n) => String(n % 100).padStart(2, "0")).join(" ");
}
