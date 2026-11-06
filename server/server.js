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
import nodeCrypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer } from "ws";
import dgram from "node:dgram";
import * as S from "../relay/src/shared.js";
import { proxyPage, proxyResource, proxyAllowed, linkPreview } from "./proxy.js";

const DATA = path.resolve(process.argv[2] || "data");
const CONFIG_FILE = path.join(DATA, "config.json");
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
const PORT = config.port || 8790;
const ADMINS = (config.admins || []).filter((n) => S.USERNAME.test(n));
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
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
  CREATE TABLE IF NOT EXISTS reports (
    n INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, reporter TEXT NOT NULL, reported TEXT NOT NULL,
    reason TEXT, message TEXT, context TEXT, status TEXT DEFAULT 'open'
  );
  CREATE TABLE IF NOT EXISTS announcements (n INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, text TEXT NOT NULL, by TEXT);
  CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, uses INTEGER NOT NULL, used INTEGER DEFAULT 0, created INTEGER, note TEXT);
  CREATE TABLE IF NOT EXISTS usage (username TEXT PRIMARY KEY, bytes INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS scheduled (
    id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL, at INTEGER NOT NULL,
    body TEXT NOT NULL, escrow TEXT, meta TEXT, hint TEXT
  );
  CREATE INDEX IF NOT EXISTS scheduled_at ON scheduled (at);
`);
// Columns added after the first release.
{
  const cols = db.prepare("PRAGMA table_info(accounts)").all().map((c) => c.name);
  if (!cols.includes("quotaGB")) db.exec("ALTER TABLE accounts ADD COLUMN quotaGB REAL");
  if (!cols.includes("hideSeen")) db.exec("ALTER TABLE accounts ADD COLUMN hideSeen INTEGER DEFAULT 0");
  if (!db.prepare("SELECT 1 FROM usage LIMIT 1").get()) {
    db.exec("INSERT OR REPLACE INTO usage (username, bytes) SELECT sender, SUM(size) FROM archive GROUP BY sender");
  }
}
const q = (sql) => db.prepare(sql);
const kvGet = (k, d) => { const r = q("SELECT v FROM kv WHERE k = ?").get(k); return r ? JSON.parse(r.v) : d; };
const kvSet = (k, v) => q("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, JSON.stringify(v));
// Accounts with changes the backup relay hasn't been told about.
const markCf = (name) => q("UPDATE accounts SET cfDirty = ? WHERE username = ?").run(Date.now(), name);
const event = (text) => { q("INSERT INTO events (ts, text) VALUES (?, ?)").run(Date.now(), text); log(text); };

const getAccount = (name) => q("SELECT * FROM accounts WHERE username = ?").get(name);
// Old usernames point at the new one after someone changes theirs.
const resolveName = (name) => (getAccount(name) ? name : kvGet("alias:" + name, null) || name);
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
// ---------- who is admin ----------
//
// Admin is tied to the exact signing key of the admin account (pinned in
// config.json the first time the account is seen here), not just the
// username, and the admin panel also needs a code from an authenticator app.

function pinFor(name) {
  return (config.adminPins || {})[name] || null;
}
function isAdmin(a) {
  if (!a || !ADMINS.includes(a.username)) return false;
  const pin = pinFor(a.username);
  if (!pin) return false;
  const k = JSON.parse(a.sigPub);
  return k.x === pin.x && k.y === pin.y;
}
function pinAdmins() {
  let changed = false;
  for (const name of ADMINS) {
    const a = getAccount(name);
    if (!a || pinFor(name)) continue;
    const k = JSON.parse(a.sigPub);
    config.adminPins = Object.assign({}, config.adminPins, { [name]: { x: k.x, y: k.y } });
    changed = true;
    event(`Admin @${name} is now tied to its current key`);
  }
  if (changed) saveConfig();
}

const TOTP_STEP = 30;
const unlockFailures = { n: 0, until: 0 };
const usedCodes = new Map(); // code+step -> time, so a code works only once

function base32Decode(text) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of text.replace(/[\s=]/g, "").toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v === -1) throw new Error("bad secret");
    bits += v.toString(2).padStart(5, "0");
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

function totpAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = nodeCrypto.createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}

function checkCode(code) {
  const now = Date.now();
  if (now < unlockFailures.until) return { error: `Too many wrong codes. Try again after ${new Date(unlockFailures.until).toLocaleTimeString()}.` };
  if (!config.adminTotp) return { error: "The admin code isn't set up on the home server." };
  const step = Math.floor(now / 1000 / TOTP_STEP);
  const c = String(code || "").replace(/\s/g, "");
  for (const d of [0, -1, 1]) {
    const expected = totpAt(config.adminTotp, step + d);
    if (/^\d{6}$/.test(c) && nodeCrypto.timingSafeEqual(Buffer.from(c), Buffer.from(expected))) {
      const key = c + ":" + (step + d);
      if (usedCodes.has(key)) return { error: "That code was already used. Wait for the next one." };
      usedCodes.set(key, now);
      for (const [k, t] of usedCodes) if (now - t > 5 * 60e3) usedCodes.delete(k);
      unlockFailures.n = 0;
      return { ok: true };
    }
  }
  if (++unlockFailures.n >= 5) {
    unlockFailures.until = now + 15 * 60e3;
    unlockFailures.n = 0;
    event("5 wrong admin codes in a row: the admin panel is locked for 15 minutes");
  }
  return { error: "Wrong code." };
}

const UNLOCK_MS = 8 * 3600e3;
const httpUnlocks = new Map(); // HTTP session token -> { unlockedUntil, trusted }

// ---------- trusted devices ----------
//
// A browser the admin trusts keeps a signing key it can't export (WebCrypto,
// non-extractable). It proves itself by signing this connection's sign-in
// challenge, and then needs no code. It can also show the current code, to
// sign in somewhere else.
//
// The first device is added with a one-time setup code that the relay writes
// to data/device-setup-code.txt (valid for an hour) whenever no device is trusted.

const trustedDevices = () => kvGet("trustedDevices", []);
let setupCode = null; // { code, until }

function makeSetupCode() {
  if (trustedDevices().length) { setupCode = null; return; }
  if (setupCode && setupCode.until > Date.now()) return;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const code = Array.from(nodeCrypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join("");
  setupCode = { code, until: Date.now() + 3600e3 };
  fs.writeFileSync(path.join(DATA, "device-setup-code.txt"),
    `FreeMessenger: code to trust your first admin browser\r\n\r\n${code}\r\n\r\nValid until ${new Date(setupCode.until).toLocaleString()}. Works once.\r\n`, { mode: 0o600 });
  event("No trusted admin browser yet: wrote a one-time setup code to device-setup-code.txt");
}

function checkSetupCode(code) {
  if (!setupCode || setupCode.until < Date.now()) return false;
  const c = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.length !== setupCode.code.length || !nodeCrypto.timingSafeEqual(Buffer.from(c), Buffer.from(setupCode.code))) return false;
  setupCode = null;
  try { fs.unlinkSync(path.join(DATA, "device-setup-code.txt")); } catch {}
  return true;
}

function addDevice(dev, name) {
  if (!dev || typeof dev.id !== "string" || !/^[0-9a-f]{32}$/.test(dev.id) || !S.isPublicJwk(dev.pub)) return false;
  const list = trustedDevices().filter((d) => d.id !== dev.id);
  list.push({ id: dev.id, pub: { kty: "EC", crv: "P-256", x: dev.pub.x, y: dev.pub.y }, name: String(dev.name || "Browser").slice(0, 80), added: Date.now(), by: name });
  kvSet("trustedDevices", list.slice(-10));
  event(`@${name} trusted a new admin browser: ${String(dev.name || "Browser").slice(0, 80)}`);
  return true;
}

const flags = (a) => ({ admin: isAdmin(a), proxy: isAdmin(a) || !!a.proxy, primary: true });

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
  const size = env.body.length + (escrow || "").length;
  const r = q("INSERT OR IGNORE INTO archive (id, sender, recipient, ts, body, escrow, kind, fid, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(env.id, from, to, env.ts, env.body, escrow || null, kind, (meta && meta.fid) || null, size);
  if (r.changes) q("INSERT INTO usage (username, bytes) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET bytes = bytes + excluded.bytes").run(from, size);
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
  const to = resolveName(String(msg.to || "").toLowerCase());
  if (!S.USERNAME.test(to)) return { error: "bad recipient" };
  const target = getAccount(to);
  if (!target || target.status === "banned") return { error: "No such user" };
  if (typeof msg.body !== "string" || msg.body.length > S.MAX_ENVELOPE_BYTES) return { error: "message too large" };
  if (msg.escrow !== undefined && (typeof msg.escrow !== "string" || msg.escrow.length > S.MAX_ENVELOPE_BYTES)) return { error: "message too large" };
  const fresh = getAccount(a.username);
  if (fresh.status === "frozen") return { error: "Your account is frozen by the admin.", blocked: true };
  if (fresh.status === "pending") return { error: "Your account is waiting for the admin's approval.", blocked: true };
  if (!msg.ephemeral && usageOf(a.username) > quotaBytes(fresh)) return { error: "You've used all your storage on this server. Ask the admin for more.", blocked: true };
  if (fresh.timeoutUntil > Date.now()) return { error: `You're timed out until ${new Date(fresh.timeoutUntil).toUTCString()}.`, blocked: true, until: fresh.timeoutUntil };
  const hint = msg.hint === "msg" || msg.hint === "call" ? msg.hint : undefined;
  if (!S.allowSend(limiter, a.username, hint, S.cleanMeta(msg.meta))) return { error: "Slow down: one message a second.", slow: true };
  if (!msg.ephemeral && used > CAP_BYTES) return { error: "The server's storage is full. Tell the admin." };
  // Scheduled: kept here (still encrypted) and sent at that time, even if the sender is offline.
  if (!msg.ephemeral && Number.isFinite(msg.at) && msg.at > Date.now() + 5000) {
    if (msg.at > Date.now() + 366 * 86400e3) return { error: "You can schedule up to a year ahead." };
    if (q("SELECT COUNT(*) AS n FROM scheduled WHERE sender = ?").get(a.username).n >= 500) return { error: "You have too many scheduled messages." };
    const id = crypto.randomUUID();
    q("INSERT INTO scheduled (id, sender, recipient, at, body, escrow, meta, hint) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, a.username, to, Math.round(msg.at), msg.body, msg.escrow || null, JSON.stringify(S.cleanMeta(msg.meta) || null), hint || null);
    return { scheduled: true, sid: id };
  }
  const env = { id: crypto.randomUUID(), from: a.username, ts: Date.now(), ephemeral: !!msg.ephemeral, body: msg.body };
  const meta = S.cleanMeta(msg.meta);
  if (!env.ephemeral) archive(a.username, to, env, msg.escrow, meta);
  // Your other signed-in devices see what you send, as you send it.
  if (!env.ephemeral && !(meta && meta.k === "chunk") && to !== a.username) {
    for (const ws of live(a.username)) ws.send(JSON.stringify({ type: "mirror", to, ...env }));
  }
  return { id: env.id, ts: env.ts, ...deliver(to, env, hint) };
}

// ---------- scheduled messages ----------

function sendScheduled() {
  for (const row of q("SELECT * FROM scheduled WHERE at <= ? ORDER BY at LIMIT 200").all(Date.now())) {
    q("DELETE FROM scheduled WHERE id = ?").run(row.id);
    const target = getAccount(row.recipient);
    if (!target || target.status === "banned") continue;
    const env = { id: crypto.randomUUID(), from: row.sender, ts: Date.now(), ephemeral: false, body: row.body };
    archive(row.sender, row.recipient, env, row.escrow, JSON.parse(row.meta || "null"));
    deliver(row.recipient, env, row.hint || undefined);
  }
}
setInterval(sendScheduled, 10e3);

// ---------- storage per person ----------

const usageOf = (name) => (q("SELECT bytes FROM usage WHERE username = ?").get(name) || { bytes: 0 }).bytes;
function quotaBytes(a) {
  if (ADMINS.includes(a.username)) return Infinity;
  const gb = a.quotaGB != null ? a.quotaGB : kvGet("defaultQuotaGB", 5);
  return gb > 0 ? gb * 1024 ** 3 : Infinity;
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

async function op(a, type, msg, sess) {
  if (type === "send") return send(a, msg);
  if (type === "push-sub") return pushSubscribe(a.username, msg.sub);
  if (type === "push-unsub") return pushUnsubscribe(a.username, msg.endpoint);
  if (type === "profile") {
    q("UPDATE accounts SET profile = ?, profileTs = ? WHERE username = ?").run(JSON.stringify(S.cleanProfile(msg.profile)), Date.now(), a.username);
    markCf(a.username);
    return { ok: true };
  }
  if (type === "history") return history(a.username, msg);
  if (type === "announcements") return { announcements: announcementsSince(msg.after) };
  if (type === "rename") return renameAccount(a, String(msg.name || "").toLowerCase());
  // Online / last seen. Like WhatsApp: if you hide yours, you can't see anyone's.
  if (type === "privacy") {
    q("UPDATE accounts SET hideSeen = ? WHERE username = ?").run(msg.hideSeen ? 1 : 0, a.username);
    return { ok: true };
  }
  if (type === "presence") {
    const meAcct = getAccount(a.username);
    if (meAcct.hideSeen) return { presence: {}, hidden: true };
    const out = {};
    for (const n of (Array.isArray(msg.users) ? msg.users : []).slice(0, 300)) {
      const u = getAccount(String(n));
      if (!u || u.hideSeen || u.status === "banned") continue;
      out[u.username] = { online: isOnline(u.username), seen: u.lastSeen || 0 };
    }
    return { presence: out };
  }
  if (type === "unschedule") {
    const ids = (Array.isArray(msg.sids) ? msg.sids : []).slice(0, 100);
    let n = 0;
    for (const id of ids) n += q("DELETE FROM scheduled WHERE id = ? AND sender = ?").run(String(id), a.username).changes;
    return { ok: true, removed: n };
  }
  if (type === "preview") {
    if (!limiter.take("p:" + a.username, 0.5, 20)) return { error: "slow down" };
    try {
      const p = await linkPreview(String(msg.url || ""));
      return p ? { preview: p } : { none: true };
    } catch {
      return { none: true };
    }
  }
  if (type === "report") {
    const reported = String(msg.reported || "").toLowerCase();
    if (!S.USERNAME.test(reported) || reported === a.username) return { error: "Can't report that." };
    const recent = q("SELECT COUNT(*) AS n FROM reports WHERE reporter = ? AND ts > ?").get(a.username, Date.now() - 3600e3).n;
    if (recent >= 20) return { error: "You've sent a lot of reports. Try again later." };
    q("INSERT INTO reports (ts, reporter, reported, reason, message, context) VALUES (?, ?, ?, ?, ?, ?)").run(
      Date.now(), a.username, reported, String(msg.reason || "").slice(0, 500),
      JSON.stringify(msg.message || {}).slice(0, 20000), JSON.stringify(Array.isArray(msg.context) ? msg.context.slice(-15) : []).slice(0, 60000));
    event(`@${a.username} reported @${reported}`);
    return { ok: true };
  }
  if (type === "proxy-ticket") {
    if (!proxyAllowed(flags(getAccount(a.username)))) return { error: "The admin hasn't given you the web viewer." };
    for (const [t, v] of proxyTickets) if (v.until < Date.now()) proxyTickets.delete(t);
    const ticket = S.randomHex(20);
    proxyTickets.set(ticket, { username: a.username, until: Date.now() + 2 * 3600e3 });
    return { ticket };
  }
  if (type === "admin") {
    if (!isAdmin(a)) {
      if (ADMINS.includes(a.username)) event(`Refused admin to @${a.username}: the key doesn't match the pinned admin key`);
      return { error: "Only the admin can do that." };
    }
    // A trusted browser signs this connection's challenge: no code needed.
    if (msg.action === "device-unlock") {
      const d = trustedDevices().find((x) => x.id === msg.deviceId);
      if (!d || !sess.nonce || !(await S.verify(d.pub, msg.sig, "fm-admin-device:" + sess.nonce))) return { error: "This browser isn't trusted.", needCode: true };
      sess.unlockedUntil = Date.now() + UNLOCK_MS;
      sess.trusted = d.id;
      return { ok: true, trusted: true };
    }
    if (msg.action === "unlock") {
      if (Date.now() < unlockFailures.until) return checkCode("");
      const viaSetup = checkSetupCode(msg.code);
      const r = viaSetup ? { ok: true } : checkCode(msg.code);
      if (r.error) { event(`Wrong admin code for @${a.username}`); return r; }
      sess.unlockedUntil = Date.now() + UNLOCK_MS;
      // A first-time setup code always trusts this browser; a normal code does if asked.
      if ((viaSetup || msg.trust) && msg.device && addDevice(msg.device, a.username)) sess.trusted = msg.device.id;
      event(`Admin panel unlocked by @${a.username}${sess.trusted ? " (browser now trusted)" : ""}`);
      return { ok: true, trusted: !!sess.trusted };
    }
    if (!sess || !(sess.unlockedUntil > Date.now())) {
      makeSetupCode();
      return { error: trustedDevices().length ? "Enter the code shown on your trusted browser." : "Enter the setup code from the home PC.", needCode: true, firstDevice: !trustedDevices().length };
    }
    if (msg.action === "current-code") {
      if (!sess.trusted || !trustedDevices().some((d) => d.id === sess.trusted)) return { error: "Only a trusted browser can show codes." };
      if (!config.adminTotp) return { error: "The admin code isn't set up on the home server." };
      const now = Date.now() / 1000;
      return { code: totpAt(config.adminTotp, Math.floor(now / TOTP_STEP)), left: Math.ceil(TOTP_STEP - (now % TOTP_STEP)) };
    }
    if (msg.action === "devices") return { devices: trustedDevices().map((d) => ({ id: d.id, name: d.name, added: d.added, current: d.id === sess.trusted })) };
    if (msg.action === "untrust") {
      kvSet("trustedDevices", trustedDevices().filter((d) => d.id !== msg.id));
      if (sess.trusted === msg.id) sess.trusted = null;
      event(`@${a.username} stopped trusting an admin browser`);
      return { ok: true };
    }
    try { return await admin(a.username, msg); } catch (e) { return { error: e.message }; }
  }
  return null;
}

// Your own messages, both ways, for a new browser. Newest first, in pages.
function history(name, msg) {
  // "after": everything newer, oldest first (keeps your devices in sync).
  if (msg.after !== undefined) {
    const after = Number(msg.after) || 0;
    const rows = q(`SELECT id, sender, recipient, ts, body FROM archive
      WHERE (sender = ? OR recipient = ?) AND ts > ? AND kind != 'chunk' ORDER BY ts LIMIT 500`).all(name, name, after);
    return { messages: rows.map((r) => ({ id: r.id, from: r.sender, to: r.recipient, ts: r.ts, body: r.body })), done: rows.length < 500 };
  }
  const before = Number(msg.before) || Date.now() + 1;
  const rows = q(`SELECT id, sender, recipient, ts, body FROM archive
    WHERE (sender = ? OR recipient = ?) AND ts < ? AND kind != 'chunk' ORDER BY ts DESC LIMIT 300`).all(name, name, before);
  return { messages: rows.map((r) => ({ id: r.id, from: r.sender, to: r.recipient, ts: r.ts, body: r.body })), done: rows.length < 300 };
}

// ---------- changing your username ----------
//
// Everything moves to the new name; the old one keeps pointing to it, so
// people who still have the old name can reach you. Once a month at most.

async function renameAccount(a, name) {
  const old = a.username;
  if (ADMINS.includes(old)) return { error: "The admin account's username can't be changed." };
  if (!S.USERNAME.test(name)) return { error: "Usernames are 3-20 characters: a-z, 0-9 and _" };
  if (name === old) return { error: "That's already your username." };
  if (S.RESERVED.has(name) || ADMINS.includes(name)) return { error: "That username is reserved" };
  if (getAccount(name) || kvGet("alias:" + name, null) || (await takenOnBackup(name))) return { error: "That username is taken" };
  const last = kvGet("renamed:" + old, 0);
  if (Date.now() - last < 30 * 86400e3) return { error: "You can change your username once a month." };
  db.exec("BEGIN");
  try {
    q("UPDATE accounts SET username = ? WHERE username = ?").run(name, old);
    q("UPDATE archive SET sender = ? WHERE sender = ?").run(name, old);
    q("UPDATE archive SET recipient = ? WHERE recipient = ?").run(name, old);
    q("UPDATE queue SET recipient = ? WHERE recipient = ?").run(name, old);
    q("UPDATE scheduled SET sender = ? WHERE sender = ?").run(name, old);
    q("UPDATE scheduled SET recipient = ? WHERE recipient = ?").run(name, old);
    q("UPDATE sessions SET username = ? WHERE username = ?").run(name, old);
    q("UPDATE push_subs SET username = ? WHERE username = ?").run(name, old);
    q("UPDATE OR REPLACE usage SET username = ? WHERE username = ?").run(name, old);
    for (const [k, v] of q("SELECT k, v FROM kv WHERE k LIKE 'alias:%'").all().map((r) => [r.k, JSON.parse(r.v)])) {
      if (v === old) kvSet(k, name);
    }
    kvSet("alias:" + old, name);
    kvSet("renamed:" + name, Date.now());
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  kvSet("cfRemoved", [...new Set([...kvGet("cfRemoved", []), old])]);
  markCf(name);
  syncSoon();
  event(`@${old} changed their username to @${name}`);
  setTimeout(() => kick(old, 4005, "renamed"), 500);
  return { ok: true, username: name };
}

// ---------- admin panel ----------

function accountRow(r) {
  const counts = q("SELECT COUNT(*) AS n, 0 AS bytes FROM archive WHERE sender = ? AND kind = 'msg'").get(r.username);
  return {
    username: r.username, created: r.created, signupIp: r.signupIp, lastIp: r.lastIp, lastSeen: r.lastSeen,
    status: r.status, timeoutUntil: r.timeoutUntil, proxy: !!r.proxy, admin: isAdmin(r),
    profile: JSON.parse(r.profile || "{}"), sent: counts.n, bytes: counts.bytes, online: isOnline(r.username),
    origin: r.origin, note: r.note || "",
    used: usageOf(r.username), quotaGB: r.quotaGB, quota: quotaBytes(r) === Infinity ? 0 : quotaBytes(r),
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
          backup: lastSync, tunnel: tunnelUrl, dbBackup: lastBackup, forwards, turnCheck,
          openReports: q("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'").get().n,
          pending: q("SELECT COUNT(*) AS n FROM accounts WHERE status = 'pending'").get().n,
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
    case "approve":
      q("UPDATE accounts SET status = 'ok' WHERE username = ? AND status = 'pending'").run(target);
      dirty();
      event(`@${me} approved @${target}`);
      return { ok: true };
    case "quota": {
      const gb = msg.gb === null || msg.gb === "" ? null : Math.max(0, Number(msg.gb) || 0);
      q("UPDATE accounts SET quotaGB = ? WHERE username = ?").run(gb, target);
      event(`@${me} set @${target}'s storage limit to ${gb === null ? "the default" : gb ? gb + " GB" : "unlimited"}`);
      return { ok: true };
    }
    case "settings":
      return {
        signupMode: signupMode(),
      oldNames: q("SELECT k FROM kv WHERE k LIKE 'alias:%' LIMIT 5000").all().map((r) => r.k.slice(6)),
      checkTurn: !!(config.turn && publicIp) && Date.now() - lastTurnCheck > 30 * 60e3, defaultQuotaGB: kvGet("defaultQuotaGB", 5), watchWords: kvGet("watchWords", []),
        invites: q("SELECT * FROM invites ORDER BY created DESC").all(), backup: lastBackup, backupDir: BACKUP_DIR,
      };
    case "set-settings": {
      if (["open", "approval", "invite", "closed"].includes(msg.signupMode)) {
        kvSet("signupMode", msg.signupMode);
        event(`@${me} set sign-ups to "${msg.signupMode}"`);
        syncSoon();
      }
      if (msg.defaultQuotaGB !== undefined) kvSet("defaultQuotaGB", Math.max(0, Number(msg.defaultQuotaGB) || 0));
      if (Array.isArray(msg.watchWords)) kvSet("watchWords", msg.watchWords.map((w) => String(w).trim().toLowerCase()).filter(Boolean).slice(0, 200));
      return { ok: true };
    }
    case "invite": {
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const code = Array.from(nodeCrypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join("");
      q("INSERT INTO invites (code, uses, created, note) VALUES (?, ?, ?, ?)").run(code, Math.max(1, Math.min(1000, Number(msg.uses) || 1)), Date.now(), String(msg.note || "").slice(0, 100));
      return { code };
    }
    case "delete-invite":
      q("DELETE FROM invites WHERE code = ?").run(String(msg.code || ""));
      return { ok: true };
    case "backup":
      return { backup: backupNow() };
    case "reports":
      return { reports: q("SELECT * FROM reports ORDER BY (status = 'open') DESC, n DESC LIMIT 300").all() };
    case "resolve-report":
      q("UPDATE reports SET status = ? WHERE n = ?").run(msg.open ? "open" : "done", Number(msg.n));
      return { ok: true };
    case "announce": {
      const text = String(msg.text || "").trim().slice(0, 2000);
      if (!text) throw new Error("Write something first.");
      const r = q("INSERT INTO announcements (ts, text, by) VALUES (?, ?, ?)").run(Date.now(), text, me);
      const item = { n: Number(r.lastInsertRowid), ts: Date.now(), text };
      for (const set of sockets.values()) for (const ws of set) ws.send(JSON.stringify({ type: "announce", ...item }));
      event(`@${me} sent an announcement`);
      return { ok: true };
    }
    case "announcements":
      return { announcements: q("SELECT * FROM announcements ORDER BY n DESC LIMIT 50").all() };
    case "delete-announcement":
      q("DELETE FROM announcements WHERE n = ?").run(Number(msg.n));
      return { ok: true };
    // Recent messages from everyone, for word alerts (checked in the admin's browser).
    case "recent": {
      const after = Number(msg.after) || Date.now() - 7 * 86400e3;
      const rows = q("SELECT id, sender, recipient, ts, escrow FROM archive WHERE kind = 'msg' AND ts > ? ORDER BY ts DESC LIMIT 3000").all(after);
      return { messages: rows, keys: senderKeys(rows), watchWords: kvGet("watchWords", []) };
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

const signupMode = () => kvGet("signupMode", "open");

// ---------- backups ----------
//
// Every night (and on request) the whole database is copied, in a consistent
// state, to the backup folder (a different drive), keeping the last 14.

const BACKUP_DIR = config.backupDir || "";
let lastBackup = kvGet("lastBackup", null);

function backupNow() {
  if (!BACKUP_DIR) throw new Error("No backup folder is set (backupDir in config.json).");
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const file = path.join(BACKUP_DIR, `freemessenger-${stamp}.db`);
  try { fs.unlinkSync(file); } catch {}
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^freemessenger-.*\.db$/.test(f)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - 14))) fs.unlinkSync(path.join(BACKUP_DIR, f));
  lastBackup = { ts: Date.now(), file, bytes: fs.statSync(file).size };
  kvSet("lastBackup", lastBackup);
  event(`Backed up the database to ${file}`);
  return lastBackup;
}

setInterval(() => {
  const now = new Date();
  if (!BACKUP_DIR || now.getHours() !== 3) return;
  if (lastBackup && Date.now() - lastBackup.ts < 20 * 3600e3) return;
  try { backupNow(); } catch (e) { event(`Backup failed: ${e.message}`); }
}, 5 * 60e3);

// ---------- announcements ----------

function announcementsSince(n) {
  return q("SELECT n, ts, text FROM announcements WHERE n > ? ORDER BY n LIMIT 20").all(Number(n) || 0);
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
    if (now - (lastPoll.get(name) || 0) > 60e3) q("UPDATE accounts SET lastSeen = ? WHERE username = ?").run(now, name);
    lastPoll.set(name, now);
    const after = msg.after && Number.isFinite(msg.after.ts) && typeof msg.after.id === "string" ? msg.after : { ts: -1, id: "" };
    const rows = q("SELECT env FROM queue WHERE recipient = ? AND (ts > ? OR (ts = ? AND id > ?)) ORDER BY ts, id LIMIT 200")
      .all(name, after.ts, after.ts, after.id);
    const eph = (ephemeral.get(name) || []).filter((m) => now - m.ts < 60e3);
    ephemeral.delete(name);
    return [200, { messages: [...rows.map((r) => JSON.parse(r.env)), ...eph] }];
  }
  if (msg.op === "ack") { ack(name, msg.items); return [200, { ok: true }]; }
  const sess = Object.assign({ unlockedUntil: 0, trusted: null }, httpUnlocks.get(msg.token), { nonce: msg.token });
  const r = await op(user, msg.op, msg, sess);
  if (sess.unlockedUntil) httpUnlocks.set(msg.token, { unlockedUntil: sess.unlockedUntil, trusted: sess.trusted });
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
      const mode = signupMode();
      if (mode === "closed" && !ADMINS.includes(name)) return reply(res, 403, { error: "Sign-ups are closed right now." });
      let invite = null;
      if (mode === "invite" && !ADMINS.includes(name)) {
        invite = q("SELECT * FROM invites WHERE code = ?").get(String(body.invite || "").trim().toUpperCase());
        if (!invite || invite.used >= invite.uses) return reply(res, 403, { error: "That invite code isn't valid.", needInvite: true });
      }
      if (getAccount(name) || kvGet("alias:" + name, null) || (await takenOnBackup(name))) return reply(res, 409, { error: "That username is taken" });
      const status = mode === "approval" && !ADMINS.includes(name) ? "pending" : "ok";
      q("INSERT INTO accounts (username, sigPub, ecdhPub, created, signupIp, lastIp, lastSeen, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(name, JSON.stringify(body.sigPub), JSON.stringify(body.ecdhPub), Date.now(), ip, ip, Date.now(), status);
      if (invite) q("UPDATE invites SET used = used + 1 WHERE code = ?").run(invite.code);
      event(`New account @${name}${status === "pending" ? " (waiting for approval)" : ""}${invite ? ` (invite ${invite.code})` : ""}`);
      syncSoon();
      return reply(res, 200, { ok: true, username: name });
    }

    let m = url.pathname.match(/^\/api\/user\/([a-z0-9_]{3,20})$/);
    if (m && req.method === "GET") {
      const a = (await ensureAccount(m[1])) || getAccount(resolveName(m[1]));
      return a && a.status !== "banned" ? reply(res, 200, pub(a)) : reply(res, 404, { error: "No such user" });
    }

    m = url.pathname.match(/^\/api\/http\/([a-z0-9_]{3,20})$/);
    if (m && req.method === "POST") {
      let msg;
      try { msg = JSON.parse(await readBody(req)); } catch { return reply(res, 400, { error: "bad request" }); }
      const [status, data] = await httpOp(m[1], msg || {}, ip);
      return reply(res, status, data);
    }

    if (url.pathname === "/api/signup") return reply(res, 200, { mode: signupMode() });

    if (url.pathname === "/api/vapid") {
      const v = kvGet("vapid", null);
      return v ? reply(res, 200, { key: v.publicKey }) : reply(res, 503, { error: "not ready" });
    }
    if (url.pathname === "/api/admin-key") {
      const a = ADMINS[0] && (await ensureAccount(ADMINS[0]));
      return reply(res, 200, a && isAdmin(a) ? { ecdhPub: JSON.parse(a.ecdhPub) } : {});
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
  if (a || !BACKUP || kvGet("cfRemoved", []).includes(name) || kvGet("alias:" + name, null)) return a;
  try {
    const r = await fetch(`${BACKUP}/api/user/${name}`, { signal: AbortSignal.timeout(5000) });
    if (r.status !== 200) return null;
    const p = await r.json();
    if (!S.isPublicJwk(p.sigPub) || !S.isPublicJwk(p.ecdhPub) || getAccount(name)) return getAccount(name);
    const pin = pinFor(name);
    if (pin && (p.sigPub.x !== pin.x || p.sigPub.y !== pin.y)) {
      event(`Refused to copy @${name} from the backup relay: its key isn't the pinned admin key`);
      return null;
    }
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
  const sess = { unlockedUntil: 0, trusted: null, nonce: challenge };
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
    if (Date.now() - (sess.touched || 0) > 60e3) { sess.touched = Date.now(); q("UPDATE accounts SET lastSeen = ? WHERE username = ?").run(Date.now(), name); }
    const r = await op(a, msg.type, msg, sess);
    if (r) ws.send(JSON.stringify({ type: "sent", ref: msg.ref, ...r }));
  });
  ws.on("close", () => {
    if (authed) q("UPDATE accounts SET lastSeen = ? WHERE username = ?").run(Date.now(), name);
    const set = sockets.get(name);
    if (set) { set.delete(ws); if (!set.size) sockets.delete(name); }
  });
  ws.on("error", () => {});
}

// ---------- router port forwards for TURN (NAT-PMP) ----------
//
// Asks the home router to forward the TURN ports to this computer, and keeps
// asking every 30 minutes, so the forwards survive restarts of either one.
// Uses NAT-PMP (RFC 6886), which routers offer to devices on their own
// network; no router password is involved.

let forwards = { ok: 0, failed: 0, ts: 0, error: "" };
let turnCheck = null;      // what the backup relay saw when it tried TURN from outside
let lastTurnCheck = 0;

function natpmpMap(gateway, proto, port, lifetime) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    const req = Buffer.alloc(12);
    req[1] = proto === "tcp" ? 2 : 1;
    req.writeUInt16BE(port, 4);
    req.writeUInt16BE(port, 6);
    req.writeUInt32BE(lifetime, 8);
    const done = (r) => { clearTimeout(timer); try { sock.close(); } catch {} resolve(r); };
    const timer = setTimeout(() => done({ ok: false, error: "no reply" }), 2500);
    sock.on("message", (m) => {
      const result = m.length >= 16 ? m.readUInt16BE(2) : -1;
      done(result === 0 && m.readUInt16BE(10) === port ? { ok: true } : { ok: false, error: `result ${result}, got port ${m.length >= 12 ? m.readUInt16BE(10) : "?"}` });
    });
    sock.on("error", (e) => done({ ok: false, error: e.message }));
    sock.send(req, 5351, gateway);
  });
}

async function keepForwards() {
  const t = config.turn;
  if (!t || !config.gateway || config.portForwarding === false) return;
  const list = [["udp", t.port || 3478], ["tcp", t.port || 3478]];
  for (let p = t.minPort || 40000; p <= (t.maxPort || 40040); p++) list.push(["udp", p]);
  let ok = 0;
  let failed = 0;
  let error = "";
  for (const [proto, port] of list) {
    const r = await natpmpMap(config.gateway, proto, port, 3600);
    if (r.ok) ok++; else { failed++; error = `${proto} ${port}: ${r.error}`; }
  }
  const before = forwards;
  forwards = { ok, failed, ts: Date.now(), error };
  if (failed && (!before.failed || !before.ts)) event(`Router port forwarding: ${failed} of ${list.length} failed (${error})`);
  else if (!failed && (before.failed || !before.ts)) event(`Router is forwarding all ${ok} TURN ports to this computer`);
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
      admins: ADMINS.filter((n) => isAdmin(getAccount(n))),
      signupMode: signupMode(),
      oldNames: q("SELECT k FROM kv WHERE k LIKE 'alias:%' LIMIT 5000").all().map((r) => r.k.slice(6)),
      checkTurn: !!(config.turn && publicIp) && Date.now() - lastTurnCheck > 30 * 60e3,
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
    if (out.turnCheck) {
      lastTurnCheck = Date.now();
      const was = turnCheck;
      turnCheck = Object.assign({ ts: Date.now() }, out.turnCheck);
      if (!was || was.ok !== turnCheck.ok) event(turnCheck.ok ? `TURN is reachable from the internet (${turnCheck.ms} ms)` : `TURN is NOT reachable from the internet: ${turnCheck.error}`);
    }
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
    // Someone's old username: never hand it to a new account.
    if (kvGet("alias:" + name, null)) {
      kvSet("cfRemoved", [...new Set([...kvGet("cfRemoved", []), name])]);
      event(`Refused @${name} made on the backup relay: it's someone's old username`);
      return;
    }
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

pinAdmins();
setInterval(pinAdmins, 60e3);
makeSetupCode();
setInterval(makeSetupCode, 60e3);

keepForwards();
setInterval(keepForwards, 30 * 60e3);

server.listen(PORT, "127.0.0.1", async () => {
  log(`FreeMessenger relay on http://127.0.0.1:${PORT}, data in ${DATA}, ${(used / 1024 ** 3).toFixed(2)} GB of ${config.capGB || 100} GB used`);
  await refreshPublicIp();
  startTunnel();
  syncNow();
});
