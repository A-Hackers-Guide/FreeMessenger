import "./compat.js";
import * as E2E from "./crypto.js";
import { uuid, clear, readFileText, openDialog, closeDialog, copyText, AudioCtx, canCall } from "./compat.js";
import { request, createConnection } from "./transport.js";
import { store, files } from "./store.js";
import * as F from "./files.js";
import * as Push from "./push.js";
import * as Relays from "./relays.js";
import * as Look from "./look.js";
import * as Admin from "./admin.js";
import * as Browser from "./browser.js";
import { EMOJI, STICKERS } from "./emoji.js";
import * as GroupCall from "./groupcall.js";
import * as Stories from "./stories.js";
import * as Games from "./games.js";
import * as Extras from "./extras.js";
import * as BigFile from "./bigfile.js";

window.FM_LOADED = true;

const $ = (id) => document.getElementById(id);
const USERNAME = /^[a-z0-9_]{3,20}$/;
const MAX_HISTORY = 2000;
const MAX_GROUP = 256;
const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
const TTL_CHOICES = [[0, "Off"], [3600, "1 hour"], [86400, "1 day"], [604800, "1 week"], [2592000, "30 days"]];
// Invite links always point at the real site, even when FreeMessenger was
// opened through a proxy or a translation page.
const SITE_URL = "https://a-hackers-guide.github.io/FreeMessenger/";

// ---------- what this browser remembers ----------
//
// chats:  id -> { type: "dm" | "group", last, unread, preview, nickname, muted,
//                 blocked, ttl, name, members, left }
//         A direct chat's id is the other person's username; a group's is "g:<id>".
// peers:  username -> their public encryption key

let me = store.get("identity", null);
let chats = store.get("chats", null);
let peers = store.get("peers", {});
let outbox = store.get("outbox", []);
const settings = Object.assign(
  { theme: "system", size: "normal", enterSends: true, readReceipts: true, typing: true, look: {}, hideSeen: false, dnd: null, lockAfter: 60 },
  store.get("settings", {}),
);

if (!chats) {
  // Chats saved by FreeMessenger 0.2 and earlier.
  chats = {};
  const old = store.get("contacts", {});
  for (const name of Object.keys(old)) {
    if (old[name].ecdhPub) peers[name] = old[name].ecdhPub;
    chats[name] = { type: "dm", last: old[name].last || 0, unread: old[name].unread || 0, preview: old[name].preview || "" };
  }
  store.set("chats", chats);
  store.set("peers", peers);
}

// Public profiles (display name, picture, status…), refreshed every 10 minutes.
let profiles = store.get("profiles", {});
const PROFILE_TTL = 10 * 60e3;
// Pictures (up to 300 KB for animated ones) live in IndexedDB and memory,
// not localStorage, which only holds ~5 MB for everything.
const avatarMem = new Map();
function profileOf(name) {
  const e = profiles[name];
  if (!e || !e.p) return {};
  const a = !e.p.avatar && e.p.av && avatarMem.get(name);
  return a ? Object.assign({}, e.p, { avatar: a }) : e.p;
}
function rememberProfile(name, p) {
  p = Object.assign({}, p || {});
  delete p.av;
  if (p.avatar) {
    if (avatarMem.get(name) !== p.avatar) { avatarMem.set(name, p.avatar); files.put("avatar:" + name, p.avatar); }
    delete p.avatar;
    p.av = 1;
  } else if (avatarMem.has(name)) {
    avatarMem.delete(name);
    files.remove("avatar:" + name);
  }
  profiles[name] = { p, at: Date.now() };
  store.set("profiles", profiles);
}
// Loads saved pictures once at start; moves any old in-localStorage ones over.
(async () => {
  let shown = 0;
  for (const [name, e] of Object.entries(profiles)) {
    if (!e || !e.p) continue;
    if (e.p.avatar) { rememberProfile(name, e.p); profiles[name].at = e.at; shown++; continue; }
    if (!e.p.av || avatarMem.has(name)) continue;
    const a = await files.get("avatar:" + name);
    if (typeof a === "string") { avatarMem.set(name, a); shown++; } else e.at = 0;
  }
  store.set("profiles", profiles);
  if (shown && me) try { renderChats(); if (active) renderHeader(); } catch {}
})();
const setFx = (el, fx) => {
  for (const c of [...el.classList]) if (c.slice(0, 3) === "fx-") el.classList.remove(c);
  if (fx) el.classList.add("fx-" + fx);
};
// What the relay says this account may do (admin panel, web viewer).
let flags = store.get("flags", { admin: false, proxy: false, primary: false });

let active = null;
const isGroup = (id) => id.slice(0, 2) === "g:";
// Broadcast lists ("b:<id>") send each message to every person separately.
const isBroadcast = (id) => id.slice(0, 2) === "b:";
const saveChats = () => store.set("chats", chats);
const savePeers = () => store.set("peers", peers);
const saveOutbox = () => store.set("outbox", outbox.slice(-2000));
const loadChat = (id) => store.get("chat." + id, []);
let warnedFull = false;
function saveChat(id, list) {
  if (!store.set("chat." + id, list.slice(-MAX_HISTORY)) && !warnedFull) {
    warnedFull = true;
    toast("This browser's storage is full. Older messages may not be saved.");
  }
}
const findMessage = (id, mid) => loadChat(id).find((m) => m.mid === mid);

function chatTitle(id) {
  if (me && id === me.username) return "⭐ Saved messages";
  const c = chats[id] || {};
  if (isBroadcast(id)) return "📢 " + (c.name || "Broadcast");
  if (isGroup(id)) return c.name || "Group";
  const shown = c.nickname || profileOf(id).display;
  return shown ? `${shown} (@${id})` : "@" + id;
}
const shortName = (name) => (chats[name] && chats[name].nickname) || profileOf(name).display || "@" + name;

// ---------- relay ----------

async function api(path, body) {
  let r;
  try { r = await request(Relays.get() + path, body); } catch { throw new Error("Can't reach the relay. Check your connection."); }
  if (!r.ok) throw Object.assign(new Error(r.data.error || `Relay error ${r.status}`), { status: r.status });
  return r.data;
}

async function getKey(name) {
  if (peers[name]) return peers[name];
  const p = await api(`/api/user/${name}`);
  peers[name] = p.ecdhPub;
  savePeers();
  rememberProfile(name, p.profile);
  return peers[name];
}

// Fetches someone's profile again if it's old; redraws what shows it.
const loadingProfiles = new Set();
function refreshProfile(name, force) {
  if (!USERNAME.test(name) || loadingProfiles.has(name)) return;
  const known = profiles[name];
  if (!force && known && Date.now() - known.at < PROFILE_TTL) return;
  loadingProfiles.add(name);
  api(`/api/user/${name}`).then((p) => {
    rememberProfile(name, p.profile);
    renderChats();
    if (active === name) renderHeader();
  }).catch(() => {}).finally(() => loadingProfiles.delete(name));
}

let conn = null;
let adminKey = store.get("adminKey", null);
let offlineSince = 0;

async function connect() {
  if (conn) conn.close();
  conn = null;
  const relay = await Relays.pick();
  iceServers = null;
  try {
    const k = await api("/api/admin-key");
    adminKey = k && k.ecdhPub ? k : null;
    store.set("adminKey", adminKey);
  } catch {}
  const c = createConnection({
    relay,
    username: me.username,
    sign: (challenge) => E2E.signChallenge(me, challenge),
    store,
    onMessage: handleIncoming,
    onState: (on, mode) => {
      if (conn !== c) return;
      setConnected(on, mode);
      offlineSince = on ? 0 : Date.now();
      if (on) {
        flushOutbox();
        Push.refresh(conn);
        if (flags.primary && c.relay !== Relays.BACKUP) {
          loadAnnouncements();
          syncDevice();
          setTimeout(fetchPendingBig, 3000);
          if (settings.hideSeen) conn.op("privacy", { hideSeen: true });
          refreshPresence();
        }
      }
    },
    onFlags: (f) => {
      flags = f;
      store.set("flags", flags);
      applyFlags();

    },
    onEvent: (ev) => {
      if (ev.type === "announce") showAnnouncements([ev]);
      if (ev.type === "mirror") handleMirror(ev);
      if (ev.type === "admin-request") showAdminRequest(ev);
    },
    onFatal: (message) => toast(message || "This browser's keys don't match your account. Restore your backup file."),
  });
  conn = c;
}

// Moves to the home server when it comes back, and to the backup relay when
// the home server stops answering.
let switching = false;
setInterval(async () => {
  if (!me || !conn || switching) return;
  const stuck = offlineSince && Date.now() - offlineSince > 15e3;
  if (!stuck && Relays.onPrimary()) return;
  switching = true;
  try {
    const before = conn.relay;
    const now = await Relays.pick();
    if (now !== before || stuck) await connect();
  } finally {
    switching = false;
  }
}, 20e3);

// ---------- announcements from the admin ----------

async function loadAnnouncements() {
  if (!conn) return;
  const r = await conn.op("announcements", { after: store.get("annSeen", 0) });
  if (r && r.announcements && r.announcements.length) showAnnouncements(r.announcements);
}

function showAnnouncements(list) {
  const box = $("announce");
  for (const a of list) {
    if (a.n <= store.get("annSeen", 0) || box.querySelector(`[data-n="${a.n}"]`)) continue;
    const item = document.createElement("div");
    item.className = "announce-item";
    item.dataset.n = a.n;
    const title = document.createElement("strong");
    title.textContent = "📢 From the FreeMessenger admin";
    const text = document.createElement("p");
    linkify(text, a.text);
    const ok = document.createElement("button");
    ok.className = "ghost small";
    ok.textContent = "OK";
    ok.onclick = () => {
      store.set("annSeen", Math.max(store.get("annSeen", 0), a.n));
      item.remove();
      box.hidden = !box.children.length;
    };
    item.append(title, text, ok);
    box.appendChild(item);
  }
  box.hidden = !box.children.length;
}

// ---------- reporting a message ----------

async function reportMessage(id, m) {
  const reason = prompt(`Report this message from ${shortName(m.from)} to the admin? Say what's wrong (optional):`, "");
  if (reason === null) return;
  const context = loadChat(id).filter((x) => !x.system && !x.deleted).slice(-15).map((x) => ({
    from: x.mine ? me.username : x.from || id, ts: x.ts, text: x.text || "", file: x.file ? x.file.name : undefined,
  }));
  const r = conn && conn.ready ? await conn.op("report", {
    reported: m.from, reason,
    message: { from: m.from, ts: m.ts, text: m.text || "", file: m.file ? m.file.name : undefined, chat: isGroup(id) ? chatTitle(id) : null },
    context,
  }) : { error: "You're offline." };
  toast(r && r.error ? r.error : "Reported. Thanks — the admin will look at it.");
}

function applyFlags() {
  $("admin-btn").hidden = !flags.admin;
  $("browser-btn").hidden = !flags.proxy;
}

const online = () => !!(conn && conn.ready);
const sendRaw = (to, body, ephemeral, hint, extra) => conn ? conn.send(to, body, ephemeral, hint, extra) : Promise.resolve({ error: "offline" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastBlockedToast = 0;

// Messages people should hear about wake the other person's device; edits,
// receipts, file pieces and typing don't.
const CHAT_KINDS = ["text", "file", "poll", "sticker", "game"];
const pushHint = (p) => (p.silent ? undefined : CHAT_KINDS.indexOf(p.kind) !== -1 || (p.kind === "group" && p.op === "create") ? "msg" : p.kind === "call-offer" || p.kind === "gcall-ring" ? "call" : undefined);

// Every saved message also carries an "admin copy", encrypted for the site
// admin, who can read it in the admin panel (people are told this when they
// sign up). Typing and call setup aren't saved, so they don't get one.
async function sendPayload(to, payload, ephemeral = false, opts = {}) {
  try {
    const body = await E2E.encrypt(me, await getKey(to), payload);
    const extra = {};
    if (opts.at) extra.at = opts.at;
    if (!ephemeral) {
      if (adminKey) extra.escrow = await E2E.encrypt(me, adminKey.ecdhPub, payload);
      const k = payload.kind === "chunk" ? "chunk" : CHAT_KINDS.indexOf(payload.kind) !== -1 ? "msg" : "control";
      extra.meta = { k, fid: payload.fid, i: payload.i, n: payload.n, mid: payload.mid };
    }
    for (let tries = 0; ; tries++) {
      const r = await sendRaw(to, body, ephemeral, pushHint(payload), extra);
      if (r.slow && tries < 20) { await sleep(1100); continue; }
      if (r.blocked && Date.now() - lastBlockedToast > 10e3) { lastBlockedToast = Date.now(); toast(r.error); }
      return r;
    }
  } catch (e) {
    return { error: e.message };
  }
}

// Who a chat's messages go to.
function recipients(id) {
  if (isBroadcast(id)) return ((chats[id] && chats[id].members) || []).filter((n) => n !== me.username);
  if (!isGroup(id)) return [id];
  const c = chats[id];
  return c && !c.left ? (c.members || []).filter((n) => n !== me.username) : [];
}
const withGroup = (id, payload) => (isGroup(id) ? Object.assign({ gid: id.slice(2) }, payload) : payload);

// Small updates (edits, reactions, receipts, group changes) wait in an
// outbox when they can't be sent, and go out on the next connection.
async function sendControl(to, payload) {
  const r = await sendPayload(to, payload);
  if (r.error) {
    outbox.push({ to, payload });
    saveOutbox();
  }
}
const sendControlToChat = (id, payload) => recipients(id).forEach((to) => sendControl(to, withGroup(id, payload)));

const sendEphemeral = (id, payload) => recipients(id).forEach((to) => sendPayload(to, withGroup(id, payload), true));

// ---------- incoming ----------

async function handleIncoming(env) {
  let p;
  try {
    p = await E2E.decrypt(me, await getKey(env.from), env.body);
  } catch {
    if (!env.ephemeral) conn.ack([{ id: env.id, ts: env.ts }]);
    return; // not really from them, or corrupted — drop it
  }
  if (chats[env.from] && chats[env.from].blocked) {
    if (!env.ephemeral) conn.ack([{ id: env.id, ts: env.ts }]);
    return;
  }
  // File pieces are acknowledged only once the whole file is here, so a
  // reload halfway through picks up where it left off.
  if (p.kind === "chunk") return handleChunk(env, p);
  if (!env.ephemeral) conn.ack([{ id: env.id, ts: env.ts }]);

  if (p.kind === "story" || p.kind === "story-view" || p.kind === "story-delete") return Stories.receive(env.from, p, env.ts);
  if (p.kind === "group") return handleGroupEvent(env.from, p, env.ts);
  // Your own message coming back: notes to yourself, or sent from another device.
  if (env.from === me.username) {
    if (CHAT_KINDS.indexOf(p.kind) !== -1) await importHistory([Object.assign({ to: p.gid ? me.username : me.username }, env)], false);
    return;
  }
  const id = p.gid ? "g:" + p.gid : env.from;
  if (p.gid && !acceptFromGroup(id, env.from)) return;
  // Announcement-only groups: only admins' messages count.
  if (p.gid && chats[id] && chats[id].adminsOnly && CHAT_KINDS.indexOf(p.kind) !== -1 && !isGroupAdmin(chats[id], env.from)) return;

  switch (p.kind) {
    case "text":
    case "file":
    case "poll":
    case "sticker":
    case "game":
      return receiveMessage(id, env, p);
    case "vote": {
      const m = findMessage(id, p.mid);
      if (!m || !m.poll) return;
      const votes = Object.assign({}, m.poll.votes);
      const picks = (Array.isArray(p.choices) ? p.choices : []).map(Number).filter((n) => n >= 0 && n < m.poll.options.length);
      if (picks.length) votes[env.from] = m.poll.multi ? picks.slice(0, 10) : picks.slice(0, 1); else delete votes[env.from];
      return patchMessage(id, p.mid, { poll: Object.assign({}, m.poll, { votes }) });
    }
    case "game-move": {
      const m = findMessage(id, p.mid);
      if (!m || !m.game) return;
      const next = Games.move(m.game, env.from, p.cell);
      if (next) patchMessage(id, p.mid, { game: next });
      return;
    }
    case "pin": {
      const c = chats[id];
      if (!c) return;
      c.pinned = p.on ? String(p.mid) : null;
      saveChats();
      if (active === id) renderHeader();
      return systemMessage(id, `${shortName(env.from)} ${p.on ? "pinned" : "unpinned"} a message`, env.ts);
    }
    case "edit": {
      const m = findMessage(id, p.mid);
      if (m && m.from === env.from && !m.deleted) patchMessage(id, p.mid, { text: String(p.text).slice(0, 8000), edited: env.ts });
      return;
    }
    case "delete": {
      const m = findMessage(id, p.mid);
      if (m && m.from === env.from) deleteMessage(id, p.mid, true);
      return;
    }
    case "react": {
      const m = findMessage(id, p.mid);
      if (!m) return;
      const reactions = Object.assign({}, m.reactions);
      if (p.emoji) reactions[env.from] = String(p.emoji).slice(0, 16); else delete reactions[env.from];
      return patchMessage(id, p.mid, { reactions });
    }
    case "receipt":
      return applyReceipt(id, p, env.from);
    case "typing":
      return showTyping(id, env.from, !!p.rec);
    case "ttl":
      return setTtl(id, Number(p.ttl) || 0, env.from);
    case "renamed":
      return handleRenamed(env.from, p);
    default:
      if (typeof p.kind === "string" && p.kind.indexOf("gcall-") === 0 && p.gid) return GroupCall.handle(env.from, p, env.ts);
      if (!p.gid) handleCall(env.from, p, env.ts);
  }
}

function receiveMessage(id, env, p) {
  if (findMessage(id, p.mid)) return;
  ensureChat(id);
  const m = {
    mid: p.mid,
    from: env.from,
    mine: false,
    text: String(p.text || "").slice(0, 8000),
    ts: env.ts,
  };
  if (p.reply && p.reply.mid) m.reply = { mid: String(p.reply.mid), from: String(p.reply.from || ""), text: String(p.reply.text || "").slice(0, 200) };
  if (p.exp) m.exp = Math.min(Number(p.exp), env.ts + 31 * 86400e3);
  Object.assign(m, cleanExtras(p));
  if (p.kind === "file") {
    m.file = {
      fid: String(p.fid), name: String(p.name || "file").slice(0, 200), type: String(p.type || ""),
      size: Number(p.size) || 0, n: Number(p.n) || 1, w: p.w, h: p.h, voice: !!p.voice, duration: p.duration,
      sticker: !!p.sticker && /^image\//.test(String(p.type || "")),
      once: !!p.once && /^image\//.test(String(p.type || "")),
      vnote: !!p.vnote && /^video\//.test(String(p.type || "")),
    };
    const big = BigFile.cleanBig(p.big);
    if (big) {
      m.file.big = big;
      if (m.file.size <= BigFile.INLINE_MAX) setTimeout(() => fetchBig(id, m.mid, false), 300);
    }
    files.get(m.file.fid).then((blob) => { if (blob) patchMessage(id, m.mid, { file: Object.assign({}, m.file, { ready: true }) }); });
  }
  if (m.game) m.game.players = [env.from];
  clearTyping(id, env.from);
  const mentioned = isGroup(id) && m.text && new RegExp("(^|[^a-z0-9_])@" + me.username + "(?![a-z0-9_])", "i").test(m.text);
  const c = ensureChat(id);
  if (c.archived && !c.muted) c.archived = false;
  if (mentioned) c.mentioned = true;
  addMessage(id, m);
  if (!isBroadcast(id)) queueReceipt(id, m.mid, env.from);
  if (m.effect) playEffect(m.effect);
  if (!p.silent) notify(id, isGroup(id) ? `${shortName(env.from)} in ${chatTitle(id)}` : chatTitle(id), previewText(m), mentioned);
}

async function handleChunk(env, p) {
  const id = p.gid ? "g:" + p.gid : env.from;
  const done = F.addChunk(String(p.fid), Number(p.i), Number(p.n), String(p.data), String(p.type || ""), { id: env.id, ts: env.ts });
  if (!done) {
    if (active === id) updateProgress(id, p.fid);
    return;
  }
  await files.put(String(p.fid), done.blob);
  conn.ack(done.envs);
  const m = loadChat(id).find((x) => x.file && x.file.fid === p.fid);
  if (m) patchMessage(id, m.mid, { file: Object.assign({}, m.file, { ready: true }) });
}

// Polls, stickers, link previews and "forwarded", as received. Never trusted
// beyond what's needed to show them.
function cleanExtras(p) {
  const out = {};
  if (p.kind === "poll" && p.poll && typeof p.poll.q === "string" && Array.isArray(p.poll.options)) {
    const options = p.poll.options.map((o) => String(o).slice(0, 100)).filter(Boolean).slice(0, 10);
    if (options.length >= 2) out.poll = { q: p.poll.q.slice(0, 300), options, multi: !!p.poll.multi, votes: {} };
  }
  if (p.kind === "poll" && out.poll && Number.isInteger(p.poll.quiz) && p.poll.quiz >= 0 && p.poll.quiz < out.poll.options.length) {
    out.poll.quiz = p.poll.quiz;
    out.poll.multi = false;
  }
  if (p.kind === "game") {
    const g = Games.clean(p.game);
    if (g) out.game = g;
  }
  if (p.card && typeof p.card.u === "string" && USERNAME.test(p.card.u)) out.card = { u: p.card.u };
  if (p.kind === "sticker" && p.sticker && typeof p.sticker.e === "string") {
    const known = STICKERS.find((x) => x[0] === p.sticker.e);
    if (known) out.sticker = { e: known[0], anim: known[1] };
  }
  const pv = p.preview;
  if (pv && typeof pv.url === "string" && /^https?:\/\//.test(pv.url) && typeof pv.title === "string") {
    out.preview = { url: pv.url.slice(0, 2000), title: pv.title.slice(0, 200), desc: String(pv.desc || "").slice(0, 300), site: String(pv.site || "").slice(0, 100) };
    if (typeof pv.image === "string" && pv.image.length < 90000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(pv.image)) out.preview.image = pv.image;
  }
  if (p.fwd) out.fwd = true;
  if (p.once) out.once = true;
  if (p.silent) out.silent = true;
  if (typeof p.effect === "string" && EFFECTS.some((e) => e[0] === p.effect)) out.effect = p.effect;
  if (p.loc && Number.isFinite(p.loc.lat) && Number.isFinite(p.loc.lon) && Math.abs(p.loc.lat) <= 90 && Math.abs(p.loc.lon) <= 180) {
    out.loc = { lat: Math.round(p.loc.lat * 1e5) / 1e5, lon: Math.round(p.loc.lon * 1e5) / 1e5, acc: Math.min(100000, Math.round(Number(p.loc.acc) || 0)) };
  }
  return out;
}

// ---------- groups ----------

function acceptFromGroup(id, from) {
  const c = chats[id];
  if (!c) {
    // A message that beat the group's invite here: start the group, and the
    // invite fills in the name and members when it arrives.
    chats[id] = { type: "group", name: "Group", members: [me.username, from], last: 0, unread: 0, preview: "", pending: true };
    saveChats();
    return true;
  }
  if (c.left) return false;
  if (c.pending && c.members.indexOf(from) === -1) c.members.push(from);
  return c.members.indexOf(from) !== -1;
}

function cleanMembers(list) {
  const out = [];
  for (const n of Array.isArray(list) ? list : []) {
    const name = String(n).toLowerCase();
    if (USERNAME.test(name) && out.indexOf(name) === -1) out.push(name);
  }
  return out.slice(0, MAX_GROUP);
}

// Groups made before group admins existed treat every member as an admin.
const groupAdmins = (c) => (c && Array.isArray(c.admins) && c.admins.length ? c.admins : (c && c.members) || []);
const isGroupAdmin = (c, name) => groupAdmins(c).indexOf(name) !== -1;

function handleGroupEvent(from, p, ts) {
  const id = "g:" + String(p.gid);
  if (!/^g:[0-9a-f-]{36}$/.test(id)) return;
  const c = chats[id];
  // Someone opened this group's invite link and asks to be added.
  if (p.op === "join-request") {
    if (!c || c.left || !isGroupAdmin(c, me.username) || !c.invite || p.token !== c.invite) return;
    if (c.members.indexOf(from) !== -1) return;
    if (c.members.length >= MAX_GROUP) return;
    updateGroup(id, { members: c.members.concat(from) });
    return systemMessage(id, `${shortName(from)} joined with the invite link`, ts);
  }
  const members = cleanMembers(p.members);
  const name = String(p.name || "Group").slice(0, 60);
  const admins = cleanMembers(p.admins).filter((n) => members.indexOf(n) !== -1);
  if (p.op === "leave") {
    if (!c || c.members.indexOf(from) === -1) return;
    c.members = c.members.filter((n) => n !== from);
    saveChats();
    if (active === id) renderHeader();
    return systemMessage(id, `${shortName(from)} left the group`, ts);
  }
  // Only group admins can change the group.
  if (c && !c.pending && !c.left && !isGroupAdmin(c, from)) return;
  if (members.indexOf(me.username) === -1) {
    if (c && !c.left && c.members.indexOf(me.username) !== -1 && p.op === "update") {
      c.left = true;
      c.members = members;
      saveChats();
      if (active === id) renderHeader();
      systemMessage(id, `${shortName(from)} removed you from the group`, ts);
    }
    return;
  }
  if (c && !c.pending && c.members.indexOf(from) === -1) return;
  const before = c ? c.members : [];
  const wasPending = !c || c.pending;
  const added = members.filter((n) => before.indexOf(n) === -1 && n !== from && n !== me.username);
  const renamed = c && !c.pending && c.name !== name;
  const removed = c && !c.pending ? c.members.filter((n) => members.indexOf(n) === -1 && n !== from) : [];
  chats[id] = Object.assign(c || { last: 0, unread: 0, preview: "" }, { type: "group", name, members, pending: false, left: false });
  if (admins.length) chats[id].admins = admins;
  if (typeof p.desc === "string") chats[id].desc = p.desc.slice(0, 500);
  if (p.photo === null || (typeof p.photo === "string" && p.photo.length < 90000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p.photo))) chats[id].photo = p.photo || undefined;
  const wasAdminsOnly = !!(c && c.adminsOnly);
  chats[id].adminsOnly = !!p.adminsOnly;
  if (c && !c.pending && wasAdminsOnly !== !!p.adminsOnly) systemMessage(id, p.adminsOnly ? `${shortName(from)} made this an announcement group: only admins can send messages` : `${shortName(from)} let everyone send messages again`, ts);
  if (removed.length) systemMessage(id, `${shortName(from)} removed ${removed.map(shortName).join(", ")}`, ts);
  saveChats();
  if (wasPending) systemMessage(id, `${shortName(from)} added you to "${name}"`, ts);
  else {
    if (renamed) systemMessage(id, `${shortName(from)} renamed the group to "${name}"`, ts);
    if (added.length) systemMessage(id, `${shortName(from)} added ${added.map(shortName).join(", ")}`, ts);
  }
  if (active === id) renderHeader();
}

async function createGroup(name, names) {
  const gid = uuid();
  const id = "g:" + gid;
  const members = cleanMembers([me.username].concat(names));
  chats[id] = { type: "group", name, members, admins: [me.username], last: Date.now(), unread: 0, preview: "" };
  saveChats();
  systemMessage(id, `You created "${name}"`);
  sendControlToChat(id, { kind: "group", op: "create", name, members, admins: [me.username] });
  openChat(id);
}

async function updateGroup(id, changes) {
  const c = chats[id];
  const oldMembers = c.members.slice();
  Object.assign(c, changes);
  saveChats();
  const everyone = cleanMembers(oldMembers.concat(c.members)).filter((n) => n !== me.username);
  if (c.admins) c.admins = c.admins.filter((n) => c.members.indexOf(n) !== -1);
  everyone.forEach((to) => sendControl(to, { kind: "group", op: "update", gid: id.slice(2), name: c.name, members: c.members, admins: c.admins, adminsOnly: !!c.adminsOnly, desc: c.desc || "", photo: c.photo || null }));
  renderHeader();
  renderChats();
}

function leaveGroup(id) {
  const c = chats[id];
  sendControlToChat(id, { kind: "group", op: "leave" });
  c.left = true;
  c.members = c.members.filter((n) => n !== me.username);
  saveChats();
  systemMessage(id, "You left the group");
  renderHeader();
}

// ---------- messages ----------

function ensureChat(id) {
  if (!chats[id]) {
    chats[id] = { type: isGroup(id) ? "group" : "dm", last: 0, unread: 0, preview: "" };
    saveChats();
  }
  return chats[id];
}

function previewText(m) {
  if (m.deleted) return "Message deleted";
  if (m.poll) return (m.poll.quiz !== undefined ? "🧠 Quiz: " : "📊 ") + m.poll.q;
  if (m.game) return m.game.type === "ttt" ? "❌⭕ Tic-tac-toe" : "🔴🟡 Connect Four";
  if (m.card) return "👤 Contact: @" + m.card.u;
  if (m.file && m.file.vnote) return "🎥 Video message";
  if (m.loc) return "📍 Location";
  if (m.file && m.file.once) return "📷 View-once photo";
  if (m.sticker) return m.sticker.e + " Sticker";
  if (m.file && m.file.sticker) return "🖼 Sticker";
  if (m.file) {
    const kind = m.file.voice ? "🎤 Voice message" : /^image\//.test(m.file.type) ? "📷 Photo" : /^video\//.test(m.file.type) ? "🎬 Video" : "📎 " + m.file.name;
    return m.text ? kind + ": " + m.text : kind;
  }
  return m.text;
}

function addMessage(id, m) {
  const list = loadChat(id);
  list.push(m);
  saveChat(id, list);
  const c = ensureChat(id);
  c.last = m.ts;
  const who = m.mine ? "You: " : isGroup(id) && m.from ? shortName(m.from) + ": " : "";
  c.preview = m.system ? m.text : who + previewText(m);
  if (!m.mine && !m.system && !(active === id && !document.hidden)) c.unread = (c.unread || 0) + 1;
  saveChats();
  renderChats();
  if (active === id) appendMessage(id, m, true);
  updateTitle();
}

const systemMessage = (id, text, ts) => addMessage(id, { mid: uuid(), system: true, mine: false, text, ts: ts || Date.now() });

function patchMessage(id, mid, patch) {
  const list = loadChat(id);
  const m = list.find((x) => x.mid === mid);
  if (!m) return null;
  Object.assign(m, patch);
  saveChat(id, list);
  if (list[list.length - 1] === m && chats[id]) {
    chats[id].preview = (m.mine ? "You: " : "") + previewText(m);
    saveChats();
    renderChats();
  }
  if (active === id) rerenderMessage(id, m);
  return m;
}

function deleteMessage(id, mid, forEveryone) {
  const list = loadChat(id);
  const i = list.findIndex((x) => x.mid === mid);
  if (i === -1) return;
  const m = list[i];
  if (m.file) files.remove(m.file.fid);
  if (forEveryone) {
    list[i] = { mid: m.mid, from: m.from, mine: m.mine, ts: m.ts, deleted: true, text: "", status: m.status };
  } else {
    list.splice(i, 1);
  }
  saveChat(id, list);
  if (active === id) {
    const el = document.querySelector(`#messages [data-mid="${mid}"]`);
    if (el && forEveryone) el.replaceWith(renderMessage(id, list[i]));
    else if (el) el.remove();
  }
}

const STATUS_RANK = { sending: 0, waiting: 1, sent: 2, delivered: 3, read: 4 };

function setStatus(id, mid, status) {
  const m = findMessage(id, mid);
  if (m && m.mine && (STATUS_RANK[status] || 0) > (STATUS_RANK[m.status] || 0)) patchMessage(id, mid, { status });
}

function newOutgoing(id, fields) {
  const now = Date.now();
  const m = Object.assign({ mid: uuid(), from: me.username, mine: true, text: "", ts: now, status: "sending" }, fields);
  const c = chats[id];
  if (c && c.ttl) m.exp = now + c.ttl * 1000;
  if (draft.mode === "reply") {
    m.reply = { mid: draft.mid, from: draft.from, text: draft.text.slice(0, 200) };
  }
  return m;
}

const LINK = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/i;

let pendingSend = null; // { silent } or { effect } from the send button's menu

function sendText(id, text, extra) {
  const m = newOutgoing(id, Object.assign({ text }, extra));
  if (m.effect) playEffect(m.effect);
  clearDraft();
  const link = text.match(LINK);
  // A preview is fetched by the home server, once, and sent inside the
  // message, so the people receiving it never contact the site.
  if (link && Relays.onPrimary() && conn && conn.ready) {
    m.status = "sending";
    addMessage(id, m);
    Promise.race([conn.op("preview", { url: link[0] }), sleep(5000).then(() => ({}))]).then((r) => {
      if (r && r.preview) {
        m.preview = cleanExtras({ preview: r.preview }).preview;
        patchMessage(id, m.mid, { preview: m.preview });
      }
      deliver(id, m);
    });
    return;
  }
  addMessage(id, m);
  deliver(id, m);
}

function sendSpecial(id, fields) {
  const m = newOutgoing(id, fields);
  clearDraft();
  addMessage(id, m);
  deliver(id, m);
}

async function sendFile(id, file, extra = {}) {
  if (file.size > F.MAX_FILE_BYTES) return sendBigFile(id, file, extra);
  let blob = file;
  let type = file.type || "application/octet-stream";
  let dims = {};
  if (/^image\//.test(type) && !extra.voice && !extra.sticker) {
    // View-once photos are made smaller like any photo.
    const p = await F.preparePhoto(file);
    blob = p.blob;
    type = p.type || type;
    dims = { w: p.w, h: p.h };
  }
  const fid = uuid();
  await files.put(fid, blob);
  const n = Math.max(1, Math.ceil(blob.size / F.CHUNK_BYTES));
  const m = newOutgoing(id, {
    text: extra.caption || "",
    file: Object.assign({ fid, name: file.name || extra.name || "file", type, size: blob.size, n, ready: true }, dims,
      extra.voice ? { voice: true, duration: extra.duration } : {}, extra.sticker ? { sticker: true } : {}, extra.once ? { once: true } : {},
      extra.vnote ? { vnote: true, duration: extra.duration } : {}),
  });
  if (extra.fwd) m.fwd = true;
  clearDraft();
  addMessage(id, m);
  deliver(id, m);
}

const delivering = new Set();

// Sends a message to everyone in its chat who hasn't got it yet.
async function deliver(id, m) {
  if (delivering.has(m.mid)) return;
  delivering.add(m.mid);
  try {
    const to = m.pendingTo || recipients(id);
    const base = { mid: m.mid, text: m.text, reply: m.reply, exp: m.exp, preview: m.preview, fwd: m.fwd || undefined,
      silent: m.silent || undefined, effect: m.effect || undefined, loc: m.loc || undefined, card: m.card || undefined };
    const payload = withGroup(id, m.file
      ? Object.assign(base, { kind: "file", fid: m.file.fid, name: m.file.name, type: m.file.type, size: m.file.size, n: m.file.n,
          w: m.file.w, h: m.file.h, voice: m.file.voice, duration: m.file.duration, sticker: m.file.sticker || undefined, once: m.file.once || undefined, vnote: m.file.vnote || undefined,
          big: m.file.big || undefined })
      : m.poll ? Object.assign(base, { kind: "poll", poll: { q: m.poll.q, options: m.poll.options, multi: m.poll.multi, quiz: m.poll.quiz } })
      : m.game ? Object.assign(base, { kind: "game", game: { type: m.game.type, players: [me.username] } })
      : m.sticker ? Object.assign(base, { kind: "sticker", sticker: { e: m.sticker.e } })
      : Object.assign(base, { kind: "text" }));
    const scheduled = m.at && m.at > Date.now() + 5000 && !m.file;
    let chunks = null;
    if (m.file && !m.file.big) {
      const blob = await files.get(m.file.fid);
      if (!blob) return patchMessage(id, m.mid, { status: "sent", pendingTo: null, failed: true });
      chunks = await F.toChunks(blob);
    }
    const failed = [];
    const sids = [];
    for (const name of to) {
      let r = await sendPayload(name, payload, false, scheduled ? { at: m.at } : {});
      if (r.scheduled) sids.push(r.sid);
      if (!r.error && chunks) {
        for (let i = 0; i < chunks.length && !r.error; i++) {
          r = await sendPayload(name, withGroup(id, { kind: "chunk", fid: m.file.fid, i, n: chunks.length, type: m.file.type, data: chunks[i] }));
          if (active === id && i % 4 === 3) showSendProgress(m.mid, (i + 1) / chunks.length);
        }
      }
      if (r.error) failed.push(name);
    }
    if (scheduled && !failed.length) return patchMessage(id, m.mid, { status: "scheduled", sids: (m.sids || []).concat(sids), pendingTo: null });
    patchMessage(id, m.mid, failed.length
      ? { status: "waiting", pendingTo: failed }
      : { status: m.status === "delivered" || m.status === "read" ? m.status : "sent", pendingTo: null });
  } finally {
    delivering.delete(m.mid);
  }
}

function flushOutbox() {
  const queued = outbox;
  outbox = [];
  saveOutbox();
  queued.forEach((item) => sendControl(item.to, item.payload));
  for (const id of Object.keys(chats)) {
    for (const m of loadChat(id)) if (m.mine && m.status && (m.status === "sending" || m.status === "waiting")) deliver(id, m);
  }
}

const statusLabel = (m) => {
  if (!m.mine || !m.status || m.deleted) return "";
  if (m.status === "scheduled") return m.at > Date.now() ? "⏰ Scheduled for " + new Date(m.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Sent";
  return { sending: "Sending…", waiting: "Will send when you're back online", sent: "Sent", delivered: "Delivered", read: "Read" }[m.status] || "";
};

// ---------- receipts and typing ----------

const pendingReceipts = new Map(); // chat id -> Set of mids
let receiptTimer = null;

function queueReceipt(id, mid, from) {
  const key = isGroup(id) ? id + "|" + from : id;
  if (!pendingReceipts.has(key)) pendingReceipts.set(key, new Set());
  pendingReceipts.get(key).add(mid);
  clearTimeout(receiptTimer);
  receiptTimer = setTimeout(flushReceipts, 800);
}

function flushReceipts() {
  for (const [key, mids] of pendingReceipts) {
    const [id, from] = key.split("|");
    const read = active === id && !document.hidden && settings.readReceipts;
    if (from) sendControl(from, { kind: "receipt", gid: id.slice(2), state: read ? "read" : "delivered", mids: Array.from(mids) });
    else sendControl(id, { kind: "receipt", state: read ? "read" : "delivered", mids: Array.from(mids) });
    if (read) markReadSent(id, mids);
  }
  pendingReceipts.clear();
}

function markReadSent(id, mids) {
  const list = loadChat(id);
  let changed = false;
  for (const m of list) if (mids.has(m.mid) && !m.readSent) { m.readSent = true; changed = true; }
  if (changed) saveChat(id, list);
}

// Tells the other person their messages were read, when this chat is on screen.
function sendReadReceipts(id) {
  if (!settings.readReceipts || document.hidden || isBroadcast(id) || id === me.username) return;
  const unread = loadChat(id).filter((m) => !m.mine && !m.system && !m.readSent && !m.deleted);
  if (!unread.length) return;
  if (isGroup(id)) {
    const bySender = new Map();
    for (const m of unread) if (m.from) bySender.set(m.from, (bySender.get(m.from) || []).concat(m.mid));
    for (const [from, mids] of bySender) sendControl(from, { kind: "receipt", gid: id.slice(2), state: "read", mids: mids.slice(-200) });
  } else {
    sendControl(id, { kind: "receipt", state: "read", mids: unread.map((m) => m.mid).slice(-200) });
  }
  markReadSent(id, new Set(unread.map((m) => m.mid)));
}

function applyReceipt(id, p, from) {
  if (!Array.isArray(p.mids)) return;
  const status = p.state === "read" ? "read" : "delivered";
  const set = new Set(p.mids.slice(0, 500).map(String));
  const list = loadChat(id);
  let changed = false;
  for (const m of list) {
    if (!m.mine || !set.has(m.mid)) continue;
    if (isGroup(id)) {
      // Who has it: "read" or "delivered", per member; the tick shows read once everyone has.
      const by = Object.assign({}, m.readBy);
      if (STATUS_RANK[status] > (STATUS_RANK[by[from]] || 0)) by[from] = status;
      m.readBy = by;
      const others = recipients(id);
      const all = others.length && others.every((n) => by[n] === "read");
      const next = all ? "read" : "delivered";
      if (STATUS_RANK[next] >= (STATUS_RANK[m.status] || 0)) m.status = next;
      changed = true;
    } else if (STATUS_RANK[status] > (STATUS_RANK[m.status] || 0)) { m.status = status; changed = true; }
  }
  if (!changed) return;
  saveChat(id, list);
  if (active === id) for (const m of list) if (set.has(m.mid)) rerenderMessage(id, m);
}

const typing = new Map(); // chat id -> Map(name -> until)
let lastTypingSent = 0;

const recordingVoice = new Set();
function showTyping(id, from, rec) {
  if (!typing.has(id)) typing.set(id, new Map());
  typing.get(id).set(from, Date.now() + 5000);
  if (rec) recordingVoice.add(id + ":" + from); else recordingVoice.delete(id + ":" + from);
  renderTyping();
  setTimeout(renderTyping, 5100);
}

function clearTyping(id, from) {
  if (typing.has(id)) typing.get(id).delete(from);
  renderTyping();
}

function renderTyping() {
  const el = $("peer-typing");
  const now = Date.now();
  const names = [];
  const t = active && typing.get(active);
  if (t) for (const [name, until] of t) if (until > now) names.push(name);
  el.hidden = !names.length;
  const rec = names.some((n) => recordingVoice.has(active + ":" + n));
  const verb = rec ? "recording a voice message…" : "typing…";
  el.textContent = !names.length ? "" : isGroup(active)
    ? `${names.map(shortName).join(", ")} ${names.length > 1 ? "are" : "is"} ${verb}`
    : verb;
  $("safety-btn").hidden = !!names.length || isGroup(active || "");
}

function sendTyping() {
  if (!settings.typing || !active || Date.now() - lastTypingSent < 3000) return;
  lastTypingSent = Date.now();
  sendEphemeral(active, { kind: "typing" });
}

// ---------- disappearing messages ----------

function setTtl(id, ttl, by) {
  const c = ensureChat(id);
  if ((c.ttl || 0) === ttl) return;
  c.ttl = ttl;
  saveChats();
  const label = (TTL_CHOICES.find((x) => x[0] === ttl) || [0, ttl + " seconds"])[1];
  const who = by === me.username ? "You" : shortName(by);
  systemMessage(id, ttl ? `${who} turned on disappearing messages: ${label}` : `${who} turned off disappearing messages`);
  if (by === me.username) sendControlToChat(id, { kind: "ttl", ttl });
}

function sweepExpired() {
  const now = Date.now();
  for (const id of Object.keys(chats)) {
    const list = loadChat(id);
    const keep = list.filter((m) => !m.exp || m.exp > now);
    if (keep.length === list.length) continue;
    list.filter((m) => m.exp && m.exp <= now && m.file).forEach((m) => files.remove(m.file.fid));
    saveChat(id, keep);
    if (active === id) openChat(id, { keepScroll: true });
  }
}
setInterval(sweepExpired, 30000);

// ---------- rendering ----------

const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const dayKey = (ts) => new Date(ts).toDateString();
function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400e3);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

let showArchived = false;
let showLocked = false;
let chatFilter = "all";

function renderChats() {
  const ul = $("contacts");
  clear(ul);
  const all = Object.keys(chats).filter((id) => (chats[id].last || id === active || chats[id].draft) && !!chats[id].locked === showLocked)
    .filter((id) => chatFilter === "all" || (chatFilter === "unread" ? chats[id].unread || chats[id].markedUnread : chatFilter === "groups" ? isGroup(id) || isBroadcast(id) : !isGroup(id) && !isBroadcast(id)));
  const archived = all.filter((id) => chats[id].archived);
  const ids = all.filter((id) => !!chats[id].archived === showArchived)
    .sort((a, b) => (chats[b].pinnedChat ? 1 : 0) - (chats[a].pinnedChat ? 1 : 0) || (chats[b].last || 0) - (chats[a].last || 0));
  if (archived.length || showArchived) {
    const li = document.createElement("li");
    li.className = "archive-row";
    const unread = archived.reduce((n, id) => n + (chats[id].unread || 0), 0);
    li.textContent = showArchived ? "← Back to chats" : `🗄 Archived (${archived.length})${unread ? ` · ${unread} unread` : ""}`;
    li.onclick = (e) => { e.stopPropagation(); showArchived = !showArchived; renderChats(); };
    ul.appendChild(li);
  }
  if (showLocked) {
    const li = document.createElement("li");
    li.className = "archive-row";
    li.textContent = "🔒 Locked chats · tap to hide them again";
    li.onclick = (e) => { e.stopPropagation(); showLocked = false; renderChats(); };
    ul.insertBefore(li, ul.firstChild);
  }
  for (const id of ids) ul.appendChild(chatRow(id));
  $("contacts-empty").hidden = ids.length > 0 || showArchived || showLocked || chatFilter !== "all";
  document.querySelectorAll("#chat-filters button").forEach((b) => b.classList.toggle("on", b.dataset.f === chatFilter));
  Stories.render();
}

function chatRow(id, snippet) {
  const c = chats[id] || {};
  const li = document.createElement("li");
  li.className = id === active ? "active" : "";
  li.dataset.id = id;
  li.innerHTML = `<span class="avatar"></span><span class="meta"><strong></strong><small></small></span><span class="badge"></span>`;
  const title = chatTitle(id);
  const avatar = li.querySelector(".avatar");
  fillAvatar(avatar, id);
  if (!isGroup(id)) refreshProfile(id);
  li.querySelector("strong").textContent = (c.pinnedChat && !snippet ? "📌 " : "") + title + (c.muted ? " 🔕" : "") + (c.blocked ? " (blocked)" : "");
  const small = li.querySelector("small");
  if (!snippet && c.draft && id !== active) {
    small.textContent = "Draft: " + c.draft;
    small.classList.add("draft-preview");
  } else {
    small.textContent = snippet || c.preview || "";
  }
  const badge = li.querySelector(".badge");
  if ((c.unread || c.markedUnread) && !snippet) badge.textContent = (c.mentioned ? "@ " : "") + (c.unread || ""); else badge.remove();
  return li;
}

$("contacts").onclick = $("results").onclick = (e) => {
  const li = e.target.closest("li");
  if (li && li.dataset.id) openChat(li.dataset.id, { highlight: li.dataset.mid });
};

function fillAvatar(el, id) {
  clear(el);
  setFx(el, "");
  const c = chats[id] || {};
  if (isBroadcast(id)) {
    el.classList.add("group");
    el.textContent = "📢";
    return;
  }
  if (isGroup(id)) {
    el.classList.add("group");
    if (c.photo) {
      const img = document.createElement("img");
      img.src = c.photo;
      img.alt = "";
      el.appendChild(img);
    } else el.textContent = (chatTitle(id)[0] || "G").toUpperCase();
    return;
  }
  const p = profileOf(id);
  setFx(el, p.fx);
  if (p.avatar) {
    const img = document.createElement("img");
    img.src = p.avatar;
    img.alt = "";
    el.appendChild(img);
  } else {
    el.textContent = (c.nickname || p.display || id)[0].toUpperCase();
  }
}

// Links in messages open in a new tab; everything else is plain text.
// People with the web viewer also get a button to open them there.
function linkify(el, text) {
  const re = /\b(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/gi;
  let last = 0;
  let match;
  while ((match = re.exec(text))) {
    if (match.index > last) el.appendChild(document.createTextNode(text.slice(last, match.index)));
    const a = document.createElement("a");
    a.href = match[1];
    a.textContent = match[1];
    a.target = "_blank";
    a.rel = "noopener noreferrer nofollow";
    el.appendChild(a);
    if (flags.proxy) {
      const v = document.createElement("button");
      v.className = "view-link";
      v.textContent = "View";
      v.title = "Open in the web viewer";
      const url = match[1];
      v.onclick = (e) => { e.stopPropagation(); Browser.open(url); };
      el.appendChild(v);
    }
    last = match.index + match[1].length;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}

// Built at run time: browsers older than 2020 can't read these patterns, and
// a pattern written in the code would stop the whole app from loading there.
let emojiRe = null;
function emojiOnly(text) {
  if (text.length > 24) return false;
  try {
    emojiRe ||= [new RegExp("^(?:\\p{Extended_Pictographic}|\\p{Emoji_Component}|\\u200d|\\ufe0f|\\s)+$", "u"), new RegExp("\\p{Extended_Pictographic}", "u")];
    return emojiRe[0].test(text) && emojiRe[1].test(text);
  } catch {
    return false;
  }
}

const blobUrls = new Map();
async function blobUrl(fid) {
  if (blobUrls.has(fid)) return blobUrls.get(fid);
  const blob = await files.get(fid);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  blobUrls.set(fid, url);
  return url;
}

function renderFile(id, m, bubble) {
  const f = m.file;
  const box = document.createElement("div");
  box.className = "file";
  bubble.appendChild(box);
  if (f.once) {
    box.classList.add("loading", "once");
    if (m.mine) { box.textContent = "📷 View-once photo"; return; }
    if (m.viewed) { box.textContent = "📷 Opened"; return; }
    if (!f.ready) { box.textContent = "📷 View-once photo — arriving…"; return; }
    box.textContent = "📷 View-once photo — tap to open";
    box.onclick = async (e) => {
      e.stopPropagation();
      const url = await blobUrl(f.fid);
      if (!url) return;
      openViewer(url, f.name, true);
      // Gone after this look, like WhatsApp's "view once".
      setTimeout(() => {
        files.remove(f.fid);
        blobUrls.delete(f.fid);
        patchMessage(id, m.mid, { viewed: true });
      }, 500);
    };
    return;
  }
  if (f.big && !f.ready) {
    box.classList.add("loading", "big-file");
    const label = document.createElement("span");
    const icon = /^image\//.test(f.type) ? "🖼" : /^video\//.test(f.type) ? "🎬" : /^audio\//.test(f.type) ? "🎵" : "📦";
    const state = bigState.get(f.big.bid);
    label.textContent = f.expired ? `${icon} ${f.name} (${F.humanSize(f.size)}) — expired on the server`
      : state ? `${icon} ${f.name} — ${state}`
      : `${icon} ${f.name} (${F.humanSize(f.size)})`;
    box.appendChild(label);
    box.dataset.big = f.big.bid;
    if (!f.expired && !state) {
      const b = document.createElement("button");
      b.className = "ghost small";
      b.textContent = f.size <= BigFile.INLINE_MAX ? "Download" : "Save to device";
      b.onclick = (e) => { e.stopPropagation(); fetchBig(id, m.mid, true); };
      box.appendChild(b);
    }
    return;
  }
  if (f.missing) {
    box.classList.add("loading");
    box.textContent = `${f.voice ? "Voice message" : f.name} — not saved in this browser`;
    return;
  }
  if (!f.ready) {
    const p = m.mine ? null : F.progress(f.fid);
    box.classList.add("loading");
    box.textContent = m.mine ? "Sending…" : `Receiving ${f.voice ? "voice message" : f.name}… ${p ? Math.round(p * 100) + "%" : ""}`;
    box.dataset.progress = f.fid;
    return;
  }
  const isImage = /^image\//.test(f.type);
  const isVideo = /^video\//.test(f.type);
  const isAudio = f.voice || /^audio\//.test(f.type);
  blobUrl(f.fid).then((url) => {
    if (!url) { box.textContent = "This file is no longer saved in this browser."; return; }
    if (isImage) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = f.name;
      img.loading = "lazy";
      if (f.w && f.h) { img.width = f.w; img.height = f.h; }
      img.onclick = (e) => { e.stopPropagation(); openViewer(url, f.name); };
      box.appendChild(img);
    } else if (isVideo && f.vnote) {
      // Round video message: plays silently on a loop; tap for sound.
      const v = document.createElement("video");
      v.src = url;
      v.className = "vnote";
      v.muted = true;
      v.loop = true;
      v.autoplay = true;
      v.setAttribute("playsinline", "");
      v.onclick = (e) => { e.stopPropagation(); v.muted = !v.muted; if (!v.muted) { v.currentTime = 0; v.play(); } };
      box.appendChild(v);
      box.classList.add("vnote-box");
    } else if (isVideo) {
      const v = document.createElement("video");
      v.src = url;
      v.controls = true;
      v.preload = "metadata";
      v.setAttribute("playsinline", "");
      v.onclick = (e) => e.stopPropagation();
      box.appendChild(v);
    } else if (isAudio) {
      const a = document.createElement("audio");
      a.src = url;
      a.controls = true;
      a.preload = "metadata";
      a.onclick = (e) => e.stopPropagation();
      box.appendChild(a);
      if (f.voice) {
        box.classList.add("voice");
        const speed = document.createElement("button");
        speed.className = "speed";
        speed.textContent = "1×";
        speed.onclick = (e) => {
          e.stopPropagation();
          const next = { 1: 1.5, 1.5: 2, 2: 1 }[a.playbackRate] || 1;
          a.playbackRate = next;
          speed.textContent = next + "×";
        };
        box.appendChild(speed);
      }
    } else {
      const a = document.createElement("a");
      a.href = url;
      a.download = f.name;
      a.className = "file-card";
      a.innerHTML = `<span class="file-icon">📎</span><span class="file-meta"><strong></strong><small></small></span>`;
      a.querySelector("strong").textContent = f.name;
      a.querySelector("small").textContent = F.humanSize(f.size) + " · Save";
      a.onclick = (e) => e.stopPropagation();
      box.appendChild(a);
    }
  });
}

function renderMessage(id, m) {
  const li = document.createElement("li");
  li.className = m.system ? "system" : m.mine ? "mine" : "theirs";
  li.dataset.mid = m.mid;
  if (m.system) {
    const b = document.createElement("div");
    b.className = "bubble";
    b.textContent = m.text;
    li.appendChild(b);
    return li;
  }
  if (isGroup(id) && !m.mine && m.from) {
    const who = document.createElement("div");
    who.className = "sender";
    who.textContent = shortName(m.from);
    li.appendChild(who);
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (m.fwd && !m.deleted) {
    const f = document.createElement("div");
    f.className = "fwd";
    f.textContent = "↪ Forwarded";
    bubble.appendChild(f);
  }
  if (m.deleted) {
    bubble.classList.add("deleted");
    bubble.textContent = m.mine ? "You deleted this message" : "This message was deleted";
  } else {
    if (m.reply) {
      const q = document.createElement("div");
      q.className = "quote";
      const who = document.createElement("strong");
      who.textContent = m.reply.from === me.username ? "You" : shortName(m.reply.from);
      q.appendChild(who);
      q.appendChild(document.createTextNode(m.reply.text || "Attachment"));
      q.onclick = (e) => { e.stopPropagation(); jumpTo(m.reply.mid); };
      bubble.appendChild(q);
    }
    if (m.sticker) {
      bubble.classList.add("sticker");
      const e = document.createElement("span");
      e.className = "sticker-emoji anim-" + m.sticker.anim;
      e.textContent = m.sticker.e;
      bubble.appendChild(e);
    }
    if (m.file && m.file.sticker) bubble.classList.add("sticker-img");
    if (m.poll) renderPoll(id, m, bubble);
    if (m.loc) bubble.appendChild(locationCard(m.loc));
    if (m.game) bubble.appendChild(Games.render(m.game, me.username, (n) => (n === me.username ? "You" : shortName(n)), (cell) => playMove(id, m.mid, cell)));
    if (m.card) bubble.appendChild(contactCard(m.card.u));
    if (m.file) renderFile(id, m, bubble);
    if (m.text) {
      const t = document.createElement("div");
      t.className = "text";
      if (!m.file && !m.reply && emojiOnly(m.text)) bubble.classList.add("jumbo");
      formatText(t, m.text);
      bubble.appendChild(t);
    }
    if (m.preview) bubble.appendChild(previewCard(m.preview));
  }
  li.appendChild(bubble);
  const reactions = m.reactions && Object.keys(m.reactions);
  if (reactions && reactions.length && !m.deleted) {
    const row = document.createElement("div");
    row.className = "reaction-row";
    const counts = {};
    for (const who of reactions) (counts[m.reactions[who]] ||= []).push(who);
    for (const emoji of Object.keys(counts)) {
      const chip = document.createElement("button");
      chip.className = "chip" + (counts[emoji].indexOf(me.username) !== -1 ? " mine" : "");
      chip.textContent = counts[emoji].length > 1 ? `${emoji} ${counts[emoji].length}` : emoji;
      chip.title = counts[emoji].map((n) => (n === me.username ? "You" : shortName(n))).join(", ");
      chip.onclick = (e) => { e.stopPropagation(); react(id, m.mid, emoji); };
      row.appendChild(chip);
    }
    li.appendChild(row);
  }
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = (m.starred ? "⭐ " : "") + (m.effect ? "✨ " : "") + (m.silent ? "🔕 " : "") + time(m.ts) + (m.edited && !m.deleted ? " · edited" : "") + (m.exp ? " · ⏱" : "");
  const status = document.createElement("span");
  status.className = "status";
  status.textContent = statusLabel(m) ? " · " + statusLabel(m) : "";
  meta.appendChild(status);
  li.appendChild(meta);
  if (!m.deleted) bubble.onclick = (e) => {
    if (e.target.closest("a, audio, video")) return;
    openMessageMenu(id, m.mid, e);
  };
  return li;
}

function previewCard(pv) {
  const a = document.createElement("a");
  a.className = "link-preview";
  a.href = pv.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer nofollow";
  a.onclick = (e) => e.stopPropagation();
  if (pv.image) {
    const img = document.createElement("img");
    img.src = pv.image;
    img.alt = "";
    a.appendChild(img);
  }
  const box = document.createElement("span");
  const site = document.createElement("small");
  site.textContent = pv.site;
  const title = document.createElement("strong");
  title.textContent = pv.title;
  box.append(site, title);
  if (pv.desc) {
    const d = document.createElement("span");
    d.textContent = pv.desc;
    box.appendChild(d);
  }
  a.appendChild(box);
  return a;
}

function renderPoll(id, m, bubble) {
  const p = m.poll;
  const box = document.createElement("div");
  box.className = "poll";
  const q = document.createElement("strong");
  q.textContent = (p.quiz !== undefined ? "🧠 " : "📊 ") + p.q;
  box.appendChild(q);
  const votes = p.votes || {};
  const voters = Object.keys(votes);
  const mine = votes[me.username] || [];
  const quiz = p.quiz !== undefined;
  const answered = quiz && mine.length > 0;
  const counts = p.options.map((_, i) => voters.filter((v) => votes[v].indexOf(i) !== -1).length);
  const total = voters.length;
  p.options.forEach((opt, i) => {
    const b = document.createElement("button");
    b.className = "poll-option" + (mine.indexOf(i) !== -1 ? " picked" : "") + (answered && i === p.quiz ? " right" : answered && mine.indexOf(i) !== -1 ? " wrong" : "");
    if (answered) b.disabled = true;
    const pct = total ? Math.round((counts[i] / total) * 100) : 0;
    b.style.setProperty("--pct", pct + "%");
    const label = document.createElement("span");
    label.textContent = (mine.indexOf(i) !== -1 ? "✓ " : "") + opt;
    const n = document.createElement("small");
    n.textContent = `${counts[i]}`;
    b.title = voters.filter((v) => votes[v].indexOf(i) !== -1).map((v) => (v === me.username ? "You" : shortName(v))).join(", ");
    b.append(label, n);
    b.onclick = (e) => { e.stopPropagation(); vote(id, m, i); };
    box.appendChild(b);
  });
  const foot = document.createElement("small");
  foot.textContent = `${total} ${total === 1 ? "vote" : "votes"}${p.multi ? " · pick any" : ""}${quiz ? (answered ? (mine[0] === p.quiz ? " · ✅ You got it right!" : " · ❌ Not quite") : " · Quiz: one right answer") : ""}`;
  box.appendChild(foot);
  bubble.appendChild(box);
}

function vote(id, m, i) {
  const c = chats[id];
  if (c && (c.left || c.blocked)) return;
  const fresh = findMessage(id, m.mid);
  if (fresh.poll.quiz !== undefined && (fresh.poll.votes || {})[me.username]) return;
  const votes = Object.assign({}, fresh.poll.votes);
  let mine = (votes[me.username] || []).slice();
  if (fresh.poll.multi) mine = mine.indexOf(i) !== -1 ? mine.filter((x) => x !== i) : mine.concat(i);
  else mine = mine[0] === i ? [] : [i];
  if (mine.length) votes[me.username] = mine; else delete votes[me.username];
  patchMessage(id, m.mid, { poll: Object.assign({}, fresh.poll, { votes }) });
  sendControlToChat(id, { kind: "vote", mid: m.mid, choices: mine });
}

function appendMessage(id, m, scroll) {
  const list = $("messages");
  const key = dayKey(m.ts);
  if (list.dataset.day !== key) {
    list.dataset.day = key;
    const sep = document.createElement("li");
    sep.className = "day";
    sep.textContent = dayLabel(m.ts);
    list.appendChild(sep);
  }
  const li = renderMessage(id, m);
  list.appendChild(li);
  if (scroll) li.scrollIntoView(false);
}

function rerenderMessage(id, m) {
  const el = document.querySelector(`#messages [data-mid="${m.mid}"]`);
  if (el) el.replaceWith(renderMessage(id, m));
}

function updateProgress(id, fid) {
  const box = document.querySelector(`[data-progress="${fid}"]`);
  const p = F.progress(fid);
  if (box && p !== null) box.textContent = box.textContent.replace(/… .*$/, "… " + Math.round(p * 100) + "%");
}

function showSendProgress(mid, p) {
  const el = document.querySelector(`#messages [data-mid="${mid}"] .status`);
  if (el) el.textContent = ` · Sending ${Math.round(p * 100)}%`;
}

function jumpTo(mid) {
  const el = document.querySelector(`#messages [data-mid="${mid}"]`);
  if (!el) return toast("That message isn't saved here anymore.");
  el.scrollIntoView({ block: "center" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1600);
}

function renderHeader() {
  if (!active) return;
  const c = chats[active] || {};
  const group = isGroup(active);
  $("peer-name").textContent = chatTitle(active);
  fillAvatar($("peer-avatar"), active);
  const pinned = c.pinned && findMessage(active, c.pinned);
  $("pinned-bar").hidden = !pinned;
  if (pinned) $("pinned-text").textContent = (pinned.mine ? "You: " : shortName(pinned.from) + ": ") + (previewText(pinned) || "");
  const status = isBroadcast(active) ? `Sends to ${(c.members || []).length} people separately` : group ? (c.desc || "") : active === me.username ? "" : [presenceText(active), profileOf(active).status].filter(Boolean).join(" · ");
  $("peer-status").textContent = status;
  $("peer-status").hidden = !status;
  $("voice-btn").hidden = $("video-btn").hidden = !!c.blocked || (group && !!c.left);
  $("safety-btn").hidden = group;
  $("members-btn").hidden = !group;
  if (group) $("members-btn").textContent = c.left ? "You left this group" : `${(c.members || []).length} members`;
  const readOnly = group && c.adminsOnly && !isGroupAdmin(c, me.username);
  const disabled = (group && c.left) || c.blocked || readOnly;
  $("send-form").classList.toggle("disabled", !!disabled);
  $("send-text").disabled = !!disabled;
  $("send-text").placeholder = c.blocked ? "You blocked this person" : group && c.left ? "You left this group" : readOnly ? "Only admins can send messages" : "Message";
  $("voice-btn").hidden = $("video-btn").hidden ||= active === me.username || isBroadcast(active);
  $("safety-btn").hidden ||= active === me.username || isBroadcast(active);
  renderTyping();
}

function saveComposerDraft() {
  if (!active || !chats[active] || draft.mode === "edit") return;
  const text = $("send-text").value;
  if ((chats[active].draft || "") === text) return;
  chats[active].draft = text || undefined;
  saveChats();
}

function openChat(id, opts = {}) {
  const scrollTop = $("messages").scrollTop;
  if (active !== id) {
    saveComposerDraft();
    clearDraft();
    $("send-text").value = (chats[id] && chats[id].draft) || "";
    composerChanged();
  }
  active = id;
  ensureChat(id);
  chats[id].unread = 0;
  chats[id].markedUnread = false;
  chats[id].mentioned = false;
  saveChats();
  $("empty").hidden = true;
  $("convo").hidden = false;
  renderHeader();
  applyChatLook(id);
  if (!isGroup(id) && !isBroadcast(id) && id !== me.username) { refreshProfile(id); refreshPresence(); }
  const list = $("messages");
  clear(list);
  delete list.dataset.day;
  for (const m of loadChat(id)) appendMessage(id, m, false);
  if (opts.keepScroll) list.scrollTop = scrollTop;
  else if (opts.highlight) jumpTo(opts.highlight);
  else if (list.lastElementChild) list.lastElementChild.scrollIntoView(false);
  document.body.classList.add("in-convo");
  closeSearch();
  renderChats();
  updateTitle();
  sendReadReceipts(id);
  if (!opts.keepScroll && !opts.highlight && window.matchMedia && !window.matchMedia("(pointer: coarse)").matches) $("send-text").focus();
}

function closeChat() {
  saveComposerDraft();
  $("send-text").value = "";
  active = null;
  clearDraft();
  document.body.classList.remove("in-convo");
  $("convo").hidden = true;
  $("empty").hidden = false;
  renderChats();
}

function setConnected(on, mode) {
  $("conn").className = "dot " + (on ? "on" : "off");
  $("conn").title = !on ? "Reconnecting…" : mode === "http" ? "Connected (compatibility mode for this network)" : "Connected";
}

function updateTitle() {
  const n = Object.keys(chats).reduce((s, id) => s + (chats[id].muted ? 0 : chats[id].unread || 0), 0);
  document.title = n ? `(${n}) FreeMessenger` : "FreeMessenger";
  Push.setBadge(n);
}

let toastTimer;
function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 4000);
}

function inDnd() {
  const d = settings.dnd;
  if (!d || !d.on) return false;
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const [a, b] = [d.from, d.to].map((t) => { const [h, m] = String(t || "0:0").split(":").map(Number); return h * 60 + m; });
  return a <= b ? mins >= a && mins < b : mins >= a || mins < b;
}

function notify(id, title, body, mentioned) {
  if (chats[id] && chats[id].muted && !mentioned) return;
  if (inDnd()) return;
  if (document.hidden || active !== id) playTone((chats[id] && chats[id].tone) || settings.tone || "pop");
  if (!document.hidden) return;
  if (chats[id] && chats[id].locked) return Push.showLocal("FreeMessenger", "New message", id);
  Push.showLocal((mentioned ? "@ " : "") + title, String(body).slice(0, 120), id);
}

// ---------- notification sounds (made with WebAudio, no sound files) ----------

const TONES = [["pop", "Pop"], ["chime", "Chime"], ["bloop", "Bloop"], ["bell", "Bell"], ["none", "No sound"]];
let toneCtx = null;
let lastTone = 0;
function playTone(name) {
  if (name === "none" || Date.now() - lastTone < 1500) return;
  lastTone = Date.now();
  try {
    toneCtx ||= new AudioCtx();
    const c = toneCtx;
    const notes = { pop: [[880, 0, 0.08]], chime: [[660, 0, 0.18], [990, 0.12, 0.25]], bloop: [[300, 0, 0.12], [520, 0.08, 0.14]], bell: [[1320, 0, 0.6], [1980, 0, 0.4]] }[name] || [[880, 0, 0.08]];
    for (const [f, start, len] of notes) {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = name === "bell" ? "sine" : "triangle";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, c.currentTime + start);
      g.gain.exponentialRampToValueAtTime(0.18, c.currentTime + start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + len);
      o.connect(g).connect(c.destination);
      o.start(c.currentTime + start);
      o.stop(c.currentTime + start + len + 0.05);
    }
  } catch {}
}

// ---------- message menu: react, reply, copy, edit, delete ----------

let menuFor = null;

function openMessageMenu(id, mid, e) {
  const m = findMessage(id, mid);
  if (!m || m.system) return;
  e.stopPropagation();
  menuFor = { id, mid };
  const menu = $("msg-menu");
  const reacts = $("msg-reactions");
  clear(reacts);
  const mine = m.reactions && m.reactions[me.username];
  for (const emoji of QUICK_REACTIONS) {
    const b = document.createElement("button");
    b.textContent = emoji;
    b.className = emoji === mine ? "picked" : "";
    b.onclick = () => { react(id, mid, emoji); hideMessageMenu(); };
    reacts.appendChild(b);
  }
  const more = document.createElement("button");
  more.textContent = "＋";
  more.title = "Another emoji";
  more.onclick = (ev) => {
    ev.stopPropagation();
    hideMessageMenu();
    toggleEmoji("react", { id, mid });
  };
  reacts.appendChild(more);
  const actions = $("msg-actions");
  clear(actions);
  const add = (label, fn, cls) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = () => { hideMessageMenu(); fn(); };
    actions.appendChild(b);
  };
  const canSend = !(chats[id] && (chats[id].left || chats[id].blocked));
  if (canSend) add("Reply", () => startReply(id, m));
  if (isGroup(id) && !m.mine && m.from) add("Reply privately", () => {
    openChat(m.from);
    ensureChat(m.from);
    startReply(m.from, m);
  });
  if (m.text) add("Copy text", () => copyText(m.text).then(() => toast("Copied.")));
  if (!m.deleted && m.status !== "scheduled") add("Forward", () => openForward(id, m));
  if (m.mine) add("ℹ️ Message info", () => messageInfo(id, m));
  add("⏰ Remind me", () => remindMenu(id, m));
  add(m.starred ? "Unstar" : "⭐ Star", () => { patchMessage(id, mid, { starred: !m.starred }); toast(m.starred ? "Unstarred." : "Starred. Find it in ⋯ → Starred messages."); });
  if (canSend && m.status !== "scheduled") {
    const pinnedHere = chats[id] && chats[id].pinned === mid;
    add(pinnedHere ? "Unpin" : "📌 Pin for everyone", () => {
      chats[id].pinned = pinnedHere ? null : mid;
      saveChats();
      renderHeader();
      sendControlToChat(id, { kind: "pin", mid, on: !pinnedHere });
    });
  }
  if (m.mine && m.status === "scheduled" && m.at > Date.now()) add("Cancel scheduled message", async () => {
    const r = conn && conn.ready ? await conn.op("unschedule", { sids: m.sids || [] }) : { error: "You're offline." };
    if (r.error) return toast(r.error);
    deleteMessage(id, mid, false);
    toast("Scheduled message cancelled.");
  }, "danger-text");
  if (m.file && m.file.ready) add("Save file", () => saveFile(m.file));
  if (m.mine && !m.file && canSend) add("Edit", () => startEdit(id, m));
  if (m.mine && canSend) add("Delete for everyone", () => {
    if (!confirm("Delete this message for everyone in the chat?")) return;
    deleteMessage(id, mid, true);
    sendControlToChat(id, { kind: "delete", mid });
  }, "danger-text");
  if (!m.mine && m.from) add("Report to admin", () => reportMessage(id, m), "danger-text");
  add("Delete for me", () => deleteMessage(id, mid, false), "danger-text");
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  const x = Math.min(Math.max(8, e.clientX - r.width / 2), window.innerWidth - r.width - 8);
  const y = e.clientY + r.height + 12 > window.innerHeight ? Math.max(8, e.clientY - r.height - 8) : e.clientY + 8;
  menu.style.left = x + "px";
  menu.style.top = y + "px";
}

function hideMessageMenu() {
  $("msg-menu").hidden = true;
  menuFor = null;
}

function react(id, mid, emoji) {
  const m = findMessage(id, mid);
  if (!m) return;
  const reactions = Object.assign({}, m.reactions);
  const next = reactions[me.username] === emoji ? "" : emoji;
  if (next) reactions[me.username] = next; else delete reactions[me.username];
  patchMessage(id, mid, { reactions });
  sendControlToChat(id, { kind: "react", mid, emoji: next });
}

async function saveFile(f) {
  const url = await blobUrl(f.fid);
  if (!url) return toast("This file is no longer saved in this browser.");
  const a = document.createElement("a");
  a.href = url;
  a.download = f.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------- composer: replies, edits, files, voice ----------

const draft = { mode: null, mid: null, from: null, text: "" };

function startReply(id, m) {
  Object.assign(draft, { mode: "reply", mid: m.mid, from: m.from || (m.mine ? me.username : id), text: previewText(m) });
  $("draft-title").textContent = "Replying to " + (draft.from === me.username ? "yourself" : shortName(draft.from));
  $("draft-text").textContent = draft.text;
  $("draft-bar").hidden = false;
  $("send-text").focus();
}

function startEdit(id, m) {
  Object.assign(draft, { mode: "edit", mid: m.mid, from: null, text: m.text });
  $("draft-title").textContent = "Editing message";
  $("draft-text").textContent = "";
  $("draft-bar").hidden = false;
  $("send-text").value = m.text;
  composerChanged();
  $("send-text").focus();
}

function clearDraft() {
  if (draft.mode === "edit") $("send-text").value = "";
  Object.assign(draft, { mode: null, mid: null, from: null, text: "" });
  $("draft-bar").hidden = true;
  composerChanged();
}

function submitMessage() {
  const text = $("send-text").value.trim();
  if (!active) return;
  if (draft.mode === "edit") {
    const m = findMessage(active, draft.mid);
    if (m && text && text !== m.text) {
      patchMessage(active, draft.mid, { text: text.slice(0, 8000), edited: Date.now() });
      sendControlToChat(active, { kind: "edit", mid: draft.mid, text: text.slice(0, 8000) });
    }
    $("send-text").value = "";
    clearDraft();
    return;
  }
  if (!text) return;
  $("send-text").value = "";
  if (chats[active]) chats[active].draft = undefined;
  sendText(active, text.slice(0, 8000), pendingSend);
  pendingSend = null;
  composerChanged();
}

function composerChanged() {
  const ta = $("send-text");
  ta.style.height = "";
  // Measured only when it's on screen; a hidden box measures zero.
  if (ta.value && ta.scrollHeight) ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  const empty = !ta.value.trim();
  $("mic-btn").hidden = !empty || draft.mode === "edit" || !F.canRecord();
  $("send-btn").hidden = empty && !$("mic-btn").hidden;
  $("send-btn").textContent = draft.mode === "edit" ? "Save" : "Send";
}

let recording = null;
let recordTimer = null;

async function startVoice() {
  if (!active || recording) return;
  try {
    recording = await F.startRecording();
  } catch {
    return toast(window.isSecureContext === false
      ? "Voice messages only work when the address starts with https://."
      : "Microphone unavailable. Check your browser's permissions.");
  }
  $("record-bar").hidden = false;
  $("send-form").hidden = true;
  const tick = () => {
    const s = Math.floor((Date.now() - recording.started) / 1000);
    $("record-time").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    if (s >= 300) stopVoice(true);
  };
  tick();
  recordTimer = setInterval(() => {
    tick();
    if (settings.typing && active && Date.now() - lastTypingSent > 3000) { lastTypingSent = Date.now(); sendEphemeral(active, { kind: "typing", rec: true }); }
  }, 500);
}

async function stopVoice(send) {
  if (!recording) return;
  const rec = recording;
  recording = null;
  clearInterval(recordTimer);
  $("record-bar").hidden = true;
  $("send-form").hidden = false;
  const result = await rec.stop();
  if (!send || !result || !result.blob.size || !active) return;
  const ext = /mp4/.test(result.type) ? "m4a" : /ogg/.test(result.type) ? "ogg" : "webm";
  const file = new Blob([result.blob], { type: result.type });
  sendFile(active, file, { voice: true, duration: result.duration, name: `voice-message.${ext}` });
}

function sendFiles(list) {
  if (!active || !list || !list.length) return;
  const c = chats[active];
  if (c && (c.left || c.blocked)) return;
  const id = active;
  // One after another, so they arrive in the order they were picked.
  Array.prototype.slice.call(list, 0, 10).reduce((done, f) => done.then(() => sendFile(id, f)), Promise.resolve());
}

// ---------- search ----------

function runSearch() {
  const q = $("search").value.trim().toLowerCase();
  const results = $("results");
  if (!q) return closeSearch();
  $("contacts").hidden = true;
  results.hidden = false;
  clear(results);
  let count = 0;
  for (const id of Object.keys(chats)) {
    if (chatTitle(id).toLowerCase().indexOf(q) !== -1 || id.indexOf(q) !== -1) {
      const li = chatRow(id);
      li.dataset.id = id;
      results.appendChild(li);
      count++;
    }
  }
  for (const id of Object.keys(chats)) {
    for (const m of loadChat(id).slice().reverse()) {
      if (count >= 60) break;
      if (m.deleted || m.system || !m.text || m.text.toLowerCase().indexOf(q) === -1) continue;
      const li = chatRow(id, (m.mine ? "You: " : "") + m.text);
      li.dataset.id = id;
      li.dataset.mid = m.mid;
      results.appendChild(li);
      count++;
    }
  }
  if (!count) {
    const li = document.createElement("li");
    li.className = "none";
    li.textContent = "No matches.";
    results.appendChild(li);
  }
}

function closeSearch() {
  $("results").hidden = true;
  $("contacts").hidden = false;
  if (document.activeElement !== $("search")) $("search").value = "";
}

let chatHits = [];
let chatHit = -1;

function runChatSearch() {
  const q = $("chat-search").value.trim().toLowerCase();
  document.querySelectorAll("#messages .hit").forEach((el) => el.classList.remove("hit"));
  chatHits = [];
  if (q) {
    document.querySelectorAll("#messages li[data-mid]").forEach((li) => {
      const t = li.querySelector(".text");
      if (t && t.textContent.toLowerCase().indexOf(q) !== -1) { li.classList.add("hit"); chatHits.push(li); }
    });
  }
  chatHit = chatHits.length - 1;
  $("chat-search-count").textContent = q ? `${chatHits.length} found` : "";
  if (chatHits.length) chatHits[chatHit].scrollIntoView({ block: "center" });
}

function nextChatHit() {
  if (!chatHits.length) return;
  chatHit = (chatHit - 1 + chatHits.length) % chatHits.length;
  chatHits[chatHit].scrollIntoView({ block: "center" });
}

// ---------- chat menu ----------

function openChatMenu(e) {
  e.stopPropagation();
  const menu = $("chat-menu");
  if (!menu.hidden) { menu.hidden = true; return; }
  showChatMenu(mainChatMenu());
}

function showChatMenu(items) {
  const menu = $("chat-menu");
  clear(menu);
  for (const [label, fn, cls] of items) {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = (ev) => {
      ev.stopPropagation();
      const next = fn();
      if (Array.isArray(next)) showChatMenu(next); else menu.hidden = true;
    };
    menu.appendChild(b);
  }
  menu.hidden = false;
}

function mainChatMenu() {
  const id = active;
  const c = chats[id];
  const group = isGroup(id);
  const items = [];
  if (!group && !isBroadcast(id) && id !== me.username) items.push(["View profile", () => openProfile(id)]);
  if (isBroadcast(id)) items.push(["Edit recipients", () => openGroupDialog(id, "broadcast")]);
  items.push(["Photos, files and links", () => openMedia(id)]);
  items.push(["📅 Jump to a date", () => jumpToDate(id)]);
  items.push([`🔔 Notification sound: ${(TONES.find((t) => t[0] === (c.tone || settings.tone || "pop")) || TONES[0])[1]}`, () => TONES.map(([k, label]) => [((c.tone || settings.tone || "pop") === k ? "✓ " : "") + label, () => { c.tone = k; saveChats(); playTone(k); }])]);
  items.push([c.locked ? "🔓 Unlock this chat" : "🔒 Lock this chat", () => {
    if (!c.locked && !store.get("lock", null)) return toast("Set an app lock PIN first (Settings → App lock).");
    c.locked = !c.locked;
    saveChats();
    if (c.locked) { closeChat(); toast("Locked. Find it in ⋯ → Locked chats."); } else renderChats();
  }]);
  items.push(["Export this chat (text)", () => exportChatText(id)]);
  items.push([c.pinnedChat ? "Unpin chat" : "📌 Pin chat to the top", () => { c.pinnedChat = !c.pinnedChat; saveChats(); renderChats(); }]);
  items.push([c.archived ? "Unarchive chat" : "🗄 Archive chat", () => {
    c.archived = !c.archived;
    saveChats();
    if (c.archived) { closeChat(); toast("Archived. It comes back when someone writes (unless it's muted)."); } else renderChats();
  }]);
  items.push(["Mark as unread", () => { c.markedUnread = true; saveChats(); closeChat(); }]);
  items.push(["Background and animation", () => editChatLook(id)]);
  items.push(["Search in this chat", () => {
    $("chat-search-bar").hidden = false;
    $("chat-search").focus();
  }]);
  if (!(group && c.left) && !c.blocked) {
    const current = (TTL_CHOICES.find((x) => x[0] === (c.ttl || 0)) || [0, "Off"])[1];
    items.push([`Disappearing messages: ${current}`, () => TTL_CHOICES.map(([ttl, label]) =>
      [(ttl === (c.ttl || 0) ? "✓ " : "") + label, () => setTtl(id, ttl, me.username)])]);
  }
  items.push([c.muted ? "Unmute notifications" : "Mute notifications", () => {
    c.muted = !c.muted;
    saveChats();
    renderChats();
    updateTitle();
    toast(c.muted ? "Muted." : "Notifications on for this chat.");
  }]);
  if (group) {
    if (!c.left) items.push([`Members (${c.members.length})`, () => memberMenu(id)]);
    if (!c.left && isGroupAdmin(c, me.username)) {
      items.push(["🖼 Group photo and description", () => editGroupInfo(id)]);
      items.push([c.adminsOnly ? "Let everyone send messages" : "Only admins can send messages", () => {
        updateGroup(id, { adminsOnly: !c.adminsOnly });
        systemMessage(id, c.adminsOnly ? "You made this an announcement group: only admins can send messages" : "Everyone can send messages again");
      }]);
      items.push([c.invite ? "Invite link (copy)" : "Make an invite link", () => groupInviteLink(id, false)]);
      if (c.invite) items.push(["Turn off the invite link", () => { c.invite = null; saveChats(); toast("The old link no longer works."); }]);
    }
    if (!c.left && isGroupAdmin(c, me.username)) {
      items.push(["Rename group", () => {
        const name = prompt("Group name:", c.name);
        if (name && name.trim()) {
          updateGroup(id, { name: name.trim().slice(0, 60) });
          systemMessage(id, `You renamed the group to "${name.trim().slice(0, 60)}"`);
        }
      }]);
      items.push(["Add people", () => openGroupDialog(id)]);
    }
    if (!c.left) items.push(["Leave group", () => { if (confirm(`Leave "${c.name}"?`)) leaveGroup(id); }, "danger-text"]);
  } else {
    items.push(["Rename this chat (only you see it)", () => {
      const nick = prompt(`Nickname for @${id} (only you see it):`, c.nickname || "");
      if (nick === null) return;
      c.nickname = nick.trim().slice(0, 40) || undefined;
      saveChats();
      renderHeader();
      renderChats();
    }]);
    items.push([c.blocked ? "Unblock" : "Block", () => {
      if (!c.blocked && !confirm(`Block @${id}? You won't get their messages or calls.`)) return;
      c.blocked = !c.blocked;
      saveChats();
      renderHeader();
      renderChats();
    }, c.blocked ? "" : "danger-text"]);
  }
  items.push(["Clear chat history", () => {
    if (!confirm("Remove all messages in this chat from this browser?")) return;
    loadChat(id).forEach((m) => m.file && files.remove(m.file.fid));
    saveChat(id, []);
    c.preview = "";
    saveChats();
    openChat(id);
  }, "danger-text"]);
  if (!group || c.left) {
    items.push(["Delete chat", () => {
      if (!confirm("Delete this chat from this browser?")) return;
      loadChat(id).forEach((m) => m.file && files.remove(m.file.fid));
      store.remove("chat." + id);
      delete chats[id];
      saveChats();
      closeChat();
    }, "danger-text"]);
  }
  return items;
}

function memberMenu(id) {
  const c = chats[id];
  const amAdmin = isGroupAdmin(c, me.username);
  return c.members.map((n) => {
    const label = (n === me.username ? "You" : shortName(n)) + (isGroupAdmin(c, n) && c.admins ? " · admin" : "");
    if (!amAdmin || n === me.username) return [label, () => (n === me.username ? null : openContact(n))];
    return [label, () => [
      ["Message " + shortName(n), () => openContact(n)],
      [isGroupAdmin(c, n) && c.admins ? "Remove as admin" : "Make admin", () => {
        const admins = (c.admins || [me.username]).slice();
        const next = admins.indexOf(n) !== -1 ? admins.filter((x) => x !== n) : admins.concat(n);
        updateGroup(id, { admins: next.length ? next : [me.username] });
        systemMessage(id, admins.indexOf(n) !== -1 ? `You removed ${shortName(n)} as admin` : `You made ${shortName(n)} an admin`);
      }],
      ["Remove from group", () => {
        if (!confirm(`Remove ${shortName(n)} from "${c.name}"?`)) return;
        updateGroup(id, { members: c.members.filter((x) => x !== n) });
        systemMessage(id, `You removed ${shortName(n)}`);
      }, "danger-text"],
    ]];
  });
}

async function groupInviteLink(id) {
  const c = chats[id];
  if (!c.invite) {
    c.invite = uuid().replace(/-/g, "").slice(0, 16);
    if (!c.admins) c.admins = [me.username];
    saveChats();
  }
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const link = (local ? location.origin + location.pathname : SITE_URL) + `#join=${id.slice(2)}.${c.invite}.${me.username}`;
  await copyText(link);
  toast("Invite link copied. Anyone who opens it joins when your app is online.");
}

function handleJoinLink(hash) {
  const m = hash.match(/^join=([0-9a-f-]{36})\.([0-9a-f]{16})\.([a-z0-9_]{3,20})$/);
  if (!m) return false;
  const [, gid, token, admin] = m;
  history.replaceState(null, "", location.pathname + location.search);
  const c = chats["g:" + gid];
  if (c && !c.left && c.members.indexOf(me.username) !== -1) { openChat("g:" + gid); return true; }
  if (admin === me.username) return true;
  sendControl(admin, { kind: "group", op: "join-request", gid, token });
  toast(`Asked ${shortName(admin)} to add you. You'll join as soon as their app is online.`);
  return true;
}

// ---------- group dialog ----------

let groupDialogFor = null;

let groupDialogMode = "group";
function openGroupDialog(id, mode) {
  groupDialogMode = mode || (id && isBroadcast(id) ? "broadcast" : "group");
  groupDialogFor = id || null;
  const c = id && chats[id];
  if (groupDialogMode === "broadcast") {
    $("group-dialog-title").textContent = c ? `Recipients of "${c.name}"` : "New broadcast list";
    $("group-name").hidden = $("group-name-label").hidden = !!c;
    $("group-name").value = "";
    $("group-name").placeholder = "Family news";
    $("group-members").value = c ? c.members.map((n) => "@" + n).join(" ") : "";
    $("group-members").placeholder = "@sam @alex";
    $("group-submit").textContent = c ? "Save" : "Create list";
    $("group-error").textContent = "";
    openDialog($("group-dialog"));
    return;
  }
  $("group-name").placeholder = "Weekend plans";
  $("group-dialog-title").textContent = c ? `Add people to "${c.name}"` : "New group";
  $("group-name").hidden = $("group-name-label").hidden = !!c;
  $("group-name").value = "";
  $("group-members").value = "";
  $("group-members").placeholder = c ? "Already in it: " + c.members.map((n) => "@" + n).join(" ") : "@sam @alex";
  $("group-submit").textContent = c ? "Add" : "Create group";
  $("group-error").textContent = "";
  openDialog($("group-dialog"));
  (c ? $("group-members") : $("group-name")).focus();
}

$("group-form").onsubmit = async (e) => {
  e.preventDefault();
  const names = $("group-members").value.toLowerCase().split(/[\s,;]+/).map((n) => n.replace(/^@/, "")).filter(Boolean);
  const err = $("group-error");
  err.textContent = "";
  const bad = names.filter((n) => !USERNAME.test(n));
  if (bad.length) return (err.textContent = `"${bad[0]}" isn't a valid username.`);
  if (groupDialogMode === "broadcast") {
    const list = cleanMembers(names).filter((n) => n !== me.username);
    if (!list.length) return (err.textContent = "Type at least one username.");
    for (const n of list) {
      try { await getKey(n); } catch (ex) { return (err.textContent = ex.status === 404 ? `Nobody is called @${n}.` : ex.message); }
    }
    closeDialog($("group-dialog"));
    const id = groupDialogFor || "b:" + uuid();
    chats[id] = Object.assign(chats[id] || { type: "broadcast", last: Date.now(), unread: 0, preview: "" }, {
      members: list, name: groupDialogFor ? chats[id].name : $("group-name").value.trim().slice(0, 60) || "Broadcast list",
    });
    saveChats();
    if (!groupDialogFor) systemMessage(id, `Messages here go to ${list.length} people separately. They reply to you privately.`);
    return openChat(id);
  }
  const c = groupDialogFor && chats[groupDialogFor];
  const fresh = names.filter((n) => n !== me.username && (!c || c.members.indexOf(n) === -1));
  if (!fresh.length) return (err.textContent = c ? "Type at least one new username." : "Type at least one friend's username.");
  if ((c ? c.members.length : 1) + fresh.length > MAX_GROUP) return (err.textContent = `Groups can have up to ${MAX_GROUP} people.`);
  for (const n of fresh) {
    try { await getKey(n); } catch (ex) { return (err.textContent = ex.status === 404 ? `Nobody is called @${n}.` : ex.message); }
  }
  closeDialog($("group-dialog"));
  if (c) {
    updateGroup(groupDialogFor, { members: c.members.concat(fresh) });
    systemMessage(groupDialogFor, `You added ${fresh.map(shortName).join(", ")}`);
  } else {
    const name = $("group-name").value.trim().slice(0, 60) || fresh.map((n) => "@" + n).join(", ").slice(0, 60);
    createGroup(name, fresh);
  }
};
$("group-cancel").onclick = () => closeDialog($("group-dialog"));
$("members-btn").onclick = () => {
  const c = chats[active];
  if (c && !c.left) openGroupDialog(active);
};

// ---------- calls (WebRTC, browser to browser) ----------

const call = { state: "idle", peer: null, id: null, video: false, pc: null, local: null, offer: null, pendingIce: [], started: 0, timer: null, facing: "user", screen: null };
const earlyIce = new Map();
let iceServers = null;

async function getIceServers() {
  if (!iceServers) {
    try { iceServers = (await api(`/api/ice?u=${me.username}`)).iceServers; } catch { iceServers = [{ urls: "stun:stun.cloudflare.com:3478" }]; }
  }
  return iceServers;
}

async function getMedia(video) {
  if (!canCall()) {
    throw new Error(window.isSecureContext === false
      ? "Calls only work when the address starts with https://. Texting still works here."
      : "This browser can't make calls. Texting still works.");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: video ? { facingMode: call.facing, width: { ideal: 1280 }, height: { ideal: 720 } } : false });
  } catch {
    if (video) {
      toast("Camera unavailable — using voice only.");
      return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
    throw new Error("Microphone unavailable. Check your browser's permissions.");
  }
}

async function makePeerConnection() {
  const pc = new RTCPeerConnection({ iceServers: await getIceServers() });
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    const c = e.candidate.toJSON ? e.candidate.toJSON()
      : { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex };
    sendPayload(call.peer, { kind: "ice", callId: call.id, candidate: c }, true);
  };
  const remote = new MediaStream();
  pc.ontrack = (e) => {
    if (e.streams && e.streams[0]) $("remote-video").srcObject = e.streams[0];
    else { remote.addTrack(e.track); $("remote-video").srcObject = remote; }
  };
  // Older Firefox and Safari only report iceConnectionState.
  const state = () => pc.connectionState ||
    ({ completed: "connected", checking: "connecting" })[pc.iceConnectionState] || pc.iceConnectionState;
  pc.onconnectionstatechange = pc.oniceconnectionstatechange = () => {
    if (pc !== call.pc) return;
    const s = state();
    if (s === "connected") {
      if (call.state === "live") return;
      call.state = "live";
      call.started ||= Date.now();
      clearInterval(call.timer);
      call.timer = setInterval(() => setCallStatus(duration()), 1000);
      setCallStatus(duration());
      showCallControls();
    } else if (s === "disconnected") {
      setCallStatus("Reconnecting…");
    } else if (s === "failed") {
      setCallStatus("Couldn't connect");
      setTimeout(() => endCall(true), 1500);
    }
  };
  call.pc = pc;
  call.local.getTracks().forEach((t) => pc.addTrack(t, call.local));
  $("local-video").srcObject = call.local;
  return pc;
}

async function addIce(candidate) {
  try { await call.pc.addIceCandidate(candidate); } catch {}
}

async function drainIce() {
  const list = [...call.pendingIce, ...(earlyIce.get(call.id) || [])];
  call.pendingIce = [];
  earlyIce.delete(call.id);
  for (const c of list) await addIce(c);
}

async function startCall(peer, video) {
  if (call.state !== "idle") return;
  if (!online()) return toast("You're offline right now.");
  if (!canCall()) return toast(window.isSecureContext === false
    ? "Calls only work when the address starts with https://. Texting still works here."
    : "This browser can't make calls. Texting still works.");
  conn.boost(60000);
  Object.assign(call, { state: "calling", peer, id: uuid(), video, started: 0, pendingIce: [], dir: "out" });
  showCallScreen(`Calling…`);
  try {
    call.local = await getMedia(video);
    const pc = await makePeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const r = await sendPayload(peer, { kind: "call-offer", callId: call.id, video, sdp: offer.sdp }, true);
    if (r.error || !r.delivered) {
      setCallStatus(`${shortName(peer)} isn't online right now`);
      return setTimeout(() => endCall(false, "Call not answered"), 2000);
    }
    startRinging(false);
    setTimeout(() => { if (call.state === "calling" && call.peer === peer) endCall(true, "No answer"); }, 45000);
  } catch (e) {
    toast(e.message);
    endCall(false, "Call failed");
  }
}

async function acceptCall() {
  if (call.state !== "ringing") return;
  call.state = "connecting";
  conn.boost(60000);
  stopRinging();
  setCallStatus("Connecting…");
  $("accept-btn").hidden = true;
  try {
    call.local = await getMedia(call.video);
    const pc = await makePeerConnection();
    await pc.setRemoteDescription({ type: "offer", sdp: call.offer });
    await drainIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await sendPayload(call.peer, { kind: "call-answer", callId: call.id, sdp: answer.sdp }, true);
  } catch (e) {
    toast(e.message);
    endCall(true);
  }
}

async function handleCall(from, p, ts) {
  if (p.kind === "call-offer") {
    if (Date.now() - ts > 60000) return;
    if (call.state !== "idle") return sendPayload(from, { kind: "call-busy", callId: p.callId }, true);
    Object.assign(call, { state: "ringing", peer: from, id: p.callId, video: !!p.video, offer: p.sdp, started: 0, pendingIce: [], dir: "in" });
    conn.boost(60000);
    showCallScreen(p.video ? "Incoming video call" : "Incoming voice call", true);
    startRinging(true);
    if (!(chats[from] && chats[from].muted)) Push.showLocal(`${shortName(from)} is calling`, p.video ? "Video call" : "Voice call", from, true);
    setTimeout(() => { if (call.state === "ringing" && call.id === p.callId) endCall(false, "Missed call"); }, 45000);
    return;
  }
  if (p.callId !== call.id || from !== call.peer) {
    if (p.kind === "ice") {
      if (!earlyIce.has(p.callId)) setTimeout(() => earlyIce.delete(p.callId), 30000);
      earlyIce.set(p.callId, [...(earlyIce.get(p.callId) || []), p.candidate]);
    }
    return;
  }
  if (p.kind === "ice") {
    if (call.pc?.remoteDescription) addIce(p.candidate); else call.pendingIce.push(p.candidate);
  } else if (p.kind === "call-answer" && call.state === "calling") {
    stopRinging();
    call.state = "connecting";
    setCallStatus("Connecting…");
    await call.pc.setRemoteDescription({ type: "answer", sdp: p.sdp });
    await drainIce();
  } else if (p.kind === "call-end") {
    endCall(false, call.state === "ringing" ? "Missed call" : undefined);
  } else if (p.kind === "call-decline") {
    setCallStatus("Declined");
    setTimeout(() => endCall(false, "Call declined"), 1200);
  } else if (p.kind === "call-busy") {
    setCallStatus(`${shortName(from)} is on another call`);
    setTimeout(() => endCall(false, "Call not answered"), 2000);
  }
}

function endCall(tellPeer, note) {
  if (call.state === "idle") return;
  if (tellPeer && call.peer) {
    sendPayload(call.peer, { kind: call.state === "ringing" ? "call-decline" : "call-end", callId: call.id }, true);
  }
  const peer = call.peer;
  if (peer) logCall({
    peer, video: call.video, dir: call.dir, ts: call.started || Date.now(),
    dur: call.started ? Math.round((Date.now() - call.started) / 1000) : 0,
    missed: call.dir === "in" && !call.started && call.state === "ringing" && !tellPeer,
    result: note || (call.started ? "" : call.state === "ringing" && tellPeer ? "Declined" : "Not answered"),
  });
  const label = call.started
    ? `${call.video ? "Video" : "Voice"} call · ${duration()}`
    : note || (call.state === "ringing" ? "Declined call" : "Call ended");
  stopRinging();
  clearInterval(call.timer);
  call.local?.getTracks().forEach((t) => t.stop());
  call.screen?.getTracks().forEach((t) => t.stop());
  call.pc?.close();
  Object.assign(call, { state: "idle", peer: null, id: null, pc: null, local: null, offer: null, pendingIce: [], started: 0, screen: null });
  $("remote-video").srcObject = null;
  $("local-video").srcObject = null;
  $("call").hidden = true;
  Push.closeCallNotice();
  if (peer) systemMessage(peer, "📞 " + label);
}

function duration() {
  const s = Math.floor((Date.now() - call.started) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function showCallScreen(status, incoming = false) {
  $("call").hidden = false;
  $("call").classList.toggle("audio", !call.video);
  $("call-peer").textContent = shortName(call.peer);
  $("call-avatar").textContent = ((chats[call.peer] && chats[call.peer].nickname) || call.peer)[0].toUpperCase();
  $("accept-btn").hidden = !incoming;
  $("hangup-btn").textContent = incoming ? "Decline" : "End";
  $("mute-btn").hidden = $("cam-btn").hidden = incoming;
  $("mute-btn").textContent = "Mute";
  $("cam-btn").textContent = "Camera off";
  $("cam-btn").hidden ||= !call.video;
  $("flip-btn").hidden = $("screen-btn").hidden = true;
  setCallStatus(status);
}

async function showCallControls() {
  $("hangup-btn").textContent = "End";
  $("mute-btn").hidden = false;
  $("cam-btn").hidden = !call.video;
  if (!call.video) return;
  $("screen-btn").hidden = !(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  $("screen-btn").textContent = "Share screen";
  try {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    $("flip-btn").hidden = cams.length < 2;
  } catch {}
}

const setCallStatus = (text) => ($("call-status").textContent = text);

function videoSender() {
  return call.pc && call.pc.getSenders().find((s) => s.track && s.track.kind === "video");
}

async function swapVideo(track) {
  const sender = videoSender();
  if (sender) await sender.replaceTrack(track);
  const shown = new MediaStream([track].concat(call.local.getAudioTracks()));
  $("local-video").srcObject = shown;
}

async function flipCamera() {
  if (!call.local || call.screen) return;
  call.facing = call.facing === "user" ? "environment" : "user";
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: call.facing } });
    const track = s.getVideoTracks()[0];
    call.local.getVideoTracks().forEach((t) => { call.local.removeTrack(t); t.stop(); });
    call.local.addTrack(track);
    await swapVideo(track);
  } catch {
    toast("Couldn't switch cameras.");
  }
}

async function toggleScreen() {
  if (call.screen) {
    call.screen.getTracks().forEach((t) => t.stop());
    call.screen = null;
    const cam = call.local.getVideoTracks()[0];
    if (cam) await swapVideo(cam);
    $("screen-btn").textContent = "Share screen";
    return;
  }
  try {
    call.screen = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const track = call.screen.getVideoTracks()[0];
    track.onended = () => { if (call.screen) toggleScreen(); };
    await swapVideo(track);
    $("screen-btn").textContent = "Stop sharing";
  } catch {
    call.screen = null;
  }
}

// A soft two-tone ring made with WebAudio, so there's no sound file to host.
let ring = null;
function startRinging(incoming) {
  stopRinging();
  try {
    const ctx = new AudioCtx();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(ctx.destination);
    const osc = ctx.createOscillator();
    osc.frequency.value = incoming ? 660 : 440;
    osc.connect(gain);
    osc.start();
    let on = false;
    const id = setInterval(() => {
      on = !on;
      gain.gain.setTargetAtTime(on ? (incoming ? 0.12 : 0.05) : 0, ctx.currentTime, 0.02);
    }, incoming ? 700 : 1500);
    ring = { ctx, id };
  } catch {}
}
function stopRinging() {
  if (!ring) return;
  clearInterval(ring.id);
  ring.ctx.close();
  ring = null;
}

// ---------- photo viewer ----------

function openViewer(url, name, once) {
  $("viewer-img").src = url;
  $("viewer-save").href = url;
  $("viewer-save").download = name || "photo";
  $("viewer-save").hidden = !!once;
  $("viewer").hidden = false;
}
$("viewer-close").onclick = () => ($("viewer").hidden = true);
$("viewer").onclick = (e) => { if (e.target === $("viewer")) $("viewer").hidden = true; };

// ---------- settings ----------

function applySettings() {
  const root = document.documentElement;
  if (settings.theme === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", settings.theme);
  root.setAttribute("data-size", settings.size);
  Look.applyLook(settings.look || {}).then(updateLookPreview);
  if (active) applyChatLook(active);
}

// The little preview in Settings → Look copies the real bars and chat, so a
// change shows up right there even while Settings covers the app.
async function updateLookPreview() {
  const box = $("look-live");
  if (!box) return;
  const copy = (from, to) => {
    if (!from || !to) return;
    const cs = getComputedStyle(from);
    to.style.background = cs.backgroundImage !== "none" ? cs.backgroundImage : cs.backgroundColor;
    to.style.color = cs.color;
  };
  copy(document.querySelector("#sidebar > .bar"), box.querySelector(".ll-bar"));
  copy($("send-form"), box.querySelector(".ll-composer"));
  const look = settings.look || {};
  box.querySelector(".ll-chat").style.background = (await Look.background(look.chat, "ui:chat")) || "var(--bg)";
}

let lookToastTimer = null;
function lookChanged(what) {
  clearTimeout(lookToastTimer);
  lookToastTimer = setTimeout(() => toast(`${what} applied ✓`), 120);
}
applySettings();

// ---------- look: bars, chat backgrounds, animations ----------

function applyChatLook(id) {
  const c = chats[id] || {};
  Look.applyChat(c.look ? Object.assign({ key: id }, c.look) : null, settings.look || {});
}

function editChatLook(id) {
  const c = chats[id];
  const own = c.look || {};
  Look.editStyle({
    title: `Background for ${chatTitle(id)}`,
    style: own.bg,
    key: "ui:chat:" + id,
    withAnim: true,
    anim: own.anim,
    onChange: (bg, anim) => {
      c.look = { bg, anim };
      saveChats();
      Look.forgetPicture("ui:chat:" + id);
      applyChatLook(id);
    },
  });
}

function editBar(slot, label) {
  const look = settings.look || (settings.look = {});
  look.bars = look.bars || {};
  Look.editStyle({
    title: label,
    style: look.bars[slot],
    key: "ui:" + slot,
    withText: true,
    onChange: (style) => {
      look.bars[slot] = style;
      look.preset = "custom";
      Look.forgetPicture("ui:" + slot);
      store.set("settings", settings);
      applySettings();
    },
  });
}

function editDefaultChat() {
  const look = settings.look || (settings.look = {});
  Look.editStyle({
    title: "Background for all chats",
    style: look.chat,
    key: "ui:chat",
    withAnim: "global",
    anim: look.anim || "none",
    onChange: (style, anim) => {
      look.chat = style;
      look.anim = anim === "default" ? "none" : anim;
      look.preset = "custom";
      Look.forgetPicture("ui:chat");
      store.set("settings", settings);
      applySettings();
    },
  });
}

function usePreset(name) {
  const preset = Look.PRESETS[name];
  if (!preset) return;
  lookChanged(`"${preset[0]}" theme`);
  const keep = settings.look || {};
  settings.look = Object.assign(JSON.parse(JSON.stringify(preset[1])), { font: keep.font, bubble: keep.bubble });
  settings.look.preset = name;
  store.set("settings", settings);
  applySettings();
  fillLookControls();
}

function fillLookControls() {
  const sel = $("set-preset");
  if (!sel.options.length) {
    for (const [k, [label]] of Object.entries(Look.PRESETS)) sel.appendChild(new Option(label, k));
    sel.appendChild(new Option("Custom", "custom"));
    const bars = $("set-bars");
    for (const [slot, label] of Look.BARS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ghost small";
      b.textContent = label;
      b.onclick = () => editBar(slot, label);
      bars.appendChild(b);
    }
    const all = document.createElement("button");
    all.type = "button";
    all.className = "ghost small";
    all.textContent = "Background for all chats";
    all.onclick = editDefaultChat;
    bars.appendChild(all);
  }
  if (!$("set-font").options.length) {
    for (const [k, label] of Look.FONTS) $("set-font").appendChild(new Option(label, k));
    for (const [k, label] of Look.BUBBLES) $("set-bubble").appendChild(new Option(label, k));
  }
  const look = settings.look || {};
  $("set-font").value = look.font || "system";
  $("set-bubble").value = look.bubble || "round";
  $("set-mine").value = look.mine || look.accent || "#2f6fed";
  $("set-theirs").value = look.theirs || "#eceef2";
  sel.value = (settings.look && settings.look.preset) || "default";
  $("set-accent").value = (settings.look && settings.look.accent) || "#2f6fed";
}

function setLook(key, value) {
  settings.look = settings.look || {};
  if (value === undefined) delete settings.look[key]; else settings.look[key] = value;
  store.set("settings", settings);
  applySettings();
}
$("set-font").onchange = () => { setLook("font", $("set-font").value); lookChanged("Font"); };
$("set-bubble").onchange = () => { setLook("bubble", $("set-bubble").value); lookChanged("Bubble shape"); };
$("set-mine").oninput = () => setLook("mine", $("set-mine").value);
$("set-theirs").oninput = () => setLook("theirs", $("set-theirs").value);
$("set-colors-reset").onclick = () => { setLook("mine"); setLook("theirs"); fillLookControls(); };
$("set-preset").onchange = () => { if ($("set-preset").value !== "custom") usePreset($("set-preset").value); };
$("set-accent").oninput = () => {
  settings.look = settings.look || {};
  settings.look.accent = $("set-accent").value;
  settings.look.preset = "custom";
  $("set-preset").value = "custom";
  store.set("settings", settings);
  applySettings();
};

// ---------- profiles ----------

let profileFor = null;
let pendingAvatar = undefined;

function openProfile(name) {
  profileFor = name;
  const mine = name === me.username;
  const p = mine ? Object.assign({}, store.get("myProfile", {}), profileOf(name)) : profileOf(name);
  if (!mine) refreshProfile(name, true);
  pendingAvatar = undefined;
  $("profile-title").textContent = mine ? "Your profile" : chatTitle(name);
  $("profile-user").textContent = "@" + name;
  const pic = $("profile-pic");
  clear(pic);
  if (p.avatar) { const img = document.createElement("img"); img.src = p.avatar; img.alt = ""; pic.appendChild(img); }
  else pic.textContent = (p.display || name)[0].toUpperCase();
  setFx(pic, p.fx);
  $("profile-fx").value = p.fx || "";
  $("profile-fx").closest("label").hidden = !mine;
  for (const k of ["display", "real", "status", "bio"]) {
    const input = $("profile-" + k);
    input.value = p[k] || "";
    input.readOnly = !mine;
    input.closest("label").hidden = !mine && !p[k];
  }
  $("profile-pic-btn").hidden = $("profile-pic-remove").hidden = $("profile-save").hidden = !mine;
  $("profile-note").hidden = !mine;
  $("profile-error").textContent = "";
  openDialog($("profile-dialog"));
}

$("profile-pic-btn").onclick = () => $("profile-pic-file").click();
$("profile-pic-file").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const animated = /^image\/(gif|webp)$/.test(file.type);
    if (animated && file.size <= 220 * 1024) {
      // Kept exactly as it is so it still moves.
      pendingAvatar = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error("Couldn't read that file."));
        r.readAsDataURL(file);
      });
    } else if (file.type === "image/gif") {
      throw new Error(`Moving pictures can be up to 220 KB (that one is ${Math.round(file.size / 1024)} KB). Try a shorter or smaller GIF.`);
    } else pendingAvatar = await Look.squareDataUrl(file, 256, 80000);
    const pic = $("profile-pic");
    clear(pic);
    const img = document.createElement("img");
    img.src = pendingAvatar;
    img.alt = "";
    pic.appendChild(img);
  } catch (err) {
    $("profile-error").textContent = err.message;
  }
};
$("profile-fx").onchange = () => setFx($("profile-pic"), $("profile-fx").value);
$("profile-pic-remove").onclick = () => {
  pendingAvatar = null;
  const pic = $("profile-pic");
  clear(pic);
  pic.textContent = me.username[0].toUpperCase();
};
$("profile-close").onclick = () => closeDialog($("profile-dialog"));
$("profile-save").onclick = async () => {
  const old = Object.assign({}, store.get("myProfile", {}), profileOf(me.username));
  const p = {};
  for (const k of ["display", "real", "status", "bio"]) p[k] = $("profile-" + k).value.trim();
  p.fx = $("profile-fx").value || undefined;
  p.avatar = pendingAvatar === undefined ? old.avatar : pendingAvatar || undefined;
  const r = conn && conn.ready ? await conn.op("profile", { profile: p }) : { error: "You're offline. Try again when you're connected." };
  if (r.error) return ($("profile-error").textContent = r.error);
  store.set("myProfile", Object.assign({}, p, { avatar: undefined }));
  rememberProfile(me.username, p);
  if (active) renderHeader();
  renderChats();
  $("me-name").textContent = p.display ? `${p.display}` : "@" + me.username;
  closeDialog($("profile-dialog"));
  toast("Profile saved. Everyone sees it now.");
};

// ---------- your message history from the server ----------

// Puts messages from the server's history into this browser: ones you sent
// from another device, and ones another device received for you.
async function importHistory(all, quiet) {
  let added = 0;
  const touched = new Set();
  for (const env of all) {
    const mine = env.from === me.username;
    let p;
    try { p = await E2E.decrypt(me, await getKey(mine ? env.to : env.from), env.body); } catch { continue; }
    if (p.kind === "group") {
      if (!mine) handleGroupEvent(env.from, p, env.ts);
      else if (p.op !== "leave" && p.op !== "join-request" && p.gid && !chats["g:" + p.gid]) {
        chats["g:" + p.gid] = { type: "group", name: String(p.name || "Group").slice(0, 60), members: cleanMembers(p.members), admins: cleanMembers(p.admins), last: env.ts, unread: 0, preview: "" };
        saveChats();
      }
      continue;
    }
    if (mine && (p.kind === "edit" || p.kind === "delete")) {
      const id = p.gid ? "g:" + p.gid : env.to;
      const m = findMessage(id, p.mid);
      if (m && m.mine) p.kind === "edit" ? patchMessage(id, p.mid, { text: String(p.text).slice(0, 8000), edited: env.ts }) : deleteMessage(id, p.mid, true);
      continue;
    }
    if (CHAT_KINDS.indexOf(p.kind) === -1) continue;
    const id = p.gid ? "g:" + p.gid : mine ? env.to : env.from;
    if (findMessage(id, p.mid)) continue;
    ensureChat(id);
    const list = loadChat(id);
    const m = Object.assign({ mid: p.mid, from: env.from, mine, text: String(p.text || "").slice(0, 8000), ts: env.ts }, cleanExtras(p));
    if (mine) m.status = "sent";
    if (p.kind === "file") {
      const big = BigFile.cleanBig(p.big);
      m.file = { fid: String(p.fid), name: String(p.name || "file").slice(0, 200), type: String(p.type || ""), size: Number(p.size) || 0, n: Number(p.n) || 1, voice: !!p.voice, missing: !big };
      if (big) m.file.big = big;
    }
    list.push(m);
    list.sort((a, b) => a.ts - b.ts);
    saveChat(id, list);
    const c = chats[id];
    if (env.ts >= (c.last || 0)) { c.last = env.ts; c.preview = (mine ? "You: " : "") + previewText(m); }
    if (quiet && !mine && active !== id) c.unread = (c.unread || 0) + 1;
    touched.add(id);
    added++;
  }
  saveChats();
  renderChats();
  updateTitle();
  if (active && touched.has(active)) openChat(active, { keepScroll: true });
  return added;
}

async function downloadHistory() {
  if (!conn || !conn.ready) return toast("You're offline. Try again when you're connected.");
  if (!Relays.onPrimary()) return toast("History is kept on the home server, which isn't on right now.");
  const btn = $("history-btn");
  btn.disabled = true;
  const all = [];
  try {
    let before;
    for (;;) {
      btn.textContent = `Downloading… ${all.length}`;
      const r = await conn.op("history", { before });
      if (r.error) throw new Error(r.error);
      all.push(...r.messages);
      if (r.done || !r.messages.length) break;
      before = r.messages[r.messages.length - 1].ts;
    }
    all.sort((a, b) => a.ts - b.ts);
    const added = await importHistory(all, false);
    toast(added ? `Added ${added} messages from the server.` : "Everything was already here.");
  } catch (e) {
    toast(e.message || "Couldn't download your history.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Download";
  }
}

// Keeps this device in step with your others: each time it connects to the
// home server it fetches what happened since it last looked.
let syncingDevice = false;
async function syncDevice() {
  if (syncingDevice || !conn || !conn.ready || !Relays.onPrimary()) return;
  syncingDevice = true;
  try {
    let after = store.get("syncedTo", 0);
    if (!after) { store.set("syncedTo", Date.now()); return; }
    for (let i = 0; i < 20; i++) {
      const r = await conn.op("history", { after });
      if (!r || r.error || !r.messages) break;
      if (r.messages.length) {
        await importHistory(r.messages, true);
        after = r.messages[r.messages.length - 1].ts;
        store.set("syncedTo", after);
      }
      if (r.done) break;
    }
  } finally {
    syncingDevice = false;
  }
}

// Something you just sent from another device.
async function handleMirror(env) {
  if (!env || env.from !== me.username) return;
  store.set("syncedTo", Math.max(store.get("syncedTo", 0), env.ts));
  await importHistory([env], false);
}

// ---------- changing your username ----------

async function changeUsername() {
  if (!conn || !conn.ready || !Relays.onPrimary()) return toast("Changing your username needs the home server, which isn't reachable right now.");
  const name = (prompt("New username (3-20 characters: a-z, 0-9 and _). You can change it once a month, and your old name keeps working as a link to you.", "") || "").trim().toLowerCase().replace(/^@/, "");
  if (!name) return;
  const r = await conn.op("rename", { name });
  if (r.error) return toast(r.error);
  const old = me.username;
  me.username = r.username;
  store.set("identity", me);
  store.set("backedUp", false);
  // Tell everyone you talk to, so their chats move to the new name.
  const people = new Set();
  for (const id of Object.keys(chats)) recipients(id).forEach((n) => people.add(n));
  people.forEach((to) => sendControl(to, { kind: "renamed", old, name: r.username }));
  for (const id of Object.keys(chats)) {
    if (isGroup(id) && chats[id].members) chats[id].members = chats[id].members.map((n) => (n === old ? r.username : n));
    if (isGroup(id) && chats[id].admins) chats[id].admins = chats[id].admins.map((n) => (n === old ? r.username : n));
  }
  saveChats();
  $("me-name").textContent = profileOf(old).display || "@" + r.username;
  $("backup-banner").hidden = false;
  toast(`You're @${r.username} now. Download a new backup file.`);
  closeDialog($("settings-dialog"));
  connect();
}

// Someone you talk to changed their username: move their chat over, once the
// server confirms the old name now points at the new one.
async function handleRenamed(from, p) {
  const old = String(p.old || "").toLowerCase();
  if (!USERNAME.test(old) || old === from) return;
  try {
    const r = await api(`/api/user/${old}`);
    if (r.username !== from) return;
  } catch { return; }
  if (chats[old] && !chats[from]) {
    chats[from] = chats[old];
    delete chats[old];
    saveChat(from, loadChat(old).map((m) => (m.from === old ? Object.assign(m, { from }) : m)));
    store.remove("chat." + old);
    if (active === old) active = from;
  }
  if (peers[old]) { peers[from] = peers[old]; delete peers[old]; savePeers(); }
  for (const id of Object.keys(chats)) {
    const c = chats[id];
    if (!isGroup(id)) continue;
    if (c.members) c.members = c.members.map((n) => (n === old ? from : n));
    if (c.admins) c.admins = c.admins.map((n) => (n === old ? from : n));
  }
  saveChats();
  renderChats();
  if (chats[from]) systemMessage(from, `@${old} is now @${from}`);
  if (active === from) openChat(from);
}

// ---------- call history ----------

function logCall(entry) {
  const list = store.get("callLog", []);
  list.push(entry);
  store.set("callLog", list.slice(-300));
}

function showCalls() {
  const results = $("results");
  $("contacts").hidden = true;
  results.hidden = false;
  clear(results);
  const back = document.createElement("li");
  back.className = "none";
  const b = document.createElement("button");
  b.className = "link";
  b.textContent = "Back to chats";
  b.onclick = (e) => { e.stopPropagation(); closeSearch(); };
  back.appendChild(b);
  results.appendChild(back);
  const list = store.get("callLog", []).slice().reverse();
  if (!list.length) {
    const li = document.createElement("li");
    li.className = "none";
    li.textContent = "No calls yet.";
    results.appendChild(li);
  }
  for (const c of list) {
    const id = c.group || c.peer;
    if (!id) continue;
    const icon = c.missed ? "↙️ Missed" : c.dir === "in" ? "↙️" : "↗️";
    const what = `${icon} ${c.video ? "Video" : "Voice"}${c.group ? " group" : ""} call · ${new Date(c.ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}${c.dur ? ` · ${Math.floor(c.dur / 60)}:${String(c.dur % 60).padStart(2, "0")}` : c.result && !c.missed ? " · " + c.result : ""}`;
    const li = chatRow(id, what);
    li.dataset.id = id;
    if (c.missed) li.classList.add("missed");
    const again = document.createElement("button");
    again.className = "icon";
    again.title = "Call back";
    again.textContent = c.video ? "🎥" : "📞";
    again.onclick = (e) => {
      e.stopPropagation();
      if (c.group) GroupCall.start(c.group, !!c.video); else startCall(c.peer, !!c.video);
    };
    li.appendChild(again);
    results.appendChild(li);
  }
}

function openSettings() {
  $("set-theme").value = settings.theme;
  $("set-size").value = settings.size;
  $("set-enter").checked = settings.enterSends;
  $("set-receipts").checked = settings.readReceipts;
  $("set-typing").checked = settings.typing;
  $("notify-btn").textContent = Push.status();
  fillLookControls();
  fillPrivacyControls();
  openDialog($("settings-dialog"));
  updateLookPreview();
}

function saveSettings() {
  settings.theme = $("set-theme").value;
  settings.size = $("set-size").value;
  settings.enterSends = $("set-enter").checked;
  settings.readReceipts = $("set-receipts").checked;
  settings.typing = $("set-typing").checked;
  store.set("settings", settings);
  applySettings();
}
["set-theme", "set-size", "set-enter", "set-receipts", "set-typing"].forEach((id) => ($(id).onchange = saveSettings));
$("settings-close").onclick = () => closeDialog($("settings-dialog"));

function exportChats() {
  const out = { freemessengerChats: 1, username: me.username, exported: new Date().toISOString(), chats: {} };
  for (const id of Object.keys(chats)) {
    out.chats[id] = {
      title: chatTitle(id),
      members: chats[id].members,
      messages: loadChat(id).filter((m) => !m.deleted).map((m) => ({
        from: m.system ? "system" : m.mine ? me.username : m.from || id,
        time: new Date(m.ts).toISOString(),
        text: m.text,
        file: m.file ? m.file.name : undefined,
      })),
    };
  }
  download(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }), `freemessenger-${me.username}-chats.json`);
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- account ----------

function downloadBackup() {
  download(new Blob([JSON.stringify(Object.assign({ freemessenger: 1 }, me), null, 2)], { type: "application/json" }),
    `freemessenger-${me.username}-backup.json`);
  store.set("backedUp", true);
  $("backup-banner").hidden = true;
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await readFileText(file));
    if (!data.freemessenger || !USERNAME.test(data.username) || !data.sigPriv || !data.ecdhPriv) throw new Error();
    const profile = await api(`/api/user/${data.username}`);
    if (profile.sigPub.x !== data.sigPub.x || profile.sigPub.y !== data.sigPub.y) throw new Error();
    const { freemessenger, ...identity } = data;
    identity.username = profile.username || identity.username;
    me = identity;
    store.set("identity", me);
    store.set("backedUp", true);
    start();
  } catch {
    $("signup-error").textContent = "That doesn't look like a valid FreeMessenger backup.";
  }
}

// ---------- wiring ----------

function start() {
  $("welcome").hidden = true;
  $("app").hidden = false;
  const mine = Object.assign({}, store.get("myProfile", {}), profileOf(me.username));
  $("me-name").textContent = mine.display || "@" + me.username;
  applyFlags();
  refreshProfile(me.username, true);
  Admin.init({ conn: () => conn, me: () => me, toast });
  Stories.init({
    me: () => me.username,
    contacts: () => Object.keys(chats).filter((id) => USERNAME.test(id) && id !== me.username && !chats[id].blocked),
    send: (to, payload) => sendControl(to, payload),
    reply: (to, text) => { ensureChat(to); sendText(to, text); },
    name: shortName,
    avatar: (el, u) => fillAvatar(el, u),
    toast,
    shrink: (f) => Look.squareDataUrl(f, 720, 150000).catch(() => { throw new Error("That photo is too big. Try another."); }),
  });
  Stories.render();
  GroupCall.init({
    me: () => me.username,
    send: (to, payload) => sendPayload(to, payload, true),
    members: (gid) => recipients("g:" + gid),
    title: (gid) => chatTitle("g:" + gid),
    name: shortName,
    ice: getIceServers,
    media: getMedia,
    toast,
    log: logCall,
    ring: (on) => (on ? startRinging(true) : stopRinging()),
  });
  Browser.init({ conn: () => conn, toast });
  if (!store.get("privacyNotice4", false)) openDialog($("privacy-dialog"));
  lockNow();
  $("backup-banner").hidden = store.get("backedUp", false);
  renderChats();
  updateTitle();
  sweepExpired();
  composerChanged();
  connect();
  Push.init({ username: me.username, onOpenChat: (id) => chats[id] && openChat(id) });
  const hash = location.hash.slice(1).toLowerCase();
  const action = new URLSearchParams(location.search).get("action");
  if (action) {
    history.replaceState(null, "", location.pathname + location.hash);
    if (action === "saved") { ensureChat(me.username); openChat(me.username); }
    else if (action === "group") openGroupDialog(null);
    else if (action === "calls") showCalls();
  }
  if (handleJoinLink(hash)) return;
  if (USERNAME.test(hash) && hash !== me.username) openContact(hash);
}

async function openContact(name) {
  $("add-error").textContent = "";
  if (!USERNAME.test(name)) return ($("add-error").textContent = "Usernames are 3-20 characters: a-z, 0-9 and _");
  if (name === me.username) return ($("add-error").textContent = "That's you!");
  try {
    await getKey(name);
    ensureChat(name);
    openChat(name);
    $("add-name").value = "";
  } catch (e) {
    $("add-error").textContent = e.status === 404 ? `Nobody is called @${name} yet.` : e.message;
  }
}

$("signup-form").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("signup-name").value.trim().toLowerCase().replace(/^@/, "");
  $("signup-error").textContent = "";
  if (!USERNAME.test(name)) return ($("signup-error").textContent = "Usernames are 3-20 characters: a-z, 0-9 and _");
  const btn = e.submitter || $("signup-form").querySelector("button");
  btn.disabled = true;
  try {
    const identity = await E2E.createIdentity(name);
    await Relays.pick();
    await api("/api/register", { username: name, sigPub: identity.sigPub, ecdhPub: identity.ecdhPub, invite: $("signup-invite").value.trim() });
    me = identity;
    store.set("identity", me);
    store.set("privacyNotice4", true);
    start();
  } catch (err) {
    $("signup-error").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
};

$("import-btn").onclick = () => $("import-file").click();
$("import-file").onchange = (e) => e.target.files[0] && importBackup(e.target.files[0]);

$("add-form").onsubmit = (e) => {
  e.preventDefault();
  openContact($("add-name").value.trim().toLowerCase().replace(/^@/, ""));
};

$("send-form").onsubmit = (e) => {
  e.preventDefault();
  submitMessage();
};
$("send-text").onkeydown = (e) => {
  if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
    const send = settings.enterSends ? !e.shiftKey : e.ctrlKey || e.metaKey;
    if (send) {
      e.preventDefault();
      submitMessage();
    }
  } else if (e.key === "Escape" && draft.mode) {
    clearDraft();
  } else if (e.key === "ArrowUp" && !$("send-text").value && active) {
    const last = loadChat(active).slice().reverse().find((m) => m.mine && !m.file && !m.deleted && !m.system);
    if (last) { e.preventDefault(); startEdit(active, last); }
  }
};
$("send-text").oninput = () => {
  composerChanged();
  if ($("send-text").value.trim() && draft.mode !== "edit") sendTyping();
};
$("send-text").addEventListener("paste", (e) => {
  const list = e.clipboardData && e.clipboardData.files;
  if (list && list.length) { e.preventDefault(); sendFiles(list); }
});
$("chat").addEventListener("dragover", (e) => { if (active) { e.preventDefault(); $("chat").classList.add("dropping"); } });
$("chat").addEventListener("dragleave", () => $("chat").classList.remove("dropping"));
$("chat").addEventListener("drop", (e) => {
  $("chat").classList.remove("dropping");
  if (!active || !e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  sendFiles(e.dataTransfer.files);
});

$("attach-btn").onclick = (e) => { e.stopPropagation(); $("attach-menu").hidden = !$("attach-menu").hidden; };
$("attach-file-btn").onclick = () => $("attach-file").click();
$("attach-poll-btn").onclick = () => openPollDialog();
$("attach-schedule-btn").onclick = () => openSchedule();
$("emoji-btn").onclick = (e) => { e.stopPropagation(); toggleEmoji(); };
$("pinned-bar").onclick = () => active && chats[active].pinned && jumpTo(chats[active].pinned);
$("starred-btn").onclick = showStarred;
$("attach-file").onchange = (e) => { sendFiles(e.target.files); e.target.value = ""; };
$("mic-btn").onclick = startVoice;
$("record-cancel").onclick = () => stopVoice(false);
$("record-send").onclick = () => stopVoice(true);
$("draft-cancel").onclick = clearDraft;

$("search").oninput = runSearch;
$("search").onkeydown = (e) => { if (e.key === "Escape") { $("search").value = ""; closeSearch(); } };
$("chat-search").oninput = runChatSearch;
$("chat-search").onkeydown = (e) => {
  if (e.key === "Enter") { e.preventDefault(); nextChatHit(); }
  if (e.key === "Escape") $("chat-search-close").click();
};
$("chat-search-close").onclick = () => {
  $("chat-search").value = "";
  runChatSearch();
  $("chat-search-bar").hidden = true;
};

$("back-btn").onclick = closeChat;
$("voice-btn").onclick = () => active && (isGroup(active) ? GroupCall.start(active.slice(2), false) : startCall(active, false));
$("video-btn").onclick = () => active && (isGroup(active) ? GroupCall.start(active.slice(2), true) : startCall(active, true));
$("calls-btn").onclick = showCalls;
$("rename-btn").onclick = changeUsername;
$("accept-btn").onclick = acceptCall;
$("hangup-btn").onclick = () => endCall(true);
$("mute-btn").onclick = () => {
  const tracks = call.local?.getAudioTracks() || [];
  const muted = tracks.some((t) => t.enabled);
  tracks.forEach((t) => (t.enabled = !muted));
  $("mute-btn").textContent = muted ? "Unmute" : "Mute";
};
$("cam-btn").onclick = () => {
  const tracks = call.local?.getVideoTracks() || [];
  const off = tracks.some((t) => t.enabled);
  tracks.forEach((t) => (t.enabled = !off));
  $("cam-btn").textContent = off ? "Camera on" : "Camera off";
};
$("flip-btn").onclick = flipCamera;
$("screen-btn").onclick = toggleScreen;

$("safety-btn").onclick = async () => {
  if (!active || isGroup(active)) return;
  $("safety-peer").textContent = chatTitle(active);
  $("safety-code").textContent = await E2E.safetyCode(me.ecdhPub, await getKey(active));
  openDialog($("safety-dialog"));
};
$("safety-close").onclick = () => closeDialog($("safety-dialog"));

$("menu-btn").onclick = (e) => { e.stopPropagation(); $("menu").hidden = !$("menu").hidden; };
$("chat-menu-btn").onclick = openChatMenu;
document.addEventListener("click", (e) => {
  $("menu").hidden = true;
  $("chat-menu").hidden = true;
  $("attach-menu").hidden = true;
  if (!e.target.closest("#emoji-panel, #emoji-btn, #msg-menu")) $("emoji-panel").hidden = true;
  if (!e.target.closest("#msg-menu")) hideMessageMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  hideMessageMenu();
  $("menu").hidden = $("chat-menu").hidden = $("viewer").hidden = true;
  if (!$("browser").hidden) $("browser-close").click();
});
window.addEventListener("resize", hideMessageMenu);
$("messages").addEventListener("scroll", hideMessageMenu);
$("share-btn").onclick = async () => {
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const link = (local ? location.origin + location.pathname : SITE_URL) + "#" + me.username;
  try {
    if (navigator.share) return await navigator.share({ title: "Message me on FreeMessenger", url: link });
  } catch (e) {
    if (e && e.name === "AbortError") return;
  }
  await copyText(link);
  toast("Link copied: " + link);
};
$("new-group-btn").onclick = () => openGroupDialog(null);
$("profile-btn").onclick = () => openProfile(me.username);
$("admin-btn").onclick = () => Admin.open();
$("browser-btn").onclick = () => Browser.open();
$("history-btn").onclick = downloadHistory;
$("privacy-ok").onclick = () => { store.set("privacyNotice4", true); closeDialog($("privacy-dialog")); };
$("peer-avatar").onclick = $("peer-name").onclick = () => active && (isGroup(active) ? openGroupDialog(active) : openProfile(active));
$("settings-btn").onclick = openSettings;
$("backup-btn").onclick = downloadBackup;
$("banner-backup-btn").onclick = downloadBackup;
$("export-btn").onclick = exportChats;
$("notify-btn").onclick = async () => {
  toast(await Push.enable(conn));
  $("notify-btn").textContent = Push.status();
};
$("install-btn").onclick = () => Push.install();
Push.initInstall();
$("welcome-install-btn").onclick = () => Push.install();
if (/source=(android|app)/.test(location.search) || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)) $("welcome-install-btn").hidden = true;
$("logout-btn").onclick = async () => {
  if (!confirm("Sign out of this browser? Your account only comes back with your backup file. Messages saved here will be removed.")) return;
  await Push.disable(conn);
  store.clearAll();
  await files.clearAll();
  location.hash = "";
  location.reload();
};

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && active) {
    if (chats[active] && chats[active].unread) {
      chats[active].unread = 0;
      saveChats();
      renderChats();
      updateTitle();
    }
    sendReadReceipts(active);
  }
});
window.addEventListener("hashchange", () => {
  const hash = location.hash.slice(1).toLowerCase();
  if (me && handleJoinLink(hash)) return;
  if (me && USERNAME.test(hash) && hash !== me.username) openContact(hash);
});

Push.registerWorker();

if (me) {
  start();
} else {
  $("welcome").hidden = false;
  const hash = location.hash.slice(1).toLowerCase();
  if (USERNAME.test(hash)) $("invite-note").textContent = `@${hash} invited you. Pick a username to message them.`;
  // Sign-ups may need an invite code or the admin's approval.
  Relays.pick().then(() => api("/api/signup")).then((r) => {
    const code = new URLSearchParams(location.search).get("invite");
    $("signup-invite-row").hidden = r.mode !== "invite";
    if (code) $("signup-invite").value = code;
    $("signup-mode-note").textContent = r.mode === "approval" ? "New accounts are checked by the admin before they can send messages."
      : r.mode === "closed" ? "Sign-ups are closed right now." : r.mode === "invite" ? "You need an invite code to sign up." : "";
  }).catch(() => {});
}

// ---------- emoji picker and stickers ----------

let emojiTab = 0;
let emojiMode = "insert"; // or "react"
let emojiReact = null;

function toggleEmoji(mode, reactTo) {
  const panel = $("emoji-panel");
  emojiMode = mode || "insert";
  emojiReact = reactTo || null;
  if (!panel.hidden && !mode) { panel.hidden = true; return; }
  drawEmoji();
  panel.hidden = false;
}

function drawEmoji() {
  const tabs = $("emoji-tabs");
  const grid = $("emoji-grid");
  clear(tabs);
  const all = EMOJI.map((c) => [c[0], c[1]]).concat(emojiMode === "insert" ? [["🎟️", "Stickers"]] : []);
  all.forEach(([icon, name], i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = icon;
    b.title = name;
    b.className = i === emojiTab ? "on" : "";
    b.onclick = (e) => { e.stopPropagation(); emojiTab = i; drawEmoji(); };
    tabs.appendChild(b);
  });
  if (emojiTab >= all.length) emojiTab = 0;
  clear(grid);
  grid.className = emojiTab === EMOJI.length ? "sticker-grid" : "";
  if (emojiTab === EMOJI.length) return drawStickers(grid);
  for (const e of EMOJI[emojiTab][2]) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = e;
    b.onclick = (ev) => { ev.stopPropagation(); pickEmoji(e); };
    grid.appendChild(b);
  }
}

function pickEmoji(e) {
  if (emojiMode === "react" && emojiReact) {
    react(emojiReact.id, emojiReact.mid, e);
    $("emoji-panel").hidden = true;
    return;
  }
  const ta = $("send-text");
  const start = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
  const end = ta.selectionEnd == null ? ta.value.length : ta.selectionEnd;
  ta.value = ta.value.slice(0, start) + e + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = start + e.length;
  composerChanged();
}

function drawStickers(grid) {
  for (const [e, anim] of STICKERS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sticker-pick anim-" + anim;
    b.textContent = e;
    b.onclick = (ev) => {
      ev.stopPropagation();
      if (!active) return;
      $("emoji-panel").hidden = true;
      sendSpecial(active, { sticker: { e, anim } });
    };
    grid.appendChild(b);
  }
  // Your own stickers, made from pictures.
  const mine = store.get("myStickers", []);
  for (const sid of mine) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sticker-pick own";
    files.get("sticker:" + sid).then((blob) => {
      if (!blob) return;
      const img = document.createElement("img");
      img.src = URL.createObjectURL(blob);
      img.alt = "Sticker";
      b.appendChild(img);
    });
    b.onclick = async (ev) => {
      ev.stopPropagation();
      if (!active) return;
      const blob = await files.get("sticker:" + sid);
      if (!blob) return;
      $("emoji-panel").hidden = true;
      sendFile(active, new File([blob], "sticker.webp", { type: blob.type || "image/webp" }), { sticker: true });
    };
    b.oncontextmenu = (ev) => {
      ev.preventDefault();
      if (!confirm("Delete this sticker?")) return;
      store.set("myStickers", store.get("myStickers", []).filter((x) => x !== sid));
      files.remove("sticker:" + sid);
      drawEmoji();
    };
    grid.appendChild(b);
  }
  const add = document.createElement("button");
  add.type = "button";
  add.className = "sticker-pick add";
  add.textContent = "＋";
  add.title = "Make a sticker from a picture";
  add.onclick = (ev) => { ev.stopPropagation(); $("sticker-file").click(); };
  grid.appendChild(add);
}

$("sticker-file").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !/^image\//.test(file.type)) return;
  const blob = await Look.shrink(file, 320, "image/webp", 0.85);
  const sid = uuid();
  await files.put("sticker:" + sid, blob);
  store.set("myStickers", store.get("myStickers", []).concat(sid).slice(-60));
  drawEmoji();
  toast("Sticker saved. Right-click or long-press it to delete.");
};

// ---------- polls ----------

function openPollDialog() {
  if (!active) return;
  $("poll-q").value = "";
  $("poll-options").value = "";
  $("poll-multi").checked = false;
  $("poll-error").textContent = "";
  openDialog($("poll-dialog"));
  $("poll-q").focus();
}
$("poll-cancel").onclick = () => closeDialog($("poll-dialog"));
$("poll-form").onsubmit = (e) => {
  e.preventDefault();
  const q = $("poll-q").value.trim();
  let options = $("poll-options").value.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 10);
  const quiz = $("poll-quiz").checked;
  const right = options.findIndex((o) => o.startsWith("*"));
  options = options.map((o) => o.replace(/^\*\s*/, ""));
  if (quiz && right === -1) return ($("poll-error").textContent = "For a quiz, put * in front of the right answer.");
  if (!q) return ($("poll-error").textContent = "Write a question.");
  if (options.length < 2) return ($("poll-error").textContent = "Write at least two answers, one per line.");
  closeDialog($("poll-dialog"));
  sendSpecial(active, { poll: Object.assign({ q: q.slice(0, 300), options: options.map((o) => o.slice(0, 100)), multi: quiz ? false : $("poll-multi").checked, votes: {} }, quiz ? { quiz: right } : {}) });
};

// ---------- scheduled messages ----------

function openSchedule() {
  if (!active) return;
  if (!Relays.onPrimary()) return toast("Scheduling needs the home server, which isn't on right now.");
  const t = new Date(Date.now() + 3600e3);
  t.setSeconds(0, 0);
  const pad = (n) => String(n).padStart(2, "0");
  $("schedule-when").value = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
  $("schedule-text").value = $("send-text").value;
  $("schedule-error").textContent = "";
  openDialog($("schedule-dialog"));
}
$("schedule-cancel").onclick = () => closeDialog($("schedule-dialog"));
$("schedule-form").onsubmit = (e) => {
  e.preventDefault();
  const text = $("schedule-text").value.trim();
  const at = new Date($("schedule-when").value).getTime();
  if (!text) return ($("schedule-error").textContent = "Write the message first.");
  if (!(at > Date.now() + 60e3)) return ($("schedule-error").textContent = "Pick a time at least a minute from now.");
  closeDialog($("schedule-dialog"));
  $("send-text").value = "";
  composerChanged();
  sendSpecial(active, { text: text.slice(0, 8000), at, ts: at });
  toast("Scheduled. It's sent at that time even if your device is off.");
};

// ---------- forwarding ----------

let forwarding = null;

function openForward(id, m) {
  forwarding = { id, m };
  const list = $("forward-list");
  clear(list);
  const ids = Object.keys(chats).filter((x) => !(chats[x].left || chats[x].blocked))
    .sort((a, b) => (chats[b].last || 0) - (chats[a].last || 0));
  for (const x of ids) {
    const label = document.createElement("label");
    label.className = "forward-row";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = x;
    const name = document.createElement("span");
    name.textContent = chatTitle(x);
    label.append(box, name);
    list.appendChild(label);
  }
  openDialog($("forward-dialog"));
}
$("forward-cancel").onclick = () => closeDialog($("forward-dialog"));
$("forward-send").onclick = async () => {
  const targets = Array.from($("forward-list").querySelectorAll("input:checked")).map((b) => b.value);
  closeDialog($("forward-dialog"));
  if (!forwarding || !targets.length) return;
  const m = forwarding.m;
  for (const to of targets) {
    if (m.file && m.file.big && !(await files.get(m.file.fid))) {
      const fm = newOutgoing(to, { text: m.text, fwd: true, file: Object.assign({}, m.file, { fid: uuid(), ready: false }) });
      addMessage(to, fm);
      deliver(to, fm);
    } else if (m.file) {
      const blob = await files.get(m.file.fid);
      if (!blob) { toast("That file isn't saved in this browser, so it can't be forwarded."); continue; }
      const f = new File([blob], m.file.name, { type: m.file.type });
      await sendFile(to, f, { caption: m.text, fwd: true, voice: m.file.voice, duration: m.file.duration, sticker: m.file.sticker });
    } else if (m.poll) {
      sendSpecial(to, { poll: { q: m.poll.q, options: m.poll.options, multi: m.poll.multi, votes: {} }, fwd: true });
    } else if (m.sticker) {
      sendSpecial(to, { sticker: m.sticker, fwd: true });
    } else {
      sendSpecial(to, { text: m.text, preview: m.preview, fwd: true });
    }
  }
  toast(targets.length === 1 ? "Forwarded." : `Forwarded to ${targets.length} chats.`);
};

// ---------- starred messages ----------

function showStarred() {
  const results = $("results");
  $("contacts").hidden = true;
  results.hidden = false;
  clear(results);
  let count = 0;
  for (const id of Object.keys(chats)) {
    for (const m of loadChat(id)) {
      if (!m.starred || m.deleted) continue;
      const li = chatRow(id, "⭐ " + (m.mine ? "You: " : "") + previewText(m));
      li.dataset.id = id;
      li.dataset.mid = m.mid;
      results.appendChild(li);
      count++;
    }
  }
  if (!count) {
    const li = document.createElement("li");
    li.className = "none";
    li.textContent = "No starred messages. Tap a message → Star to save it here.";
    results.appendChild(li);
  }
  const close = document.createElement("li");
  close.className = "none";
  const b = document.createElement("button");
  b.className = "link";
  b.textContent = "Back to chats";
  b.onclick = (e) => { e.stopPropagation(); closeSearch(); };
  close.appendChild(b);
  results.insertBefore(close, results.firstChild);
}

// ---------- text formatting: **bold** _italic_ ~strike~ `code` ```block``` ||spoiler|| @mention ----------

let fmtRe = null;
function formatText(el, text) {
  // Links first, so formatting marks inside addresses are left alone.
  const linkRe = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;
  let last = 0;
  let m;
  while ((m = linkRe.exec(text))) {
    if (m.index > last) formatPlain(el, text.slice(last, m.index));
    linkify(el, m[0]);
    last = m.index + m[0].length;
  }
  if (last < text.length) formatPlain(el, text.slice(last));
}

function formatPlain(el, text) {
  if (!fmtRe) {
    try {
      fmtRe = new RegExp("(```[\\s\\S]+?```|`[^`\\n]+`|\\*\\*[^*\\n]+?\\*\\*|(?<![\\w*])\\*[^*\\n]+?\\*(?![\\w*])|(?<![\\w])_[^_\\n]+?_(?![\\w])|~[^~\\n]+?~|\\|\\|[^|\\n]+?\\|\\||@[a-z0-9_]{3,20})", "gi");
    } catch {
      // Older browsers: no look-behind, so only the unambiguous marks.
      fmtRe = /(```[\s\S]+?```|`[^`\n]+`|\*\*[^*\n]+?\*\*|~[^~\n]+?~|\|\|[^|\n]+?\|\||@[a-z0-9_]{3,20})/gi;
    }
  }
  fmtRe.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = fmtRe.exec(text))) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    const t = m[0];
    let node;
    if (t.startsWith("```")) { node = document.createElement("pre"); node.textContent = t.slice(3, -3).replace(/^\n/, ""); }
    else if (t[0] === "`") { node = document.createElement("code"); node.textContent = t.slice(1, -1); }
    else if (t.startsWith("**")) { node = document.createElement("strong"); formatPlain(node, t.slice(2, -2)); fmtRe.lastIndex = m.index + t.length; }
    else if (t[0] === "*" || t[0] === "_") { node = document.createElement("em"); node.textContent = t.slice(1, -1); }
    else if (t[0] === "~") { node = document.createElement("s"); node.textContent = t.slice(1, -1); }
    else if (t.startsWith("||")) {
      node = document.createElement("span");
      node.className = "spoiler";
      node.textContent = t.slice(2, -2);
      node.title = "Tap to show";
      node.onclick = (e) => { e.stopPropagation(); node.classList.add("shown"); };
    } else {
      node = document.createElement("span");
      node.className = "mention" + (t.slice(1).toLowerCase() === me.username ? " me" : "");
      node.textContent = t;
    }
    el.appendChild(node);
    last = m.index + t.length;
    fmtRe.lastIndex = last;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}

// ---------- send effects (like iMessage) ----------

const EFFECTS = [["confetti", "🎊 Confetti"], ["fireworks", "🎆 Fireworks"], ["hearts", "💖 Hearts"], ["balloons", "🎈 Balloons"], ["lasers", "🔦 Lasers"], ["snow", "❄️ Snow"], ["shake", "📳 Shake"]];

function playEffect(name) {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const layer = document.createElement("div");
  layer.className = "effect effect-" + name;
  const pieces = { confetti: 70, fireworks: 60, hearts: 30, balloons: 18, snow: 60, lasers: 8 }[name] || 0;
  const emoji = { hearts: ["💖", "💕", "❤️", "💗"], balloons: ["🎈", "🎈", "🎈", "🎉"], snow: ["❄️", "❅", "❆"] }[name];
  for (let i = 0; i < pieces; i++) {
    const p = document.createElement("span");
    if (emoji) p.textContent = emoji[i % emoji.length];
    p.style.left = Math.random() * 100 + "%";
    p.style.animationDelay = (Math.random() * 0.8).toFixed(2) + "s";
    p.style.setProperty("--hue", Math.floor(Math.random() * 360));
    p.style.setProperty("--dx", (Math.random() * 2 - 1).toFixed(2));
    p.style.setProperty("--dy", (Math.random() * 2 - 1).toFixed(2));
    if (name === "fireworks") { p.style.left = (20 + (i % 3) * 30) + "%"; p.style.top = (25 + (i % 2) * 20) + "%"; }
    if (name === "lasers") p.style.top = (10 + i * 11) + "%";
    layer.appendChild(p);
  }
  if (name === "shake") document.body.classList.add("shake");
  document.body.appendChild(layer);
  setTimeout(() => { layer.remove(); document.body.classList.remove("shake"); }, 3500);
}

// ---------- location ----------

function locationCard(loc) {
  const box = document.createElement("div");
  box.className = "loc-card";
  const title = document.createElement("strong");
  title.textContent = "📍 Location" + (loc.acc ? ` (within ${loc.acc} m)` : "");
  const coords = document.createElement("small");
  coords.textContent = `${loc.lat}, ${loc.lon}`;
  box.append(title, coords);
  const links = document.createElement("div");
  for (const [label, url] of [
    ["OpenStreetMap", `https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lon}#map=17/${loc.lat}/${loc.lon}`],
    ["Google Maps", `https://www.google.com/maps?q=${loc.lat},${loc.lon}`],
    ["Apple Maps", `https://maps.apple.com/?ll=${loc.lat},${loc.lon}&q=Location`],
  ]) {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = label;
    a.onclick = (e) => e.stopPropagation();
    links.appendChild(a);
  }
  box.appendChild(links);
  return box;
}

function shareLocation() {
  if (!active) return;
  if (!navigator.geolocation) return toast("This browser can't share a location.");
  if (!confirm(`Send your current location to ${chatTitle(active)}? (Once, not live.)`)) return;
  toast("Finding your location…");
  navigator.geolocation.getCurrentPosition(
    (pos) => sendSpecial(active, { loc: { lat: Math.round(pos.coords.latitude * 1e5) / 1e5, lon: Math.round(pos.coords.longitude * 1e5) / 1e5, acc: Math.round(pos.coords.accuracy || 0) } }),
    () => toast("Couldn't get your location. Check the browser's location permission."),
    { enableHighAccuracy: true, timeout: 15000 },
  );
}

// ---------- shared media in a chat ----------

function openMedia(id) {
  const list = loadChat(id).filter((m) => !m.deleted && !m.system);
  const grid = $("media-photos");
  const filesBox = $("media-files");
  const links = $("media-links");
  [grid, filesBox, links].forEach(clear);
  for (const m of list.slice().reverse()) {
    if (m.file && !m.file.once && !m.file.missing && /^(image|video)\//.test(m.file.type) && !m.file.sticker) {
      const b = document.createElement("button");
      b.className = "media-thumb";
      blobUrl(m.file.fid).then((url) => {
        if (!url) return b.remove();
        const el = document.createElement(/^video/.test(m.file.type) ? "video" : "img");
        el.src = url;
        b.appendChild(el);
      });
      b.onclick = () => { closeDialog($("media-dialog")); jumpTo(m.mid); };
      grid.appendChild(b);
    } else if (m.file && !m.file.sticker && !m.file.once) {
      const b = document.createElement("button");
      b.className = "media-row";
      b.textContent = (m.file.voice ? "🎤 Voice message" : "📎 " + m.file.name) + " · " + new Date(m.ts).toLocaleDateString();
      b.onclick = () => { closeDialog($("media-dialog")); jumpTo(m.mid); };
      filesBox.appendChild(b);
    }
    const found = (m.text || "").match(/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi) || [];
    for (const url of found) {
      const a = document.createElement("a");
      a.className = "media-row";
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer nofollow";
      a.textContent = url;
      links.appendChild(a);
    }
  }
  for (const [box, empty] of [[grid, "No photos or videos."], [filesBox, "No files."], [links, "No links."]]) {
    if (!box.children.length) { const p = document.createElement("p"); p.className = "hint"; p.textContent = empty; box.appendChild(p); }
  }
  $("media-title").textContent = chatTitle(id);
  openDialog($("media-dialog"));
}
$("media-close").onclick = () => closeDialog($("media-dialog"));

// ---------- online / last seen ----------

const presence = new Map(); // name -> { online, seen }

function presenceText(name) {
  const p = presence.get(name);
  if (!p) return "";
  if (p.online) return "online";
  if (!p.seen) return "";
  const mins = Math.floor((Date.now() - p.seen) / 60000);
  if (mins < 1) return "last seen just now";
  if (mins < 60) return `last seen ${mins} min ago`;
  const d = new Date(p.seen);
  return d.toDateString() === new Date().toDateString()
    ? "last seen today at " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : "last seen " + d.toLocaleDateString([], { month: "short", day: "numeric" });
}

async function refreshPresence() {
  if (!conn || !conn.ready || !flags.primary || document.hidden || !active || isGroup(active) || active === me.username) return;
  const r = await conn.op("presence", { users: [active] });
  if (r && r.presence) {
    presence.clear();
    for (const [n, v] of Object.entries(r.presence)) presence.set(n, v);
    renderHeader();
  }
}
setInterval(refreshPresence, 30e3);

// ---------- app lock ----------

const LOCK_ITER = 150000;
async function pinHash(pin, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: LOCK_ITER }, key, 256);
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, "0")).join("");
}

let lockedOut = 0;
let hiddenAt = 0;
function lockNow() {
  if (!store.get("lock", null)) return;
  $("lock").hidden = false;
  $("lock-pin").value = "";
  $("lock-error").textContent = "";
  setTimeout(() => $("lock-pin").focus(), 50);
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (store.get("lock", null) && hiddenAt && Date.now() - hiddenAt >= (settings.lockAfter || 0) * 1000) lockNow();
});
$("lock-form").onsubmit = async (e) => {
  e.preventDefault();
  const lock = store.get("lock", null);
  if (!lock) return ($("lock").hidden = true);
  if (Date.now() < lockedOut) return ($("lock-error").textContent = "Too many tries. Wait a moment.");
  if ((await pinHash($("lock-pin").value, lock.salt)) === lock.hash) {
    $("lock").hidden = true;
    if (afterUnlock) { const f = afterUnlock; afterUnlock = null; f(); }
    lock.fails = 0;
    store.set("lock", lock);
    return;
  }
  lock.fails = (lock.fails || 0) + 1;
  store.set("lock", lock);
  if (lock.fails % 5 === 0) lockedOut = Date.now() + 30e3 * (lock.fails / 5);
  $("lock-error").textContent = "Wrong PIN.";
  $("lock-pin").select();
};
$("lock-btn").onclick = async () => {
  if (store.get("lock", null)) {
    if (!confirm("Turn off the app lock?")) return;
    store.remove("lock");
    $("lock-btn").textContent = "Set a PIN";
    return toast("App lock is off.");
  }
  const pin = prompt("Choose a PIN (4 to 12 digits). You'll need it to open FreeMessenger on this device:");
  if (!pin) return;
  if (!/^\d{4,12}$/.test(pin)) return toast("Use 4 to 12 digits.");
  if (prompt("Type the PIN again:") !== pin) return toast("The PINs didn't match.");
  const salt = uuid();
  store.set("lock", { salt, hash: await pinHash(pin, salt) });
  $("lock-btn").textContent = "Turn off";
  toast("App lock is on.");
};
$("set-lock-after").onchange = () => { settings.lockAfter = Number($("set-lock-after").value); store.set("settings", settings); };

// ---------- privacy and Do Not Disturb ----------

$("set-seen").onchange = async () => {
  settings.hideSeen = !$("set-seen").checked;
  store.set("settings", settings);
  if (conn && conn.ready && flags.primary) await conn.op("privacy", { hideSeen: settings.hideSeen });
  presence.clear();
  renderHeader();
};
function saveDnd() {
  settings.dnd = { on: $("set-dnd").checked, from: $("set-dnd-from").value || "22:00", to: $("set-dnd-to").value || "07:00" };
  store.set("settings", settings);
  // The service worker reads this too, so closed-app notifications are silent then.
  files.put("dnd", settings.dnd);
}
["set-dnd", "set-dnd-from", "set-dnd-to"].forEach((id) => ($(id).onchange = saveDnd));

function fillPrivacyControls() {
  $("set-seen").checked = !settings.hideSeen;
  const d = settings.dnd || { on: false, from: "22:00", to: "07:00" };
  $("set-dnd").checked = !!d.on;
  $("set-dnd-from").value = d.from;
  $("set-dnd-to").value = d.to;
  $("lock-btn").textContent = store.get("lock", null) ? "Turn off" : "Set a PIN";
  $("set-lock-after").value = String(settings.lockAfter);
}

// ---------- send options: silent, effects ----------

function openSendOptions(e) {
  e.preventDefault();
  if (!active || !$("send-text").value.trim()) return toast("Type a message first, then pick how to send it.");
  const items = [["🔕 Send without sound", () => { pendingSend = { silent: true }; submitMessage(); }]];
  for (const [k, label] of EFFECTS) items.push([`Send with ${label}`, () => { pendingSend = { effect: k }; submitMessage(); }]);
  showChatMenu(items);
}
$("send-btn").addEventListener("contextmenu", openSendOptions);
let pressTimer = null;
$("send-btn").addEventListener("touchstart", (e) => { pressTimer = setTimeout(() => openSendOptions(e), 550); }, { passive: false });
$("send-btn").addEventListener("touchend", () => clearTimeout(pressTimer));
$("send-options-btn").onclick = (e) => { e.stopPropagation(); openSendOptions(e); };

// ---------- view-once photos ----------

$("attach-once-btn").onclick = () => $("once-file").click();
$("once-file").onchange = (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f || !active) return;
  if (!/^image\//.test(f.type)) return toast("View-once works with photos.");
  sendFile(active, f, { once: true });
  toast("Sent. They can open it once. (The admin copy still applies.)");
};
$("attach-loc-btn").onclick = shareLocation;
$("saved-btn").onclick = () => { ensureChat(me.username); openChat(me.username); };

// ---------- @mention suggestions in groups ----------

function mentionSuggest() {
  const box = $("mention-list");
  const ta = $("send-text");
  const before = ta.value.slice(0, ta.selectionStart || 0);
  const m = before.match(/(^|\s)@([a-z0-9_]{0,20})$/i);
  if (!active || !isGroup(active) || !m) { box.hidden = true; return; }
  const q = m[2].toLowerCase();
  const names = (chats[active].members || []).filter((n) => n !== me.username && (n.indexOf(q) === 0 || shortName(n).toLowerCase().indexOf(q) !== -1)).slice(0, 8);
  clear(box);
  if (!names.length) { box.hidden = true; return; }
  for (const n of names) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = shortName(n) + (shortName(n) !== "@" + n ? ` (@${n})` : "");
    b.onmousedown = (e) => {
      e.preventDefault();
      const start = before.length - q.length;
      ta.value = ta.value.slice(0, start) + n + " " + ta.value.slice(ta.selectionStart);
      ta.selectionStart = ta.selectionEnd = start + n.length + 1;
      box.hidden = true;
      composerChanged();
    };
    box.appendChild(b);
  }
  box.hidden = false;
}
$("send-text").addEventListener("input", mentionSuggest);
$("send-text").addEventListener("blur", () => setTimeout(() => ($("mention-list").hidden = true), 150));

// ---------- keyboard shortcuts ----------

function visibleChatIds() {
  return Array.from(document.querySelectorAll("#contacts li[data-id]")).map((li) => li.dataset.id);
}
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); $("search").focus(); return; }
  if (mod && e.key.toLowerCase() === "e" && active) { e.preventDefault(); toggleEmoji(); return; }
  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    const ids = visibleChatIds();
    if (!ids.length) return;
    e.preventDefault();
    const i = ids.indexOf(active);
    const next = e.key === "ArrowDown" ? ids[Math.min(ids.length - 1, i + 1)] : ids[Math.max(0, i === -1 ? 0 : i - 1)];
    if (next) openChat(next);
  }
});

// ---------- games ----------

function playMove(id, mid, cell) {
  const m = findMessage(id, mid);
  if (!m || !m.game) return;
  const next = Games.move(m.game, me.username, cell);
  if (!next) return;
  patchMessage(id, mid, { game: next });
  sendControlToChat(id, { kind: "game-move", mid, cell });
}

function startGame() {
  if (!active) return;
  setTimeout(() => showChatMenu(Games.GAMES.map(([type, label]) => [label, () => sendSpecial(active, { game: Games.newGame(type, me.username) })])), 0);
}

// ---------- contact cards ----------

function contactCard(u) {
  const box = document.createElement("div");
  box.className = "contact-card";
  const av = document.createElement("span");
  av.className = "avatar";
  fillAvatar(av, u);
  const info = document.createElement("span");
  const name = document.createElement("strong");
  name.textContent = shortName(u);
  const handle = document.createElement("small");
  handle.textContent = "@" + u;
  info.append(name, handle);
  const b = document.createElement("button");
  b.className = "ghost small";
  b.textContent = u === me.username ? "That's you" : "Message";
  b.onclick = (e) => { e.stopPropagation(); if (u !== me.username) openContact(u); };
  box.append(av, info, b);
  return box;
}

async function shareContact() {
  if (!active) return;
  const u = (prompt("Share which username? (Type it, e.g. @sam)") || "").trim().toLowerCase().replace(/^@/, "");
  if (!u) return;
  if (!USERNAME.test(u)) return toast("That isn't a valid username.");
  try { await getKey(u); } catch { return toast(`Nobody is called @${u}.`); }
  sendSpecial(active, { card: { u } });
}

// ---------- reminders, message info, dates, export ----------

function remindMenu(id, m) {
  const at = (h, mins, tomorrow) => { const d = new Date(); if (tomorrow) d.setDate(d.getDate() + 1); d.setHours(h, mins, 0, 0); return d.getTime(); };
  const choices = [
    ["In 20 minutes", Date.now() + 20 * 60e3],
    ["In 1 hour", Date.now() + 3600e3],
    ["In 3 hours", Date.now() + 3 * 3600e3],
    ["Tonight at 8 PM", at(20, 0, Date.now() > at(19, 50))],
    ["Tomorrow at 9 AM", at(9, 0, true)],
    ["Pick a time…", 0],
  ];
  const go = (when) => {
    if (!Relays.onPrimary()) return toast("Reminders need the home server, which isn't on right now.");
    const what = m.text ? m.text.slice(0, 300) : previewText(m);
    ensureChat(me.username);
    sendSpecial(me.username, { text: `⏰ Reminder from ${chatTitle(id)}${m.from && !m.mine ? ` (${shortName(m.from)})` : ""}:\n${what}`, at: when, ts: when });
    toast(`I'll remind you ${new Date(when).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })} in Saved messages.`);
  };
  const menuItems = choices.map(([label, when]) => [label, () => {
    if (when) return go(when);
    const raw = prompt("When? (for example 2026-12-24 18:30)", new Date(Date.now() + 86400e3).toISOString().slice(0, 16).replace("T", " "));
    const t = raw && new Date(raw.replace(" ", "T")).getTime();
    if (!t || t < Date.now() + 60e3) return toast("Pick a time at least a minute from now.");
    go(t);
  }]);
  // The message menu is gone by now, so show the choices in the chat menu
  // (after this click finishes, or the click would close it again).
  setTimeout(() => showChatMenu(menuItems), 0);
}

function messageInfo(id, m) {
  const list = $("info-list");
  clear(list);
  const add = (label, value) => {
    const row = document.createElement("div");
    row.className = "info-row";
    const a = document.createElement("span");
    a.textContent = label;
    const b = document.createElement("strong");
    b.textContent = value;
    row.append(a, b);
    list.appendChild(row);
  };
  add("Sent", new Date(m.ts).toLocaleString());
  if (isGroup(id)) {
    const by = m.readBy || {};
    for (const n of recipients(id)) add(shortName(n), by[n] === "read" ? "✓✓ Read" : by[n] === "delivered" ? "✓ Delivered" : "Not yet");
  } else {
    add("Status", statusLabel(m) || "—");
  }
  openDialog($("info-dialog"));
}
$("info-close").onclick = () => closeDialog($("info-dialog"));

function jumpToDate(id) {
  const raw = prompt("Jump to which date? (YYYY-MM-DD)", new Date().toISOString().slice(0, 10));
  if (!raw) return;
  const t = new Date(raw + "T00:00").getTime();
  if (!t) return toast("That isn't a date.");
  const m = loadChat(id).find((x) => x.ts >= t);
  if (!m) return toast("No messages from then or later.");
  jumpTo(m.mid);
}

function exportChatText(id) {
  const lines = [`${chatTitle(id)} — exported ${new Date().toLocaleString()}`, ""];
  for (const m of loadChat(id)) {
    if (m.deleted) continue;
    const who = m.system ? "•" : m.mine ? "You" : shortName(m.from || id);
    lines.push(`[${new Date(m.ts).toLocaleString()}] ${who}: ${m.system ? m.text : previewText(m) || ""}`);
  }
  download(new Blob([lines.join("\n")], { type: "text/plain" }), `${chatTitle(id).replace(/[^\w@ -]+/g, "").trim() || "chat"}.txt`);
}

// ---------- group photo and description ----------

function editGroupInfo(id) {
  const c = chats[id];
  return [
    ["Change the photo", () => $("group-photo-file").click()],
    ["Remove the photo", () => { updateGroup(id, { photo: undefined }); systemMessage(id, "You removed the group photo"); }],
    ["Edit the description", () => {
      const d = prompt("Group description (everyone sees it):", c.desc || "");
      if (d === null) return;
      updateGroup(id, { desc: d.trim().slice(0, 500) });
      systemMessage(id, "You changed the group description");
    }],
  ];
}
$("group-photo-file").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f || !active || !isGroup(active)) return;
  try {
    const photo = await Look.squareDataUrl(f, 256, 60000);
    updateGroup(active, { photo });
    systemMessage(active, "You changed the group photo");
  } catch (err) {
    toast(err.message);
  }
};

// ---------- locked chats ----------

let afterUnlock = null;
$("locked-btn").onclick = () => {
  if (!store.get("lock", null)) return toast("Set an app lock PIN first (Settings → App lock), then lock chats from their ⋮ menu.");
  afterUnlock = () => { showLocked = true; showArchived = false; renderChats(); };
  lockNow();
};

// ---------- chat filters ----------

document.querySelectorAll("#chat-filters button").forEach((b) => (b.onclick = () => { chatFilter = b.dataset.f; renderChats(); }));

// ---------- QR code ----------

$("qr-btn").onclick = () => {
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const link = (local ? location.origin + location.pathname : SITE_URL) + "#" + me.username;
  Extras.drawQr($("qr-code"), link);
  $("qr-link").textContent = link;
  openDialog($("qr-dialog"));
};
$("qr-close").onclick = () => { Extras.stopScan(); closeDialog($("qr-dialog")); };
$("qr-scan").onclick = () => Extras.scanQr((text) => {
  closeDialog($("qr-dialog"));
  const m = String(text).match(/#([a-z0-9_]{3,20})$/i) || String(text).match(/^@?([a-z0-9_]{3,20})$/i);
  if (m) openContact(m[1].toLowerCase()); else toast("That code isn't a FreeMessenger link.");
}, toast);

// ---------- doodles and video messages ----------

Extras.initDoodle();
Extras.initVideoNote();
$("attach-doodle-btn").onclick = () => { if (active) Extras.openDoodle((file) => sendFile(active, file)); };
$("attach-vnote-btn").onclick = () => { if (active) Extras.startVideoNote((file, duration) => sendFile(active, file, { vnote: true, duration }), toast); };
$("attach-game-btn").onclick = startGame;
$("attach-contact-btn").onclick = shareContact;
$("story-btn").onclick = () => Stories.compose();
$("broadcast-btn").onclick = () => openGroupDialog(null, "broadcast");

// ---------- big files (over 10 MB, up to 10 GB) ----------

const bigState = new Map(); // file id on the server -> "Uploading 40%" / "Downloading 12%"

function showBigState(id, mid, bid, text) {
  if (text) bigState.set(bid, text); else bigState.delete(bid);
  const m = findMessage(id, mid);
  if (m && active === id) rerenderMessage(id, m);
}

async function sendBigFile(id, file, extra = {}) {
  if (file.size > BigFile.MAX_BIG) return toast("Files can be up to 10 GB.");
  if (!BigFile.supported()) return toast("Files over 10 MB need a newer browser.");
  if (!conn || !conn.ready || !Relays.onPrimary()) return toast("Files over 10 MB go through the home server, which isn't reachable right now. Smaller files still work.");
  let prep;
  try {
    prep = await BigFile.prepare(conn, file.size);
  } catch (e) {
    return toast(e.message);
  }
  const fid = uuid();
  const inline = file.size <= BigFile.INLINE_MAX;
  if (inline) await files.put(fid, file);
  const m = newOutgoing(id, {
    text: extra.caption || "",
    file: { fid, name: file.name || "file", type: file.type || "application/octet-stream", size: file.size, n: prep.big.chunks, big: prep.big, ready: inline },
  });
  if (extra.fwd) m.fwd = true;
  clearDraft();
  addMessage(id, m);
  // The message goes out right away; people can download while this uploads.
  deliver(id, m);
  const bid = prep.big.bid;
  let last = 0;
  try {
    await BigFile.upload({
      conn, base: Relays.get(), file, prep,
      onProgress: (p) => {
        if (Date.now() - last < 500 && p < 1) return;
        last = Date.now();
        if (inline) showSendProgress(m.mid, p);
        else showBigState(id, m.mid, bid, `Uploading ${Math.round(p * 100)}%`);
      },
    });
    showBigState(id, m.mid, bid, null);
    toast(`"${m.file.name}" is uploaded. The server keeps it for ${bigKeepText()}.`);
  } catch (e) {
    showBigState(id, m.mid, bid, null);
    patchMessage(id, m.mid, { failed: true });
    toast(`"${m.file.name}" didn't finish uploading: ${e.message}`);
  }
}

const bigKeepText = () => "a few minutes unless people download it";

const bigBusy = new Set();
async function fetchBig(id, mid, userAsked) {
  const m = findMessage(id, mid);
  if (!m || !m.file || !m.file.big || m.file.ready || bigBusy.has(m.file.big.bid)) return;
  if (!conn || !conn.ready || !Relays.onPrimary()) {
    if (userAsked) toast("Big files come from the home server, which isn't reachable right now.");
    return;
  }
  const f = m.file;
  bigBusy.add(f.big.bid);
  let last = 0;
  const progress = (p) => {
    if (Date.now() - last < 500 && p < 1) return;
    last = Date.now();
    showBigState(id, mid, f.big.bid, `Downloading ${Math.round(p * 100)}%`);
  };
  try {
    if (f.size <= BigFile.INLINE_MAX) {
      const blob = await BigFile.fetchAll({ conn, base: Relays.get(), big: f.big, type: f.type, onProgress: progress });
      await files.put(f.fid, blob);
      bigState.delete(f.big.bid);
      patchMessage(id, mid, { file: Object.assign({}, f, { ready: true }) });
    } else {
      const how = await BigFile.save({ conn, base: Relays.get(), big: f.big, name: f.name, type: f.type, onProgress: progress });
      bigState.delete(f.big.bid);
      if (how === "streaming") toast("Downloading — your browser shows the progress.");
      else if (how === "saved") toast(`Saved "${f.name}".`);
      rerenderMessage(id, findMessage(id, mid));
    }
  } catch (e) {
    bigState.delete(f.big.bid);
    if (/expired/.test(e.message)) patchMessage(id, mid, { file: Object.assign({}, f, { expired: true }) });
    else rerenderMessage(id, findMessage(id, mid));
    if (userAsked || !/expired/.test(e.message)) toast(e.message);
  } finally {
    bigBusy.delete(f.big.bid);
  }
}

// Files that arrived while the home server wasn't reachable: try again once it is.
function fetchPendingBig() {
  for (const id of Object.keys(chats)) {
    for (const m of loadChat(id).slice(-50)) {
      if (m.file && m.file.big && !m.file.ready && !m.file.expired && !m.mine && m.file.size <= BigFile.INLINE_MAX) fetchBig(id, m.mid, false);
    }
  }
}

// ---------- someone wants the admin panel (shown to the owner) ----------

function showAdminRequest(ev) {
  const box = $("announce");
  const item = document.createElement("div");
  item.className = "announce-item admin-request";
  const title = document.createElement("strong");
  title.textContent = "🔐 Admin access request";
  const text = document.createElement("p");
  text.textContent = `@${ev.user} · ${ev.device} · IP ${ev.ip || "?"}. If you don't approve it within 10 minutes, that browser is banned.`;
  const row = document.createElement("div");
  row.className = "row";
  const yes = document.createElement("button");
  yes.className = "primary small";
  yes.textContent = "Approve";
  const no = document.createElement("button");
  no.className = "ghost small danger-text";
  no.textContent = "Ban";
  const done = () => { item.remove(); box.hidden = !box.children.length; };
  yes.onclick = () => { Admin.decide(ev.rid, true); done(); };
  no.onclick = () => { Admin.decide(ev.rid, false); done(); };
  row.append(no, yes);
  item.append(title, text, row);
  box.appendChild(item);
  box.hidden = false;
  playTone("bell");
  if (document.hidden) Push.showLocal("Admin access request", `@${ev.user} · ${ev.device}`, null, true);
}
