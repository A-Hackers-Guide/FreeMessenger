// FreeMessenger relay — a Cloudflare Worker with one Durable Object per username.
//
// The relay never sees message contents: clients encrypt end-to-end before sending.
// It only (1) remembers each username's public keys, (2) proves who is connected
// by checking a signed challenge, and (3) passes encrypted envelopes along,
// holding them for offline users until they are acknowledged.

const USERNAME = /^[a-z0-9_]{3,20}$/;
const RESERVED = new Set([
  "admin", "administrator", "root", "system", "support", "help", "official",
  "freemessenger", "moderator", "mod", "staff", "security", "null", "undefined",
]);
const MAX_ENVELOPE_BYTES = 64 * 1024;   // per message
const MAX_QUEUE = 500;                  // offline messages kept per user
const QUEUE_TTL_MS = 30 * 24 * 3600e3;  // offline messages expire after 30 days

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

  // Called by another user's instance to hand us an envelope.
  async deliver(msg) {
    if (msg.ephemeral) {
      // Call signaling: only useful if someone is online right now.
      const live = this.authedSockets();
      for (const ws of live) ws.send(JSON.stringify({ type: "message", ...msg }));
      return json({ delivered: live.length > 0 });
    }
    const key = `q:${String(msg.ts).padStart(15, "0")}:${msg.id}`;
    await this.ctx.storage.put(key, msg);
    await this.trimQueue();
    for (const ws of this.authedSockets()) ws.send(JSON.stringify({ type: "message", ...msg }));
    return json({ queued: true });
  }

  async trimQueue() {
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
      const to = String(msg.to || "").toLowerCase();
      const reply = (r) => ws.send(JSON.stringify({ type: "sent", ref: msg.ref, ...r }));
      if (!USERNAME.test(to)) return reply({ error: "bad recipient" });
      if (typeof msg.body !== "string" || msg.body.length > MAX_ENVELOPE_BYTES) return reply({ error: "message too large" });
      const profile = await this.ctx.storage.get("profile");
      const envelope = {
        id: crypto.randomUUID(),
        from: profile.username,   // set by the relay, so senders can't pretend to be someone else
        ts: Date.now(),
        ephemeral: !!msg.ephemeral,
        body: msg.body,
      };
      const res = await userStub(this.env, to).fetch("https://do/deliver", {
        method: "POST",
        body: JSON.stringify(envelope),
      });
      return reply({ id: envelope.id, ts: envelope.ts, ...(await res.json()) });
    }

    if (msg.type === "ack" && Array.isArray(msg.items)) {
      const keys = msg.items.slice(0, 500).map((i) => `q:${String(i.ts).padStart(15, "0")}:${i.id}`);
      if (keys.length) await this.ctx.storage.delete(keys);
    }
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
