// End-to-end encryption using only the browser's built-in WebCrypto.
// Each user has two P-256 key pairs:
//   sig  — ECDSA, proves to the relay that you own your username
//   ecdh — key agreement; two users derive the same AES-256-GCM key from
//          their own private key and the other person's public key.

const subtle = crypto.subtle;
const SIG = { name: "ECDSA", namedCurve: "P-256" };
const ECDH = { name: "ECDH", namedCurve: "P-256" };

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function createIdentity(username) {
  const sig = await subtle.generateKey(SIG, true, ["sign", "verify"]);
  const ecdh = await subtle.generateKey(ECDH, true, ["deriveKey"]);
  return {
    username,
    sigPriv: await subtle.exportKey("jwk", sig.privateKey),
    sigPub: await subtle.exportKey("jwk", sig.publicKey),
    ecdhPriv: await subtle.exportKey("jwk", ecdh.privateKey),
    ecdhPub: await subtle.exportKey("jwk", ecdh.publicKey),
  };
}

export async function signChallenge(identity, challenge) {
  const key = await subtle.importKey("jwk", identity.sigPriv, SIG, false, ["sign"]);
  const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(challenge));
  return b64(sig);
}

const sharedKeys = new Map();

async function sharedKey(identity, theirEcdhPub) {
  const cacheKey = theirEcdhPub.x + theirEcdhPub.y;
  if (!sharedKeys.has(cacheKey)) {
    const priv = await subtle.importKey("jwk", identity.ecdhPriv, ECDH, false, ["deriveKey"]);
    const pub = await subtle.importKey("jwk", theirEcdhPub, ECDH, false, []);
    sharedKeys.set(cacheKey, await subtle.deriveKey(
      { name: "ECDH", public: pub }, priv, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
    ));
  }
  return sharedKeys.get(cacheKey);
}

export async function encrypt(identity, theirEcdhPub, payload) {
  const key = await sharedKey(identity, theirEcdhPub);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) });
}

// Throws if the message wasn't really encrypted by the claimed sender.
export async function decrypt(identity, theirEcdhPub, body) {
  const { iv, ct } = JSON.parse(body);
  const key = await sharedKey(identity, theirEcdhPub);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

// Short code both people can compare out loud to confirm nobody is in the middle.
export async function safetyCode(pubA, pubB) {
  const [a, b] = [pubA.x + pubA.y, pubB.x + pubB.y].sort();
  const hash = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(a + b)));
  return [...hash.slice(0, 6)].map((n) => String(n % 100).padStart(2, "0")).join(" ");
}
