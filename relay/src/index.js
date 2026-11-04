// FreeMessenger relay — a Cloudflare Worker with one Durable Object per username.
//
// The relay never sees message contents: clients encrypt end-to-end before sending.
// It only (1) remembers each username's public keys, (2) proves who is connected
// by checking a signed challenge, and (3) passes encrypted envelopes along,
// holding them for offline users until they are acknowledged.
//
// Clients connect with a WebSocket, or, where a proxy or filter blocks
// WebSockets, with plain HTTPS requests that poll for new messages.
//
// When someone is offline it can wake their device with a Web Push
// notification that says only who wrote; the message itself stays encrypted
// in the inbox until their browser picks it up.

const USERNAME = /^[a-z0-9_]{3,20}$/;
const RESERVED = new Set([
  "admin", "administrator", "root", "system", "support", "help", "official",
  "freemessenger", "moderator", "mod", "staff", "security", "null", "undefined",
]);
const MAX_ENVELOPE_BYTES = 64 * 1024;   // per message
const MAX_QUEUE = 2000;                 // offline messages kept per user (a 10 MB file is 320 of them)
const QUEUE_TTL_MS = 30 * 24 * 3600e3;  // offline messages expire after 30 days
const SESSION_TTL_MS = 30 * 24 * 3600e3; // HTTP sign-ins last 30 days
const MAX_SESSIONS = 20;                // per user (one per browser)
const POLL_ONLINE_MS = 45e3;            // an HTTP client polled this recently counts as online
const MAX_PUSH_SUBS = 10;               // devices per user that get notifications
const PUSH_GAP_MS = 20e3;               // at most one message notification per user this often
const SITE = "https://a-hackers-guide.github.io/FreeMessenger/";
const VAPID = "vapid-keys";             // Durable Object holding the relay's push key; not a valid username

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function userStub(env, name) {
  return env.USERS.get(env.USERS.idFromName(name));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // POST /api/register  {username, sigPub, ecdhPub}
    if (url.pathname === "/api/register" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      const name = String(body.username || "").toLowerCase();
      if (!USERNAME.test(name)) return json({ error: "Usernames are 3-20 characters: a-z, 0-9 and _" }, 400);
      if (RESERVED.has(name)) return json({ error: "That username is reserved" }, 409);
      if (!isPublicJwk(body.sigPub) || !isPublicJwk(body.ecdhPub)) return json({ error: "bad keys" }, 400);
      return userStub(env, name).fetch("https://do/register", {
        method: "POST",
        body: JSON.stringify({ username: name, sigPub: body.sigPub, ecdhPub: body.ecdhPub }),
      }).then(withCors);
    }

    // GET /api/user/:name  -> public keys
    let m = url.pathname.match(/^\/api\/user\/([a-z0-9_]{3,20})$/);
    if (m && request.method === "GET") {
      return userStub(env, m[1]).fetch("https://do/profile").then(withCors);
    }

    // GET /api/ws/:name  (WebSocket upgrade)
    m = url.pathname.match(/^\/api\/ws\/([a-z0-9_]{3,20})$/);
    if (m) {
      if (request.headers.get("Upgrade") !== "websocket") return json({ error: "expected websocket" }, 426);
      return userStub(env, m[1]).fetch(request);
    }

    // POST /api/http/:name  — the WebSocket protocol over plain requests. Bodies are
    // sent as text/plain so browsers skip the CORS preflight that some proxies break.
    m = url.pathname.match(/^\/api\/http\/([a-z0-9_]{3,20})$/);
    if (m && request.method === "POST") {
      const body = await request.text();
      if (body.length > MAX_ENVELOPE_BYTES + 4096) return json({ error: "message too large" }, 413);
      return userStub(env, m[1]).fetch("https://do/http", { method: "POST", body }).then(withCors);
    }

    // GET /api/vapid  -> the public key browsers need to sign up for notifications
    if (url.pathname === "/api/vapid") {
      return userStub(env, VAPID).fetch("https://do/vapid-public").then(withCors);
    }

    // GET /api/ice  -> STUN servers, plus Cloudflare TURN if configured
    if (url.pathname === "/api/ice") return json({ iceServers: await iceServers(env) });

    if (url.pathname === "/" || url.pathname === "/api") return json({ ok: true, service: "FreeMessenger relay" });
    return json({ error: "not found" }, 404);
  },
};

function withCors(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

function isPublicJwk(k) {
  return k && typeof k === "object" && k.kty === "EC" && k.crv === "P-256" &&
    typeof k.x === "string" && typeof k.y === "string" && !("d" in k);
}

async function iceServers(env) {
  const stun = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return stun;
  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: 86400 }),
      },
    );
    if (!r.ok) return stun;
    const data = await r.json();
    const turn = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
    return [...stun, ...turn];
  } catch {
    return stun;
  }
}

// One instance per username. Holds that user's public keys, their live
// connections, and their offline inbox.
export class User {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // Keep-alive pings are answered at the edge without waking this object,
    // so idle connections cost nothing.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    // HTTP clients: when one last polled, call signaling waiting for it, and
    // open sign-in challenges. Kept in memory only; losing them is harmless.
    this.lastPoll = 0;
    this.ephemeral = [];
    this.challenges = new Map();
    this.lastPush = 0;
    this.sinceTrim = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/register") {
      const { username, sigPub, ecdhPub } = await request.json();
      const existing = await this.ctx.storage.get("profile");
      if (existing) return json({ error: "That username is taken" }, 409);
      await this.ctx.storage.put("profile", { username, sigPub, ecdhPub, created: Date.now() });
      return json({ ok: true, username });
    }

    if (url.pathname === "/profile") {
      const p = await this.ctx.storage.get("profile");
      if (!p) return json({ error: "No such user" }, 404);
      return json({ username: p.username, sigPub: p.sigPub, ecdhPub: p.ecdhPub });
    }

    if (url.pathname === "/deliver") return this.deliver(await request.json());
    if (url.pathname === "/vapid-public") return json({ key: (await vapidKeys(this.ctx)).publicKey });
    if (url.pathname === "/vapid-private") return json(await vapidKeys(this.ctx));

    if (url.pathname === "/http") {
      let msg;
      try { msg = JSON.parse(await request.text()); } catch { return json({ error: "bad json" }, 400); }
      return this.http(msg || {});
    }

    if (request.headers.get("Upgrade") === "websocket") {
      const profile = await this.ctx.storage.get("profile");
      if (!profile) return json({ error: "No such user" }, 404);
      const pair = new WebSocketPair();
      const challenge = crypto.randomUUID();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ challenge, authed: false });
      pair[1].send(JSON.stringify({ type: "challenge", challenge }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return json({ error: "not found" }, 404);
  }

  authedSockets() {
    return this.ctx.getWebSockets().filter((ws) => ws.deserializeAttachment()?.authed);
  }

  pollerOnline() {
    return Date.now() - this.lastPoll < POLL_ONLINE_MS;
  }

  // Called by another user's instance to hand us an envelope.
  async deliver(msg) {
    const hint = msg.hint;
    delete msg.hint;
    const live = this.authedSockets();
    const online = live.length > 0 || this.pollerOnline();
    if (msg.ephemeral) {
      // Call signaling: only useful if someone is online right now. A call to
      // someone offline becomes a "missed call" notification.
      for (const ws of live) ws.send(JSON.stringify({ type: "message", ...msg }));
      if (this.pollerOnline()) this.ephemeral = [...this.ephemeral.slice(-199), msg];
      if (!online && hint === "call") this.notify({ kind: "call", from: msg.from }, true);
      return json({ delivered: online });
    }
    const key = `q:${String(msg.ts).padStart(15, "0")}:${msg.id}`;
    await this.ctx.storage.put(key, msg);
    // Listing the whole inbox costs a read per message, so tidy it up only
    // every 50 deliveries (and on every sign-in).
    if (++this.sinceTrim >= 50) await this.trimQueue();
    for (const ws of live) ws.send(JSON.stringify({ type: "message", ...msg }));
    if (!online && hint === "msg") this.notify({ kind: "message", from: msg.from }, false);
    return json({ queued: true });
  }

  // ---------- notifications ----------

  async pushSubscribe(sub) {
    const endpoint = sub && String(sub.endpoint || "");
    const keys = sub && sub.keys;
    if (!/^https:\/\/[^\s]{10,1000}$/.test(endpoint) || !keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
      return { error: "bad subscription" };
    }
    const subs = await this.ctx.storage.list({ prefix: "p:" });
    const id = `p:${await sha256Hex(endpoint)}`;
    if (!subs.has(id) && subs.size >= MAX_PUSH_SUBS) {
      const oldest = [...subs.entries()].sort((a, b) => a[1].added - b[1].added)[0];
      await this.ctx.storage.delete(oldest[0]);
    }
    await this.ctx.storage.put(id, { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, added: Date.now() });
    return { ok: true };
  }

  async pushUnsubscribe(endpoint) {
    await this.ctx.storage.delete(`p:${await sha256Hex(String(endpoint || ""))}`);
    return { ok: true };
  }

  notify(data, urgent) {
    const now = Date.now();
    if (!urgent && now - this.lastPush < PUSH_GAP_MS) return;
    this.lastPush = now;
    const work = (async () => {
      const subs = await this.ctx.storage.list({ prefix: "p:" });
      if (!subs.size) return;
      const vapid = await (await userStub(this.env, VAPID).fetch("https://do/vapid-private")).json();
      const body = new TextEncoder().encode(JSON.stringify(data));
      await Promise.all([...subs.entries()].map(async ([k, sub]) => {
        try {
          const r = await sendPush(sub, body, vapid, urgent ? 60 : 86400);
          if (r.status === 404 || r.status === 410) await this.ctx.storage.delete(k);
        } catch {}
      }));
    })();
    if (this.ctx.waitUntil) this.ctx.waitUntil(work);
  }

  async trimQueue() {
    this.sinceTrim = 0;
    const all = await this.ctx.storage.list({ prefix: "q:" });
    const keys = [...all.keys()];
    const cutoff = Date.now() - QUEUE_TTL_MS;
    const drop = keys.filter((k, i) => i < keys.length - MAX_QUEUE || all.get(k).ts < cutoff);
    if (drop.length) await this.ctx.storage.delete(drop);
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const state = ws.deserializeAttachment() || {};

    if (!state.authed) {
      if (msg.type !== "auth") return;
      const profile = await this.ctx.storage.get("profile");
      const ok = await verify(profile.sigPub, msg.signature, state.challenge);
      if (!ok) {
        ws.send(JSON.stringify({ type: "error", error: "auth failed" }));
        return ws.close(4001, "auth failed");
      }
      ws.serializeAttachment({ authed: true });
      ws.send(JSON.stringify({ type: "ready", username: profile.username }));
      await this.trimQueue();
      const queued = await this.ctx.storage.list({ prefix: "q:" });
      for (const m of queued.values()) ws.send(JSON.stringify({ type: "message", ...m }));
      return;
    }

    if (msg.type === "send") {
      const r = await this.send(msg);
      return ws.send(JSON.stringify({ type: "sent", ref: msg.ref, ...r }));
    }
    if (msg.type === "push-sub" || msg.type === "push-unsub") {
      const r = msg.type === "push-sub" ? await this.pushSubscribe(msg.sub) : await this.pushUnsubscribe(msg.endpoint);
      return ws.send(JSON.stringify({ type: "sent", ref: msg.ref, ...r }));
    }

    if (msg.type === "ack") await this.ack(msg.items);
  }

  async send(msg) {
    const to = String(msg.to || "").toLowerCase();
    if (!USERNAME.test(to)) return { error: "bad recipient" };
    if (typeof msg.body !== "string" || msg.body.length > MAX_ENVELOPE_BYTES) return { error: "message too large" };
    const profile = await this.ctx.storage.get("profile");
    const envelope = {
      id: crypto.randomUUID(),
      from: profile.username,   // set by the relay, so senders can't pretend to be someone else
      ts: Date.now(),
      ephemeral: !!msg.ephemeral,
      body: msg.body,
    };
    const hint = msg.hint === "msg" || msg.hint === "call" ? msg.hint : undefined;
    const res = await userStub(this.env, to).fetch("https://do/deliver", {
      method: "POST",
      body: JSON.stringify({ ...envelope, hint }),
    });
    return { id: envelope.id, ts: envelope.ts, ...(await res.json()) };
  }

  async ack(items) {
    if (!Array.isArray(items)) return;
    const keys = items.slice(0, 500).map((i) => `q:${String(i.ts).padStart(15, "0")}:${i.id}`);
    if (keys.length) await this.ctx.storage.delete(keys);
  }

  // The same protocol as the WebSocket, one request at a time: get a challenge,
  // sign it for a session token, then poll, send and ack with that token.
  async http(msg) {
    const profile = await this.ctx.storage.get("profile");
    if (!profile) return json({ error: "No such user" }, 404);
    const now = Date.now();

    if (msg.op === "challenge") {
      for (const [c, ts] of this.challenges) if (now - ts > 120e3) this.challenges.delete(c);
      const challenge = crypto.randomUUID();
      this.challenges.set(challenge, now);
      return json({ challenge });
    }

    if (msg.op === "auth") {
      const issued = this.challenges.get(msg.challenge);
      this.challenges.delete(msg.challenge);
      if (!issued || now - issued > 120e3) return json({ error: "challenge expired" }, 401);
      if (!(await verify(profile.sigPub, msg.signature, msg.challenge))) return json({ error: "auth failed" }, 403);
      const token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
      await this.ctx.storage.put(`s:${token}`, now);
      const sessions = [...(await this.ctx.storage.list({ prefix: "s:" })).entries()].sort((a, b) => a[1] - b[1]);
      const stale = sessions.filter(([, ts], i) => i < sessions.length - MAX_SESSIONS || now - ts > SESSION_TTL_MS);
      if (stale.length) await this.ctx.storage.delete(stale.map(([k]) => k));
      await this.trimQueue();
      return json({ token, username: profile.username });
    }

    const created = typeof msg.token === "string" && msg.token.length === 48 && (await this.ctx.storage.get(`s:${msg.token}`));
    if (!created || now - created > SESSION_TTL_MS) return json({ error: "session expired" }, 401);

    if (msg.op === "poll") {
      this.lastPoll = now;
      // "after" is the newest message this client already has, so big files
      // aren't sent again on every poll while they're being put together.
      const a = msg.after;
      const startAfter = a && Number.isFinite(a.ts) && typeof a.id === "string"
        ? `q:${String(a.ts).padStart(15, "0")}:${a.id}` : undefined;
      const queued = [...(await this.ctx.storage.list({ prefix: "q:", startAfter, limit: 200 })).values()];
      const live = this.ephemeral.filter((m) => now - m.ts < 60e3);
      this.ephemeral = [];
      return json({ messages: [...queued, ...live] });
    }
    if (msg.op === "send") return json(await this.send(msg));
    if (msg.op === "ack") { await this.ack(msg.items); return json({ ok: true }); }
    if (msg.op === "push-sub") return json(await this.pushSubscribe(msg.sub));
    if (msg.op === "push-unsub") return json(await this.pushUnsubscribe(msg.endpoint));
    return json({ error: "unknown op" }, 400);
  }

  webSocketClose(ws, code) {
    try { ws.close(code, "closed"); } catch {}
  }

  webSocketError(ws) {
    try { ws.close(1011, "error"); } catch {}
  }
}

async function verify(jwk, signatureB64, challenge) {
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const sig = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, new TextEncoder().encode(challenge));
  } catch {
    return false;
  }
}

// ---------- Web Push (RFC 8291 encryption, RFC 8292 VAPID) ----------

const enc = new TextEncoder();
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

async function sha256Hex(text) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return [...h.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The relay's own push key, made the first time it's needed and kept in
// storage, so there's no secret to set up.
async function vapidKeys(ctx) {
  let k = await ctx.storage.get("vapid");
  if (!k) {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    k = {
      publicKey: b64u(await crypto.subtle.exportKey("raw", pair.publicKey)),
      privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
    };
    await ctx.storage.put("vapid", k);
  }
  return k;
}

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

async function sendPush(sub, payload, vapid, ttl) {
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
