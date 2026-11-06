// FreeMessenger backup relay — a Cloudflare Worker with one Durable Object per
// username.
//
// The main relay runs on the site owner's home PC (server/ in this repo). This
// Worker is always on, so the app falls back to it whenever the home PC is off
// or can't be reached, and the two copy accounts and messages to each other:
// the home PC calls /api/sync every 30 seconds, signed with a key only the
// home PC has (its public half is PRIMARY_KEY in wrangler.toml).
//
// Messages are encrypted in the browser for the person they're for, plus an
// "admin copy" encrypted for the site admin, who can read it in the admin
// panel on the home PC. The relay itself can read neither.

import {
  USERNAME, RESERVED, MAX_ENVELOPE_BYTES, CORS, json, isPublicJwk, verify, randomHex,
  RateLimit, allowSend, cleanProfile, cleanMeta, coturnServers, STUN, openSync,
  makeVapidKeys, validPushSub, sendPush, sha256Hex,
} from "./shared.js";

const QUEUE_TTL_MS = 30 * 24 * 3600e3;   // undelivered messages expire after 30 days here
const MAX_QUEUE = 5000;                  // per user, on this backup relay
const SESSION_TTL_MS = 30 * 24 * 3600e3;
const MAX_SESSIONS = 20;
const POLL_ONLINE_MS = 45e3;
const MAX_PUSH_SUBS = 10;
const PUSH_GAP_MS = 20e3;
const VAPID = "vapid-keys";              // Durable Object names that can't be usernames
const REGISTRY = "sync-registry";
const SYNC_CALLS = 40;                   // Durable Object calls one sync may make
const SYNC_BYTES = 6 * 1024 * 1024;      // data one sync may send back

function userStub(env, name) {
  return env.USERS.get(env.USERS.idFromName(name));
}
const registry = (env) => userStub(env, REGISTRY);
const post = (stub, path, body) => stub.fetch("https://do" + path, { method: "POST", body: JSON.stringify(body || {}) });
const ipOf = (request) => request.headers.get("CF-Connecting-IP") || "";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // POST /api/register  {username, sigPub, ecdhPub}
    if (url.pathname === "/api/register" && request.method === "POST") {
      let body;
      try { body = JSON.parse(await request.text()); } catch { return json({ error: "bad json" }, 400); }
      const name = String(body.username || "").toLowerCase();
      if (!USERNAME.test(name)) return json({ error: "Usernames are 3-20 characters: a-z, 0-9 and _" }, 400);
      if (RESERVED.has(name)) return json({ error: "That username is reserved" }, 409);
      if (!isPublicJwk(body.sigPub) || !isPublicJwk(body.ecdhPub)) return json({ error: "bad keys" }, 400);
      // Invite codes and approvals live on the home PC, so only open sign-ups work here.
      const cfg = await (await registry(env).fetch("https://do/config")).json();
      if (cfg.signupMode && cfg.signupMode !== "open") return json({ error: "Sign-ups are paused while the main server is off. Try again later." }, 403);
      if ((await (await registry(env).fetch("https://do/old-name?n=" + name)).json()).taken) return json({ error: "That username is taken" }, 409);
      return post(userStub(env, name), "/register", { username: name, sigPub: body.sigPub, ecdhPub: body.ecdhPub, ip: ipOf(request) }).then(withCors);
    }

    // GET /api/user/:name  -> public keys and profile
    let m = url.pathname.match(/^\/api\/user\/([a-z0-9_]{3,20})$/);
    if (m && request.method === "GET") return userStub(env, m[1]).fetch("https://do/profile").then(withCors);

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
      if (body.length > 2 * MAX_ENVELOPE_BYTES + 8192) return json({ error: "message too large" }, 413);
      return userStub(env, m[1]).fetch("https://do/http", { method: "POST", body, headers: { "X-IP": ipOf(request) } }).then(withCors);
    }

    if (url.pathname === "/api/signup") {
      const cfg = await (await registry(env).fetch("https://do/config")).json();
      return json({ mode: cfg.signupMode || "open" });
    }

    if (url.pathname === "/api/vapid") return userStub(env, VAPID).fetch("https://do/vapid-public").then(withCors);

    // Where the home PC relay is right now (its address changes when it restarts).
    if (url.pathname === "/api/primary") {
      const r = await registry(env).fetch("https://do/primary");
      return withCors(r);
    }

    // The admin's encryption key: every message carries a copy encrypted for it.
    if (url.pathname === "/api/admin-key") {
      const cfg = await (await registry(env).fetch("https://do/config")).json();
      const admin = (cfg.admins || [])[0];
      if (!admin) return json({});
      const p = await (await userStub(env, admin).fetch("https://do/profile")).json();
      return json(p.ecdhPub ? { ecdhPub: p.ecdhPub } : {});
    }

    if (url.pathname === "/api/ice") {
      const cfg = await (await registry(env).fetch("https://do/config")).json();
      const name = url.searchParams.get("u") || "guest";
      return json({ iceServers: [...STUN, ...(await coturnServers(cfg.turn, USERNAME.test(name) ? name : "guest")), ...(await cloudflareTurn(env))] });
    }

    if (url.pathname === "/api/sync" && request.method === "POST") return sync(request, env);

    if (url.pathname === "/" || url.pathname === "/api") return json({ ok: true, service: "FreeMessenger relay", primary: false });
    return json({ error: "not found" }, 404);
  },
};

function withCors(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

async function cloudflareTurn(env) {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return [];
  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: 86400 }),
      },
    );
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
  } catch {
    return [];
  }
}

// ---------- sync with the home PC ----------

async function sync(request, env) {
  if (!env.PRIMARY_KEY) return json({ error: "sync not set up" }, 501);
  const key = typeof env.PRIMARY_KEY === "string" ? JSON.parse(env.PRIMARY_KEY) : env.PRIMARY_KEY;
  const body = await openSync(key, await request.text());
  if (!body) return json({ error: "bad signature" }, 403);

  const reg = registry(env);
  await post(reg, "/set", { primary: body.primary, admins: body.admins, turn: body.turn, signupMode: body.signupMode, oldNames: body.oldNames });
  let calls = 1;

  // Everything for one user goes in one call to their Durable Object.
  const work = new Map();
  const add = (name, k, v) => {
    if (!USERNAME.test(name)) return;
    const w = work.get(name) || {};
    if (Array.isArray(w[k])) w[k].push(...v); else w[k] = v;
    work.set(name, w);
  };
  for (const a of body.accounts || []) add(a.username, "account", a);
  for (const name of body.removed || []) add(name, "remove", true);
  for (const d of body.deliver || []) add(d.to, "deliver", [d.env]);
  for (const [name, items] of Object.entries(body.acks || {})) add(name, "acks", items);
  for (const [name, keys] of Object.entries(body.archiveAcks || {})) add(name, "archiveAcks", keys);
  for (const [name, w] of work) {
    if (calls >= SYNC_CALLS - 5) break;
    await post(userStub(env, name), "/sync-in", w);
    calls++;
  }

  const out = { ok: true, users: [] };
  if (body.wantVapid) {
    out.vapid = await (await userStub(env, VAPID).fetch("https://do/vapid-private")).json();
    calls++;
  }

  // Accounts from before the home PC existed: send what's waiting for them.
  const pull = (body.pull || []).filter((n) => USERNAME.test(n)).slice(0, 200);
  if (pull.length) { await post(reg, "/mark", { names: pull }); calls++; }

  // Send back what happened here since the last sync.
  const dirty = await (await post(reg, "/take-dirty", { limit: Math.max(0, SYNC_CALLS - calls - 1) })).json();
  let bytes = 0;
  const left = [];
  for (const name of dirty.names) {
    if (bytes > SYNC_BYTES) { left.push(name); continue; }
    const r = await post(userStub(env, name), "/sync-out", { budget: SYNC_BYTES - bytes });
    const text = await r.text();
    bytes += text.length;
    const u = JSON.parse(text);
    if (u.more) left.push(name);
    out.users.push(u);
  }
  if (left.length) await post(reg, "/mark", { names: left });
  out.more = dirty.more || left.length > 0;
  return json(out);
}

// One instance per username: their keys, profile, live connections and inbox.
// Two special instances hold the push key (VAPID) and the sync registry.
export class User {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.lastPoll = 0;
    this.ephemeral = [];
    this.challenges = new Map();
    this.lastPush = 0;
    this.sinceTrim = 0;
    this.marked = false;
    this.limiter = new RateLimit();
  }

  // ---------- registry instance ----------

  async registryFetch(url, request) {
    const s = this.ctx.storage;
    if (url.pathname === "/primary") {
      const p = await s.get("primary");
      // A home PC that hasn't checked in for 2 minutes is treated as off.
      return json(p && Date.now() - p.ts < 120e3 ? { url: p.url } : {});
    }
    if (url.pathname === "/old-name") return json({ taken: !!(await s.get("o:" + url.searchParams.get("n"))) });
    if (url.pathname === "/config") return json({ admins: (await s.get("admins")) || [], turn: await s.get("turn"), signupMode: (await s.get("signupMode")) || "open" });
    const body = JSON.parse(await request.text() || "{}");
    if (url.pathname === "/set") {
      if (typeof body.primary === "string" && /^(https:\/\/[a-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1):\d+)$/i.test(body.primary)) await s.put("primary", { url: body.primary, ts: Date.now() });
      if (Array.isArray(body.admins)) await s.put("admins", body.admins.filter((n) => USERNAME.test(n)).slice(0, 10));
      if (["open", "approval", "invite", "closed"].includes(body.signupMode)) await s.put("signupMode", body.signupMode);
      if (Array.isArray(body.oldNames)) {
        const names = body.oldNames.filter((n) => USERNAME.test(n));
        for (let i = 0; i < names.length; i += 128) await s.put(Object.fromEntries(names.slice(i, i + 128).map((n) => ["o:" + n, 1])));
      }
      if (body.turn && typeof body.turn === "object") await s.put("turn", body.turn); else if (body.turn === null) await s.delete("turn");
      return json({ ok: true });
    }
    if (url.pathname === "/mark") {
      const names = (body.names || []).filter((n) => USERNAME.test(n));
      if (names.length) await s.put(Object.fromEntries(names.map((n) => ["d:" + n, Date.now()])));
      return json({ ok: true });
    }
    if (url.pathname === "/take-dirty") {
      const all = await s.list({ prefix: "d:", limit: body.limit + 1 });
      const keys = [...all.keys()].slice(0, body.limit);
      if (keys.length) await s.delete(keys);
      return json({ names: keys.map((k) => k.slice(2)), more: all.size > body.limit });
    }
    return json({ error: "not found" }, 404);
  }

  // Tell the registry this user has news for the home PC (once until it's collected).
  markDirty() {
    if (this.marked) return;
    this.marked = true;
    const p = this.ctx.storage.get("profile").then((prof) => prof && post(registry(this.env), "/mark", { names: [prof.username] }));
    if (this.ctx.waitUntil) this.ctx.waitUntil(p);
  }

  async fetch(request) {
    const url = new URL(request.url);
    // Only the registry instance is ever sent these.
    if (["/primary", "/config", "/set", "/mark", "/take-dirty", "/old-name"].includes(url.pathname)) return this.registryFetch(url, request);

    if (url.pathname === "/register") {
      const { username, sigPub, ecdhPub, ip } = JSON.parse(await request.text());
      if (await this.ctx.storage.get("profile")) return json({ error: "That username is taken" }, 409);
      await this.ctx.storage.put("profile", { username, sigPub, ecdhPub, created: Date.now(), ip, seen: Date.now(), origin: "cf" });
      this.markDirty();
      return json({ ok: true, username });
    }

    if (url.pathname === "/profile") {
      const p = await this.ctx.storage.get("profile");
      const mod = (await this.ctx.storage.get("mod")) || {};
      if (!p || mod.status === "banned") return json({ error: "No such user" }, 404);
      return json({ username: p.username, sigPub: p.sigPub, ecdhPub: p.ecdhPub, profile: p.info || {} });
    }

    if (url.pathname === "/deliver") return this.deliver(JSON.parse(await request.text()));
    if (url.pathname === "/vapid-public") return json({ key: (await this.vapidKeys()).publicKey });
    if (url.pathname === "/vapid-private") return json(await this.vapidKeys());
    if (url.pathname === "/sync-in") return this.syncIn(JSON.parse(await request.text()));
    if (url.pathname === "/sync-out") return this.syncOut(JSON.parse(await request.text()));

    if (url.pathname === "/http") {
      let msg;
      try { msg = JSON.parse(await request.text()); } catch { return json({ error: "bad json" }, 400); }
      return this.http(msg || {}, request.headers.get("X-IP") || "");
    }

    if (request.headers.get("Upgrade") === "websocket") {
      const profile = await this.ctx.storage.get("profile");
      if (!profile) return json({ error: "No such user" }, 404);
      const pair = new WebSocketPair();
      const challenge = crypto.randomUUID();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ challenge, authed: false, ip: request.headers.get("CF-Connecting-IP") || "" });
      pair[1].send(JSON.stringify({ type: "challenge", challenge }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return json({ error: "not found" }, 404);
  }

  async vapidKeys() {
    let k = await this.ctx.storage.get("vapid");
    if (!k) {
      k = await makeVapidKeys();
      await this.ctx.storage.put("vapid", k);
    }
    return k;
  }

  authedSockets() {
    return this.ctx.getWebSockets().filter((ws) => ws.deserializeAttachment()?.authed);
  }

  pollerOnline() {
    return Date.now() - this.lastPoll < POLL_ONLINE_MS;
  }

  async mod() {
    return (await this.ctx.storage.get("mod")) || {};
  }

  async seen(ip) {
    const p = await this.ctx.storage.get("profile");
    if (!p) return;
    p.seen = Date.now();
    if (ip) p.ip = ip;
    await this.ctx.storage.put("profile", p);
    this.markDirty();
  }

  // Called by another user's instance (or the sync) to hand us an envelope.
  async deliver(msg, fromPc) {
    const hint = msg.hint;
    delete msg.hint;
    const live = this.authedSockets();
    const online = live.length > 0 || this.pollerOnline();
    if (msg.ephemeral) {
      for (const ws of live) ws.send(JSON.stringify({ type: "message", ...msg }));
      if (this.pollerOnline()) this.ephemeral = [...this.ephemeral.slice(-199), msg];
      if (!online && hint === "call") this.notify({ kind: "call", from: msg.from }, true);
      return json({ delivered: online });
    }
    const key = `q:${String(msg.ts).padStart(15, "0")}:${msg.id}`;
    if (fromPc) {
      if (await this.ctx.storage.get(key)) return json({ queued: true });
      await this.ctx.storage.put({ [key]: msg, ["x:" + key.slice(2)]: 1 });
    } else {
      await this.ctx.storage.put(key, msg);
      this.markDirty();
    }
    if (++this.sinceTrim >= 50) await this.trimQueue();
    for (const ws of live) ws.send(JSON.stringify({ type: "message", ...msg }));
    if (!online && hint === "msg") this.notify({ kind: "message", from: msg.from }, false);
    return json({ queued: true });
  }

  // ---------- sync ----------

  async syncIn(w) {
    const s = this.ctx.storage;
    if (w.remove) {
      for (const ws of this.ctx.getWebSockets()) try { ws.close(4003, "removed"); } catch {}
      await s.deleteAll();
      return json({ ok: true });
    }
    if (w.account) {
      const a = w.account;
      let p = await s.get("profile");
      if (!p || p.sigPub.x !== a.sigPub.x || p.sigPub.y !== a.sigPub.y) {
        // The home PC is in charge: its account wins over one made here.
        p = { username: a.username, sigPub: a.sigPub, ecdhPub: a.ecdhPub, created: a.created, origin: "pc" };
      }
      if (a.profile && (!p.infoTs || a.profileTs > p.infoTs)) { p.info = cleanProfile(a.profile); p.infoTs = a.profileTs || Date.now(); }
      await s.put("profile", p);
      const mod = { status: a.status || "ok", timeoutUntil: a.timeoutUntil || 0, proxy: !!a.proxy };
      await s.put("mod", mod);
      if (mod.status === "banned") {
        for (const ws of this.ctx.getWebSockets()) try { ws.close(4003, "banned"); } catch {}
        await s.delete([...(await s.list({ prefix: "s:" })).keys()]);
      }
      for (const sub of a.push || []) await this.pushSubscribe(sub, true);
    }
    for (const env of w.deliver || []) await this.deliver(env, true);
    const ackKeys = (w.acks || []).slice(0, 2000).flatMap((i) => {
      const k = `${String(i.ts).padStart(15, "0")}:${i.id}`;
      return ["q:" + k, "x:" + k];
    });
    for (let i = 0; i < ackKeys.length; i += 128) await s.delete(ackKeys.slice(i, i + 128));
    const archiveKeys = (w.archiveAcks || []).filter((k) => typeof k === "string" && k.startsWith("a:"));
    for (let i = 0; i < archiveKeys.length; i += 128) await s.delete(archiveKeys.slice(i, i + 128));
    return json({ ok: true });
  }

  async syncOut({ budget }) {
    const s = this.ctx.storage;
    this.marked = false;
    const p = await s.get("profile");
    if (!p) return json({ username: null });
    const out = {
      username: p.username,
      account: { sigPub: p.sigPub, ecdhPub: p.ecdhPub, created: p.created, origin: p.origin, ip: p.ip, seen: p.seen, profile: p.info, profileTs: p.infoTs || 0 },
      push: [...(await s.list({ prefix: "p:" })).values()].map((x) => ({ endpoint: x.endpoint, keys: x.keys })),
      online: this.authedSockets().length > 0 || this.pollerOnline(),
      queue: [],
      archive: [],
      acked: (await s.get("acked")) || [],
    };
    if (out.acked.length) await s.delete("acked");
    let size = 2000;
    // Messages waiting here that the home PC hasn't been given yet.
    const exported = await s.list({ prefix: "x:" });
    for (const [k, env] of await s.list({ prefix: "q:" })) {
      if (exported.has("x:" + k.slice(2))) continue;
      const n = JSON.stringify(env).length;
      if (size + n > budget) { out.more = true; break; }
      size += n;
      out.queue.push(env);
      await s.put("x:" + k.slice(2), 1);
    }
    // Admin copies of messages sent from here.
    for (const [k, item] of await s.list({ prefix: "a:", limit: 500 })) {
      const n = JSON.stringify(item).length;
      if (size + n > budget) { out.more = true; break; }
      size += n;
      out.archive.push({ key: k, ...item });
    }
    return json(out);
  }

  // ---------- notifications ----------

  async pushSubscribe(raw, quiet) {
    const sub = validPushSub(raw);
    if (!sub) return { error: "bad subscription" };
    const subs = await this.ctx.storage.list({ prefix: "p:" });
    const id = `p:${await sha256Hex(sub.endpoint)}`;
    if (!subs.has(id) && subs.size >= MAX_PUSH_SUBS) {
      const oldest = [...subs.entries()].sort((a, b) => a[1].added - b[1].added)[0];
      await this.ctx.storage.delete(oldest[0]);
    }
    await this.ctx.storage.put(id, { ...sub, added: Date.now() });
    if (!quiet) this.markDirty();
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
    const dropAll = drop.flatMap((k) => [k, "x:" + k.slice(2)]);
    for (let i = 0; i < dropAll.length; i += 128) await this.ctx.storage.delete(dropAll.slice(i, i + 128));
  }

  async authFlags() {
    const mod = await this.mod();
    const cfg = await (await registry(this.env).fetch("https://do/config")).json();
    const profile = await this.ctx.storage.get("profile");
    const admin = (cfg.admins || []).includes(profile.username);
    return { admin, proxy: admin || !!mod.proxy, primary: false };
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const state = ws.deserializeAttachment() || {};

    if (!state.authed) {
      if (msg.type !== "auth") return;
      const profile = await this.ctx.storage.get("profile");
      if ((await this.mod()).status === "banned") {
        ws.send(JSON.stringify({ type: "error", error: "This account has been banned." }));
        return ws.close(4003, "banned");
      }
      const ok = await verify(profile.sigPub, msg.signature, state.challenge);
      if (!ok) {
        ws.send(JSON.stringify({ type: "error", error: "auth failed" }));
        return ws.close(4001, "auth failed");
      }
      ws.serializeAttachment({ authed: true });
      await this.seen(state.ip);
      ws.send(JSON.stringify({ type: "ready", username: profile.username, ...(await this.authFlags()) }));
      await this.trimQueue();
      const queued = await this.ctx.storage.list({ prefix: "q:" });
      for (const m of queued.values()) ws.send(JSON.stringify({ type: "message", ...m }));
      return;
    }

    if (msg.type === "ack") return this.ack(msg.items);
    const r = await this.op(msg.type, msg);
    if (r) ws.send(JSON.stringify({ type: "sent", ref: msg.ref, ...r }));
  }

  async op(type, msg) {
    if (type === "send") return this.send(msg);
    if (type === "push-sub") return this.pushSubscribe(msg.sub);
    if (type === "push-unsub") return this.pushUnsubscribe(msg.endpoint);
    if (type === "profile") {
      const p = await this.ctx.storage.get("profile");
      p.info = cleanProfile(msg.profile);
      p.infoTs = Date.now();
      await this.ctx.storage.put("profile", p);
      this.markDirty();
      return { ok: true };
    }
    if (type === "history") return { messages: [], done: true };
    if (type === "admin" || type === "proxy-ticket") return { error: "That works only while the home server is on." };
    return null;
  }

  async send(msg) {
    const to = String(msg.to || "").toLowerCase();
    if (!USERNAME.test(to)) return { error: "bad recipient" };
    if (typeof msg.body !== "string" || msg.body.length > MAX_ENVELOPE_BYTES) return { error: "message too large" };
    if (msg.escrow !== undefined && (typeof msg.escrow !== "string" || msg.escrow.length > MAX_ENVELOPE_BYTES)) return { error: "message too large" };
    const profile = await this.ctx.storage.get("profile");
    const mod = await this.mod();
    if (mod.status === "frozen") return { error: "Your account is frozen by the admin.", blocked: true };
    if (mod.status === "pending") return { error: "Your account is waiting for the admin's approval.", blocked: true };
    if (mod.timeoutUntil > Date.now()) return { error: `You're timed out until ${new Date(mod.timeoutUntil).toUTCString()}.`, blocked: true, until: mod.timeoutUntil };
    const hint = msg.hint === "msg" || msg.hint === "call" ? msg.hint : undefined;
    if (!allowSend(this.limiter, profile.username, hint, cleanMeta(msg.meta))) return { error: "Slow down: one message a second.", slow: true };
    const envelope = {
      id: crypto.randomUUID(),
      from: profile.username,   // set by the relay, so senders can't pretend to be someone else
      ts: Date.now(),
      ephemeral: !!msg.ephemeral,
      body: msg.body,
    };
    if (!envelope.ephemeral) {
      // The admin copy, picked up by the home PC on its next sync.
      await this.ctx.storage.put(`a:${String(envelope.ts).padStart(15, "0")}:${envelope.id}`, {
        env: envelope, to, escrow: typeof msg.escrow === "string" ? msg.escrow : null, meta: cleanMeta(msg.meta) || null,
      });
      this.markDirty();
    }
    const res = await post(userStub(this.env, to), "/deliver", { ...envelope, hint });
    return { id: envelope.id, ts: envelope.ts, ...(await res.json()) };
  }

  async ack(items) {
    if (!Array.isArray(items)) return;
    const list = items.slice(0, 500);
    const keys = list.map((i) => `${String(i.ts).padStart(15, "0")}:${i.id}`);
    // Messages the home PC also has: tell it they were read here.
    const had = new Set();
    for (let i = 0; i < keys.length; i += 128) {
      for (const k of (await this.ctx.storage.get(keys.slice(i, i + 128).map((k) => "x:" + k))).keys()) had.add(k);
    }
    const fromPc = list.filter((_, i) => had.has("x:" + keys[i]));
    if (fromPc.length) {
      const acked = (await this.ctx.storage.get("acked")) || [];
      await this.ctx.storage.put("acked", [...acked, ...fromPc.map((i) => ({ id: i.id, ts: i.ts }))].slice(-5000));
      this.markDirty();
    }
    const all = keys.flatMap((k) => ["q:" + k, "x:" + k]);
    for (let i = 0; i < all.length; i += 128) await this.ctx.storage.delete(all.slice(i, i + 128));
  }

  // The same protocol as the WebSocket, one request at a time.
  async http(msg, ip) {
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
      if ((await this.mod()).status === "banned") return json({ error: "This account has been banned." }, 403);
      if (!issued || now - issued > 120e3) return json({ error: "challenge expired" }, 401);
      if (!(await verify(profile.sigPub, msg.signature, msg.challenge))) return json({ error: "auth failed" }, 403);
      const token = randomHex(24);
      await this.ctx.storage.put(`s:${token}`, now);
      const sessions = [...(await this.ctx.storage.list({ prefix: "s:" })).entries()].sort((a, b) => a[1] - b[1]);
      const stale = sessions.filter(([, ts], i) => i < sessions.length - MAX_SESSIONS || now - ts > SESSION_TTL_MS);
      if (stale.length) await this.ctx.storage.delete(stale.map(([k]) => k));
      await this.trimQueue();
      await this.seen(ip);
      return json({ token, username: profile.username, ...(await this.authFlags()) });
    }

    const created = typeof msg.token === "string" && msg.token.length === 48 && (await this.ctx.storage.get(`s:${msg.token}`));
    if (!created || now - created > SESSION_TTL_MS) return json({ error: "session expired" }, 401);

    if (msg.op === "poll") {
      this.lastPoll = now;
      const a = msg.after;
      const startAfter = a && Number.isFinite(a.ts) && typeof a.id === "string"
        ? `q:${String(a.ts).padStart(15, "0")}:${a.id}` : undefined;
      const queued = [...(await this.ctx.storage.list({ prefix: "q:", startAfter, limit: 200 })).values()];
      const live = this.ephemeral.filter((m) => now - m.ts < 60e3);
      this.ephemeral = [];
      return json({ messages: [...queued, ...live] });
    }
    if (msg.op === "ack") { await this.ack(msg.items); return json({ ok: true }); }
    const r = await this.op(msg.op, msg);
    return r ? json(r) : json({ error: "unknown op" }, 400);
  }

  webSocketClose(ws, code) {
    try { ws.close(code, "closed"); } catch {}
  }

  webSocketError(ws) {
    try { ws.close(1011, "error"); } catch {}
  }
}
