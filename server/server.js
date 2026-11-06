// FreeMessenger main relay, for running on your own computer.
//
//   node server.js <data folder>
//
// Speaks the same protocol as the Cloudflare relay (relay/src/index.js), keeps
// every message in a SQLite file in the data folder, and is reached from the
// internet through a free Cloudflare quick tunnel, so it only ever listens on
// this computer (127.0.0.1) and no router ports are needed for it.
//
// Every 30 seconds it syncs with the Cloudflare relay, which takes over while
// this computer is off. See server/README.md.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer } from "ws";
import * as S from "../relay/src/shared.js";
import { proxyPage, proxyResource, proxyAllowed } from "./proxy.js";

const DATA = path.resolve(process.argv[2] || "data");
const CONFIG_FILE = path.join(DATA, "config.json");
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
const PORT = config.port || 8790;
const ADMINS = (config.admins || []).filter((n) => S.USERNAME.test(n));
const CAP_BYTES = (config.capGB || 100) * 1024 ** 3;
const BACKUP = config.backup || "";
const SESSION_TTL_MS = 30 * 24 * 3600e3;
const POLL_ONLINE_MS = 45e3;
const MAX_PUSH_SUBS = 10;
const PUSH_GAP_MS = 20e3;
const SYNC_EVERY_MS = 30e3;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- storage ----------

const db = new DatabaseSync(path.join(DATA, "freemessenger.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS accounts (
    username TEXT PRIMARY KEY, sigPub TEXT NOT NULL, ecdhPub TEXT NOT NULL, created INTEGER NOT NULL,
    signupIp TEXT, lastIp TEXT, lastSeen INTEGER, origin TEXT DEFAULT 'pc',
    status TEXT DEFAULT 'ok', timeoutUntil INTEGER DEFAULT 0, proxy INTEGER DEFAULT 0,
    profile TEXT DEFAULT '{}', profileTs INTEGER DEFAULT 0, cfDirty INTEGER DEFAULT 1, note TEXT
  );
  CREATE TABLE IF NOT EXISTS queue (
    id TEXT NOT NULL, recipient TEXT NOT NULL, ts INTEGER NOT NULL, env TEXT NOT NULL, via TEXT,
    PRIMARY KEY (recipient, id)
  );
  CREATE INDEX IF NOT EXISTS queue_order ON queue (recipient, ts, id);
  CREATE TABLE IF NOT EXISTS archive (
    id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL, ts INTEGER NOT NULL,
    body TEXT NOT NULL, escrow TEXT, kind TEXT, fid TEXT, size INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS archive_sender ON archive (sender, ts);
  CREATE INDEX IF NOT EXISTS archive_recipient ON archive (recipient, ts);
  CREATE INDEX IF NOT EXISTS archive_fid ON archive (fid);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS push_subs (id TEXT PRIMARY KEY, username TEXT NOT NULL, sub TEXT NOT NULL, added INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS banned_ips (ip TEXT PRIMARY KEY, ts INTEGER NOT NULL, reason TEXT);
  CREATE TABLE IF NOT EXISTS proxy_log (n INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, url TEXT, ts INTEGER);
  CREATE TABLE IF NOT EXISTS events (n INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, text TEXT);
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
`);
const q = (sql) => db.prepare(sql);
const kvGet = (k, d) => { const r = q("SELECT v FROM kv WHERE k = ?").get(k); return r ? JSON.parse(r.v) : d; };
const kvSet = (k, v) => q("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, JSON.stringify(v));
// Accounts with changes the backup relay hasn't been told about.
const markCf = (name) => q("UPDATE accounts SET cfDirty = ? WHERE username = ?").run(Date.now(), name);
const event = (text) => { q("INSERT INTO events (ts, text) VALUES (?, ?)").run(Date.now(), text); log(text); };

const getAccount = (name) => q("SELECT * FROM accounts WHERE username = ?").get(name);
const pub = (a) => ({ username: a.username, sigPub: JSON.parse(a.sigPub), ecdhPub: JSON.parse(a.ecdhPub), profile: JSON.parse(a.profile || "{}") });

function usedBytes() {
  const pages = q("PRAGMA page_count").get().page_count - q("PRAGMA freelist_count").get().freelist_count;
  return pages * q("PRAGMA page_size").get().page_size;
}
let used = usedBytes();
// When storage gets near the cap, the oldest file pieces go first.
function enforceCap() {
  used = usedBytes();
  if (used < CAP_BYTES * 0.95) return;
  event(`Storage is ${(used / 1024 ** 3).toFixed(1)} GB of ${(CAP_BYTES / 1024 ** 3).toFixed(0)} GB: removing the oldest file pieces.`);
  while (used > CAP_BYTES * 0.9) {
    const r = q("DELETE FROM archive WHERE id IN (SELECT id FROM archive WHERE kind = 'chunk' ORDER BY ts LIMIT 2000)").run();
    used = usedBytes();
    if (!r.changes) break;
  }
}
setInterval(enforceCap, 60e3);

// ---------- people online ----------

const sockets = new Map();   // username -> Set of signed-in WebSockets
const lastPoll = new Map();  // username -> time an HTTP client last polled
const ephemeral = new Map(); // username -> call signaling waiting for an HTTP client
const cfOnline = new Map();  // username -> time the Cloudflare relay said they were connected there
const challenges = new Map();
const lastPush = new Map();
const limiter = new S.RateLimit();
const pollerOnline = (name) => Date.now() - (lastPoll.get(name) || 0) < POLL_ONLINE_MS;
const live = (name) => [...(sockets.get(name) || [])];
const isOnline = (name) => live(name).length > 0 || pollerOnline(name);
const flags = (a) => ({ admin: ADMINS.includes(a.username), proxy: ADMINS.includes(a.username) || !!a.proxy, primary: true });

function kick(name, code, reason) {
  for (const ws of live(name)) try { ws.close(code, reason); } catch {}
  q("DELETE FROM sessions WHERE username = ?").run(name);
}

// ---------- messages ----------

function enqueue(to, env, via) {
  const r = q("INSERT OR IGNORE INTO queue (id, recipient, ts, env, via) VALUES (?, ?, ?, ?, ?)").run(env.id, to, env.ts, JSON.stringify(env), via || null);
  return r.changes > 0;
}

function archive(from, to, env, escrow, meta) {
  const kind = meta && meta.k === "chunk" ? "chunk" : meta && meta.k === "control" ? "control" : "msg";
  q("INSERT OR IGNORE INTO archive (id, sender, recipient, ts, body, escrow, kind, fid, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(env.id, from, to, env.ts, env.body, escrow || null, kind, (meta && meta.fid) || null, env.body.length + (escrow || "").length);
}

function deliver(to, env, hint) {
  const conns = live(to);
  if (env.ephemeral) {
    for (const ws of conns) ws.send(JSON.stringify({ type: "message", ...env }));
    if (pollerOnline(to)) ephemeral.set(to, [...(ephemeral.get(to) || []).slice(-199), env]);
    if (!isOnline(to) && hint === "call") notify(to, { kind: "call", from: env.from }, true);
    return { delivered: isOnline(to) };
  }
  enqueue(to, env);
  for (const ws of conns) ws.send(JSON.stringify({ type: "message", ...env }));
  if (!isOnline(to)) {
    // Connected to the backup relay instead: pass it along on the next sync.
    if (Date.now() - (cfOnline.get(to) || 0) < 120e3) { pendingCf.push({ to, env }); syncSoon(); }
    if (hint === "msg") notify(to, { kind: "message", from: env.from }, false);
  }
  return { queued: true };
}

function send(a, msg) {
  const to = String(msg.to || "").toLowerCase();
  if (!S.USERNAME.test(to)) return { error: "bad recipient" };
  const target = getAccount(to);
  if (!target || target.status === "banned") return { error: "No such user" };
  if (typeof msg.body !== "string" || msg.body.length > S.MAX_ENVELOPE_BYTES) return { error: "message too large" };
  if (msg.escrow !== undefined && (typeof msg.escrow !== "string" || msg.escrow.length > S.MAX_ENVELOPE_BYTES)) return { error: "message too large" };
  const fresh = getAccount(a.username);
  if (fresh.status === "frozen") return { error: "Your account is frozen by the admin.", blocked: true };
  if (fresh.timeoutUntil > Date.now()) return { error: `You're timed out until ${new Date(fresh.timeoutUntil).toUTCString()}.`, blocked: true, until: fresh.timeoutUntil };
  const hint = msg.hint === "msg" || msg.hint === "call" ? msg.hint : undefined;
  if (!S.allowSend(limiter, a.username, hint, S.cleanMeta(msg.meta))) return { error: "Slow down: one message a second.", slow: true };
  if (!msg.ephemeral && used > CAP_BYTES) return { error: "The server's storage is full. Tell the admin." };
  const env = { id: crypto.randomUUID(), from: a.username, ts: Date.now(), ephemeral: !!msg.ephemeral, body: msg.body };
  if (!env.ephemeral) archive(a.username, to, env, msg.escrow, S.cleanMeta(msg.meta));
  return { id: env.id, ts: env.ts, ...deliver(to, env, hint) };
}

const pendingCfAcks = new Map(); // username -> [{id, ts}] of messages that came from the backup relay
function ack(name, items) {
  if (!Array.isArray(items)) return;
  for (const i of items.slice(0, 500)) {
    if (!i || typeof i.id !== "string") continue;
    const row = q("SELECT via FROM queue WHERE recipient = ? AND id = ?").get(name, i.id);
    if (!row) continue;
    q("DELETE FROM queue WHERE recipient = ? AND id = ?").run(name, i.id);
    if (row.via === "cf") pendingCfAcks.set(name, [...(pendingCfAcks.get(name) || []), { id: i.id, ts: i.ts }]);
  }
}

// ---------- notifications ----------

function pushSubscribe(name, raw) {
  const sub = S.validPushSub(raw);
  if (!sub) return { error: "bad subscription" };
  return S.sha256Hex(sub.endpoint).then((h) => {
    const id = name + ":" + h;
    const subs = q("SELECT id FROM push_subs WHERE username = ? ORDER BY added").all(name);
    if (!subs.some((s) => s.id === id) && subs.length >= MAX_PUSH_SUBS) q("DELETE FROM push_subs WHERE id = ?").run(subs[0].id);
    q("INSERT OR REPLACE INTO push_subs (id, username, sub, added) VALUES (?, ?, ?, ?)").run(id, name, JSON.stringify(sub), Date.now());
    markCf(name);
    return { ok: true };
  });
}

async function pushUnsubscribe(name, endpoint) {
  q("DELETE FROM push_subs WHERE id = ?").run(name + ":" + (await S.sha256Hex(String(endpoint || ""))));
  return { ok: true };
}

function notify(name, data, urgent) {
  const now = Date.now();
  if (!urgent && now - (lastPush.get(name) || 0) < PUSH_GAP_MS) return;
  lastPush.set(name, now);
  const vapid = kvGet("vapid", null);
  if (!vapid) return;
  const body = new TextEncoder().encode(JSON.stringify(data));
  for (const row of q("SELECT id, sub FROM push_subs WHERE username = ?").all(name)) {
    S.sendPush(JSON.parse(row.sub), body, vapid, urgent ? 60 : 86400)
      .then((r) => { if (r.status === 404 || r.status === 410) q("DELETE FROM push_subs WHERE id = ?").run(row.id); })
      .catch(() => {});
  }
}

// ---------- requests a signed-in person can make ----------

const proxyTickets = new Map(); // ticket -> { username, until }

async function op(a, type, msg) {
  if (type === "send") return send(a, msg);
  if (type === "push-sub") return pushSubscribe(a.username, msg.sub);
  if (type === "push-unsub") return pushUnsubscribe(a.username, msg.endpoint);
  if (type === "profile") {
    q("UPDATE accounts SET profile = ?, profileTs = ? WHERE username = ?").run(JSON.stringify(S.cleanProfile(msg.profile)), Date.now(), a.username);
    markCf(a.username);
    return { ok: true };
  }
  if (type === "history") return history(a.username, msg);
  if (type === "proxy-ticket") {
    if (!proxyAllowed(flags(getAccount(a.username)))) return { error: "The admin hasn't given you the web viewer." };
    for (const [t, v] of proxyTickets) if (v.until < Date.now()) proxyTickets.delete(t);
    const ticket = S.randomHex(20);
    proxyTickets.set(ticket, { username: a.username, until: Date.now() + 2 * 3600e3 });
    return { ticket };
  }
  if (type === "admin") {
    if (!ADMINS.includes(a.username)) return { error: "Only the admin can do that." };
    try { return await admin(a.username, msg); } catch (e) { return { error: e.message }; }
  }
  return null;
}

// Your own messages, both ways, for a new browser. Newest first, in pages.
function history(name, msg) {
  const before = Number(msg.before) || Date.now() + 1;
  const rows = q(`SELECT id, sender, recipient, ts, body FROM archive
    WHERE (sender = ? OR recipient = ?) AND ts < ? AND kind != 'chunk' ORDER BY ts DESC LIMIT 300`).all(name, name, before);
  return { messages: rows.map((r) => ({ id: r.id, from: r.sender, to: r.recipient, ts: r.ts, body: r.body })), done: rows.length < 300 };
}

// ---------- admin panel ----------

function accountRow(r) {
  const counts = q("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM archive WHERE sender = ?").get(r.username);
  return {
    username: r.username, created: r.created, signupIp: r.signupIp, lastIp: r.lastIp, lastSeen: r.lastSeen,
    status: r.status, timeoutUntil: r.timeoutUntil, proxy: !!r.proxy, admin: ADMINS.includes(r.username),
    profile: JSON.parse(r.profile || "{}"), sent: counts.n, bytes: counts.bytes, online: isOnline(r.username),
    origin: r.origin, note: r.note || "",
  };
}

async function admin(me, msg) {
  const target = typeof msg.user === "string" ? msg.user.toLowerCase() : "";
  const acct = target && getAccount(target);
  if (target && !acct) throw new Error("No such account.");
  if (acct && ADMINS.includes(target) && ["freeze", "timeout", "remove", "ban"].includes(msg.action)) throw new Error("Admins can't be moderated here.");
  const dirty = () => markCf(target);

  switch (msg.action) {
    case "overview": {
      const day = Date.now() - 86400e3;
      return {
        accounts: q("SELECT * FROM accounts ORDER BY created DESC").all().map(accountRow),
        stats: {
          accounts: q("SELECT COUNT(*) AS n FROM accounts").get().n,
          online: [...new Set([...sockets.keys()].filter((n) => live(n).length).concat([...lastPoll.keys()].filter(pollerOnline)))].length,
          messages: q("SELECT COUNT(*) AS n FROM archive WHERE kind = 'msg'").get().n,
          messagesToday: q("SELECT COUNT(*) AS n FROM archive WHERE kind = 'msg' AND ts > ?").get(day).n,
          waiting: q("SELECT COUNT(*) AS n FROM queue").get().n,
          used, cap: CAP_BYTES,
          backup: lastSync, tunnel: tunnelUrl,
        },
        bannedIps: q("SELECT * FROM banned_ips ORDER BY ts DESC").all(),
        events: q("SELECT ts, text FROM events ORDER BY n DESC LIMIT 100").all(),
      };
    }
    case "freeze":
      q("UPDATE accounts SET status = ? WHERE username = ?").run(msg.on ? "frozen" : "ok", target);
      dirty();
      event(`@${me} ${msg.on ? "froze" : "unfroze"} @${target}`);
      return { ok: true };
    case "timeout": {
      const minutes = Math.max(0, Math.min(525600, Number(msg.minutes) || 0));
      q("UPDATE accounts SET timeoutUntil = ? WHERE username = ?").run(minutes ? Date.now() + minutes * 60e3 : 0, target);
      dirty();
      event(minutes ? `@${me} timed out @${target} for ${minutes} min` : `@${me} ended @${target}'s timeout`);
      return { ok: true };
    }
    case "proxy":
      q("UPDATE accounts SET proxy = ? WHERE username = ?").run(msg.on ? 1 : 0, target);
      dirty();
      event(`@${me} ${msg.on ? "gave" : "took away"} web viewer access ${msg.on ? "to" : "from"} @${target}`);
      return { ok: true };
    case "note":
      q("UPDATE accounts SET note = ? WHERE username = ?").run(String(msg.note || "").slice(0, 500), target);
      return { ok: true };
    case "ban": {
      q("UPDATE accounts SET status = 'banned' WHERE username = ?").run(target);
      q("DELETE FROM queue WHERE recipient = ?").run(target);
      if (msg.ip) {
        for (const ip of [acct.lastIp, acct.signupIp]) if (ip) q("INSERT OR IGNORE INTO banned_ips (ip, ts, reason) VALUES (?, ?, ?)").run(ip, Date.now(), "@" + target);
      }
      kick(target, 4003, "banned");
      dirty();
      event(`@${me} banned @${target}${msg.ip ? " and their IP addresses" : ""}`);
      return { ok: true };
    }
    case "unban":
      q("UPDATE accounts SET status = 'ok' WHERE username = ?").run(target);
      dirty();
      event(`@${me} unbanned @${target}`);
      return { ok: true };
    case "unban-ip":
      q("DELETE FROM banned_ips WHERE ip = ?").run(String(msg.ip || ""));
      event(`@${me} unbanned IP ${msg.ip}`);
      return { ok: true };
    case "remove": {
      kick(target, 4003, "removed");
      kvSet("oldKey:" + target, JSON.parse(acct.ecdhPub));
      q("DELETE FROM accounts WHERE username = ?").run(target);
      q("DELETE FROM queue WHERE recipient = ?").run(target);
      q("DELETE FROM push_subs WHERE username = ?").run(target);
      kvSet("cfRemoved", [...new Set([...kvGet("cfRemoved", []), target])]);
      event(`@${me} removed @${target} (their username is free again; saved messages are kept)`);
      return { ok: true };
    }
    // Everything a person sent or received, with the admin copies to read.
    case "messages": {
      const before = Number(msg.before) || Date.now() + 1;
      const rows = q(`SELECT id, sender, recipient, ts, escrow FROM archive
        WHERE (sender = ? OR recipient = ?) AND ts < ? AND kind != 'chunk' ORDER BY ts DESC LIMIT 400`).all(target, target, before);
      return { messages: rows, keys: senderKeys(rows), done: rows.length < 400 };
    }
    case "search": {
      // Only who/when can be searched here; words are searched in the browser after decrypting.
      const rows = q(`SELECT id, sender, recipient, ts, escrow FROM archive WHERE kind = 'msg' ORDER BY ts DESC LIMIT 1000`).all();
      return { messages: rows, keys: senderKeys(rows) };
    }
    case "file": {
      const rows = q("SELECT sender, escrow FROM archive WHERE fid = ? AND kind = 'chunk' ORDER BY ts").all(String(msg.fid || ""));
      return { pieces: rows, keys: senderKeys(rows) };
    }
    case "proxy-log":
      return { log: q("SELECT username, url, ts FROM proxy_log ORDER BY n DESC LIMIT 500").all() };
    default:
      throw new Error("unknown admin action");
  }
}

function senderKeys(rows) {
  const keys = {};
  for (const r of rows) {
    if (keys[r.sender]) continue;
    const a = getAccount(r.sender);
    keys[r.sender] = a ? JSON.parse(a.ecdhPub) : (kvGet("oldKey:" + r.sender, null));
  }
  return keys;
}

// ---------- sign-in ----------

const ipBanned = (ip) => !!(ip && q("SELECT 1 FROM banned_ips WHERE ip = ?").get(ip));

function signedIn(a, ip) {
  q("UPDATE accounts SET lastIp = COALESCE(?, lastIp), lastSeen = ? WHERE username = ?").run(ip || null, Date.now(), a.username);
}

function sessionUser(name, token) {
  if (typeof token !== "string" || token.length !== 48) return null;
  const s = q("SELECT * FROM sessions WHERE token = ? AND username = ?").get(token, name);
  if (!s || Date.now() - s.created > SESSION_TTL_MS) return null;
  return getAccount(name);
}

async function httpOp(name, msg, ip) {
  const a = msg.op === "challenge" ? await ensureAccount(name) : getAccount(name);
  if (!a) return [404, { error: "No such user" }];
  const now = Date.now();
  if (msg.op === "challenge") {
    for (const [c, v] of challenges) if (now - v.ts > 120e3) challenges.delete(c);
    const challenge = crypto.randomUUID();
    challenges.set(challenge, { ts: now, name });
    return [200, { challenge }];
  }
  if (msg.op === "auth") {
    const issued = challenges.get(msg.challenge);
    challenges.delete(msg.challenge);
    if (a.status === "banned" || ipBanned(ip)) return [403, { error: "This account has been banned." }];
    if (!issued || issued.name !== name || now - issued.ts > 120e3) return [401, { error: "challenge expired" }];
    if (!(await S.verify(JSON.parse(a.sigPub), msg.signature, msg.challenge))) return [403, { error: "auth failed" }];
    const token = S.randomHex(24);
    q("INSERT INTO sessions (token, username, created) VALUES (?, ?, ?)").run(token, name, now);
    q(`DELETE FROM sessions WHERE username = ? AND (created < ? OR token NOT IN
      (SELECT token FROM sessions WHERE username = ? ORDER BY created DESC LIMIT 20))`).run(name, now - SESSION_TTL_MS, name);
    signedIn(a, ip);
    return [200, { token, username: name, ...flags(a) }];
  }
  const user = sessionUser(name, msg.token);
  if (!user || user.status === "banned") return [401, { error: "session expired" }];
  if (msg.op === "poll") {
    lastPoll.set(name, now);
    const after = msg.after && Number.isFinite(msg.after.ts) && typeof msg.after.id === "string" ? msg.after : { ts: -1, id: "" };
    const rows = q("SELECT env FROM queue WHERE recipient = ? AND (ts > ? OR (ts = ? AND id > ?)) ORDER BY ts, id LIMIT 200")
      .all(name, after.ts, after.ts, after.id);
    const eph = (ephemeral.get(name) || []).filter((m) => now - m.ts < 60e3);
    ephemeral.delete(name);
    return [200, { messages: [...rows.map((r) => JSON.parse(r.env)), ...eph] }];
  }
  if (msg.op === "ack") { ack(name, msg.items); return [200, { ok: true }]; }
  const r = await op(user, msg.op, msg);
  return r ? [200, r] : [400, { error: "unknown op" }];
}

// ---------- HTTP ----------

const MAX_BODY = 2 * S.MAX_ENVELOPE_BYTES + 8192;
const clientIp = (req) => String(req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "").slice(0, 64);

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("too large")); req.destroy(); return; }
      parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

function reply(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json", ...S.CORS });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const ip = clientIp(req);
    if (req.method === "OPTIONS") { res.writeHead(204, S.CORS); return res.end(); }

    if (url.pathname === "/api/register" && req.method === "POST") {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return reply(res, 400, { error: "bad json" }); }
      const name = String(body.username || "").toLowerCase();
      if (!S.USERNAME.test(name)) return reply(res, 400, { error: "Usernames are 3-20 characters: a-z, 0-9 and _" });
      if (S.RESERVED.has(name)) return reply(res, 409, { error: "That username is reserved" });
      if (!S.isPublicJwk(body.sigPub) || !S.isPublicJwk(body.ecdhPub)) return reply(res, 400, { error: "bad keys" });
      if (ipBanned(ip)) return reply(res, 403, { error: "Sign-ups from this network are blocked." });
      if (getAccount(name) || (await takenOnBackup(name))) return reply(res, 409, { error: "That username is taken" });
      q("INSERT INTO accounts (username, sigPub, ecdhPub, created, signupIp, lastIp, lastSeen) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(name, JSON.stringify(body.sigPub), JSON.stringify(body.ecdhPub), Date.now(), ip, ip, Date.now());
      event(`New account @${name}`);
      syncSoon();
      return reply(res, 200, { ok: true, username: name });
    }

    let m = url.pathname.match(/^\/api\/user\/([a-z0-9_]{3,20})$/);
    if (m && req.method === "GET") {
      const a = await ensureAccount(m[1]);
      return a && a.status !== "banned" ? reply(res, 200, pub(a)) : reply(res, 404, { error: "No such user" });
    }

    m = url.pathname.match(/^\/api\/http\/([a-z0-9_]{3,20})$/);
    if (m && req.method === "POST") {
      let msg;
      try { msg = JSON.parse(await readBody(req)); } catch { return reply(res, 400, { error: "bad request" }); }
      const [status, data] = await httpOp(m[1], msg || {}, ip);
      return reply(res, status, data);
    }

    if (url.pathname === "/api/vapid") {
      const v = kvGet("vapid", null);
      return v ? reply(res, 200, { key: v.publicKey }) : reply(res, 503, { error: "not ready" });
    }
    if (url.pathname === "/api/admin-key") {
      const a = ADMINS[0] && (await ensureAccount(ADMINS[0]));
      return reply(res, 200, a ? { ecdhPub: JSON.parse(a.ecdhPub) } : {});
    }
    if (url.pathname === "/api/ice") {
      const name = url.searchParams.get("u") || "guest";
      const turn = config.turn && publicIp ? { ...config.turn, host: publicIp } : null;
      return reply(res, 200, { iceServers: [...S.STUN, ...(await S.coturnServers(turn, S.USERNAME.test(name) ? name : "guest"))] });
    }

    // The web viewer: /p/<ticket>/page?u=… and /p/<ticket>/res?u=…
    m = url.pathname.match(/^\/p\/([0-9a-f]{40})\/(page|res)$/);
    if (m && req.method === "GET") {
      const t = proxyTickets.get(m[1]);
      const a = t && t.until > Date.now() && getAccount(t.username);
      if (!a || a.status === "banned" || !proxyAllowed(flags(a))) { res.writeHead(403, { "Content-Type": "text/plain" }); return res.end("The web viewer link expired. Open it again from FreeMessenger."); }
      const target = url.searchParams.get("u") || "";
      const base = `/p/${m[1]}`;
      if (m[2] === "page") {
        q("INSERT INTO proxy_log (username, url, ts) VALUES (?, ?, ?)").run(a.username, target.slice(0, 2000), Date.now());
        return proxyPage(target, base, res);
      }
      return proxyResource(target, base, res);
    }

    if (url.pathname === "/" || url.pathname === "/api") return reply(res, 200, { ok: true, service: "FreeMessenger relay", primary: true });
    return reply(res, 404, { error: "not found" });
  } catch (e) {
    log("request error", e);
    if (!res.headersSent) reply(res, 500, { error: "server error" });
    else res.end();
  }
});

// A name someone already took on the backup relay (that hasn't synced yet).
async function takenOnBackup(name) {
  if (!BACKUP) return false;
  try {
    const r = await fetch(`${BACKUP}/api/user/${name}`, { signal: AbortSignal.timeout(4000) });
    return r.status === 200;
  } catch {
    return false;
  }
}

// An account made on the backup relay that hasn't synced here yet: copy its
// public keys now, so its owner can sign in right away.
async function ensureAccount(name) {
  const a = getAccount(name);
  if (a || !BACKUP || kvGet("cfRemoved", []).includes(name)) return a;
  try {
    const r = await fetch(`${BACKUP}/api/user/${name}`, { signal: AbortSignal.timeout(5000) });
    if (r.status !== 200) return null;
    const p = await r.json();
    if (!S.isPublicJwk(p.sigPub) || !S.isPublicJwk(p.ecdhPub) || getAccount(name)) return getAccount(name);
    q("INSERT INTO accounts (username, sigPub, ecdhPub, created, origin, cfDirty, profile) VALUES (?, ?, ?, ?, 'cf', 0, ?)")
      .run(name, JSON.stringify(p.sigPub), JSON.stringify(p.ecdhPub), Date.now(), JSON.stringify(S.cleanProfile(p.profile)));
    event(`New account @${name} (made on the backup relay)`);
    // Ask the backup relay for anything still waiting there for them.
    kvSet("cfPull", [...new Set([...kvGet("cfPull", []), name])]);
    syncSoon();
    return getAccount(name);
  } catch {
    return null;
  }
}

// ---------- WebSocket ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY });
server.on("upgrade", async (req, socket, head) => {
  const m = new URL(req.url, "http://localhost").pathname.match(/^\/api\/ws\/([a-z0-9_]{3,20})$/);
  const a = m && (await ensureAccount(m[1]));
  if (!a) { socket.end("HTTP/1.1 404 Not Found\r\n\r\n"); return; }
  wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, m[1], clientIp(req)));
});

function onSocket(ws, name, ip) {
  const challenge = crypto.randomUUID();
  let authed = false;
  ws.send(JSON.stringify({ type: "challenge", challenge }));
  ws.on("message", async (data) => {
    const raw = data.toString();
    if (raw === "ping") return ws.send("pong");
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const a = getAccount(name);
    if (!a) return ws.close(4003, "removed");
    if (!authed) {
      if (msg.type !== "auth") return;
      if (a.status === "banned" || ipBanned(ip)) {
        ws.send(JSON.stringify({ type: "error", error: "This account has been banned." }));
        return ws.close(4003, "banned");
      }
      if (!(await S.verify(JSON.parse(a.sigPub), msg.signature, challenge))) {
        ws.send(JSON.stringify({ type: "error", error: "auth failed" }));
        return ws.close(4001, "auth failed");
      }
      authed = true;
      if (!sockets.has(name)) sockets.set(name, new Set());
      sockets.get(name).add(ws);
      signedIn(a, ip);
      ws.send(JSON.stringify({ type: "ready", username: name, ...flags(a) }));
      for (const r of q("SELECT env FROM queue WHERE recipient = ? ORDER BY ts, id").iterate(name)) ws.send(`{"type":"message",${r.env.slice(1)}`);
      return;
    }
    if (msg.type === "ack") return ack(name, msg.items);
    const r = await op(a, msg.type, msg);
    if (r) ws.send(JSON.stringify({ type: "sent", ref: msg.ref, ...r }));
  });
  ws.on("close", () => {
    const set = sockets.get(name);
    if (set) { set.delete(ws); if (!set.size) sockets.delete(name); }
  });
  ws.on("error", () => {});
}

// ---------- the quick tunnel ----------

let tunnelUrl = config.publicUrl || null;
let publicIp = null;

function startTunnel() {
  if (config.publicUrl || !config.cloudflared) return;
  const child = spawn(config.cloudflared, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PORT}`], { windowsHide: true });
  const scan = (buf) => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && m[0] !== tunnelUrl) {
      tunnelUrl = m[0];
      event(`Tunnel is up at ${tunnelUrl}`);
      syncSoon();
    }
  };
  child.stdout.on("data", scan);
  child.stderr.on("data", scan);
  child.on("exit", (code) => {
    event(`Tunnel stopped (${code}); restarting in 10 s`);
    tunnelUrl = null;
    setTimeout(startTunnel, 10e3);
  });
  process.on("exit", () => child.kill());
}

async function refreshPublicIp() {
  try {
    // 1.1.1.1 only answers over IPv4, which is what the TURN server listens on.
    const text = await (await fetch("https://1.1.1.1/cdn-cgi/trace", { signal: AbortSignal.timeout(8000) })).text();
    const m = text.match(/^ip=(.+)$/m);
    if (m) publicIp = m[1].trim();
  } catch {}
}
setInterval(refreshPublicIp, 10 * 60e3);

// ---------- sync with the backup relay ----------

const pendingCf = [];
let lastSync = null;
let syncing = false;
let syncTimer = null;
let archiveAcks = {};

function syncSoon() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 1500);
}

async function syncNow() {
  clearTimeout(syncTimer);
  if (!BACKUP || !config.syncKey) return;
  if (syncing) { syncTimer = setTimeout(syncNow, 2000); return; }
  syncing = true;
  let again = false;
  try {
    const dirty = q("SELECT * FROM accounts WHERE cfDirty > 0 LIMIT 25").all();
    const deliverNow = pendingCf.splice(0, 200);
    const acks = Object.fromEntries(pendingCfAcks);
    pendingCfAcks.clear();
    const removed = kvGet("cfRemoved", []);
    const pull = kvGet("cfPull", []);
    const body = {
      pull,
      ts: Date.now(),
      primary: tunnelUrl,
      admins: ADMINS,
      turn: config.turn && publicIp ? { ...config.turn, host: publicIp } : null,
      wantVapid: !kvGet("vapid", null),
      accounts: dirty.map((a) => ({
        username: a.username, sigPub: JSON.parse(a.sigPub), ecdhPub: JSON.parse(a.ecdhPub), created: a.created,
        profile: JSON.parse(a.profile || "{}"), profileTs: a.profileTs, status: a.status, timeoutUntil: a.timeoutUntil, proxy: !!a.proxy,
        push: q("SELECT sub FROM push_subs WHERE username = ?").all(a.username).map((r) => JSON.parse(r.sub)),
      })),
      removed,
      deliver: deliverNow,
      acks,
      archiveAcks,
    };
    const r = await fetch(`${BACKUP}/api/sync`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: await S.signSync(config.syncKey.privateJwk, body),
      signal: AbortSignal.timeout(60e3),
    });
    if (!r.ok) {
      // Put things back for the next try.
      pendingCf.unshift(...deliverNow);
      for (const [n, items] of Object.entries(acks)) pendingCfAcks.set(n, [...items, ...(pendingCfAcks.get(n) || [])]);
      throw new Error(`backup relay said ${r.status}`);
    }
    const out = await r.json();
    for (const a of dirty) q("UPDATE accounts SET cfDirty = 0 WHERE username = ? AND cfDirty = ?").run(a.username, a.cfDirty);
    if (removed.length) kvSet("cfRemoved", kvGet("cfRemoved", []).filter((n) => !removed.includes(n)));
    if (pull.length) kvSet("cfPull", kvGet("cfPull", []).filter((n) => !pull.includes(n)));
    archiveAcks = {};
    if (out.vapid && out.vapid.publicKey) kvSet("vapid", out.vapid);
    for (const u of out.users || []) importFromBackup(u);
    lastSync = { ok: true, ts: Date.now() };
    again = out.more || q("SELECT 1 FROM accounts WHERE cfDirty > 0").get() || pendingCf.length;
  } catch (e) {
    lastSync = { ok: false, ts: Date.now(), error: String(e.message || e) };
    log("sync failed:", lastSync.error);
  } finally {
    syncing = false;
    syncTimer = setTimeout(syncNow, again ? 1000 : SYNC_EVERY_MS);
  }
}

function importFromBackup(u) {
  if (!u || !S.USERNAME.test(u.username || "")) return;
  const name = u.username;
  const acc = u.account;
  let a = getAccount(name);
  if (!a && acc) {
    if (kvGet("cfRemoved", []).includes(name)) return;
    q("INSERT INTO accounts (username, sigPub, ecdhPub, created, signupIp, lastIp, lastSeen, origin, cfDirty) VALUES (?, ?, ?, ?, ?, ?, ?, 'cf', 0)")
      .run(name, JSON.stringify(acc.sigPub), JSON.stringify(acc.ecdhPub), acc.created || Date.now(), acc.ip || null, acc.ip || null, acc.seen || null);
    event(`New account @${name} (made on the backup relay)`);
    a = getAccount(name);
  } else if (a && acc && JSON.parse(a.sigPub).x !== acc.sigPub.x) {
    event(`@${name} was also taken on the backup relay by someone else; the one here was kept.`);
    markCf(name);
  }
  if (!a) return;
  if (acc) {
    if (acc.seen && acc.seen > (a.lastSeen || 0)) q("UPDATE accounts SET lastSeen = ?, lastIp = COALESCE(?, lastIp) WHERE username = ?").run(acc.seen, acc.ip || null, name);
    if (acc.profile && acc.profileTs > (a.profileTs || 0)) q("UPDATE accounts SET profile = ?, profileTs = ? WHERE username = ?").run(JSON.stringify(S.cleanProfile(acc.profile)), acc.profileTs, name);
  }
  for (const sub of u.push || []) pushSubscribe(name, sub);
  if (u.online) cfOnline.set(name, Date.now());
  for (const i of u.acked || []) q("DELETE FROM queue WHERE recipient = ? AND id = ?").run(name, i.id);
  for (const env of u.queue || []) {
    if (!env || typeof env.id !== "string" || typeof env.body !== "string") continue;
    if (enqueue(name, env, "cf")) for (const ws of live(name)) ws.send(JSON.stringify({ type: "message", ...env }));
  }
  const keys = [];
  for (const item of u.archive || []) {
    if (item && item.env && S.USERNAME.test(item.to || "")) archive(item.env.from, item.to, item.env, item.escrow, S.cleanMeta(item.meta));
    if (item && item.key) keys.push(item.key);
  }
  if (keys.length) archiveAcks[name] = keys;
}

// ---------- start ----------

server.listen(PORT, "127.0.0.1", async () => {
  log(`FreeMessenger relay on http://127.0.0.1:${PORT}, data in ${DATA}, ${(used / 1024 ** 3).toFixed(2)} GB of ${config.capGB || 100} GB used`);
  await refreshPublicIp();
  startTunnel();
  syncNow();
});
