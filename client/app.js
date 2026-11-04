import "./compat.js";
import { RELAY_URL } from "./config.js";
import * as E2E from "./crypto.js";
import { uuid, clear, readFileText, openDialog, closeDialog, copyText, AudioCtx, canCall } from "./compat.js";
import { request, createConnection } from "./transport.js";
import { store, files } from "./store.js";
import * as F from "./files.js";
import * as Push from "./push.js";

window.FM_LOADED = true;

const $ = (id) => document.getElementById(id);
const USERNAME = /^[a-z0-9_]{3,20}$/;
const MAX_HISTORY = 2000;
const MAX_GROUP = 32;
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
  { theme: "system", size: "normal", enterSends: true, readReceipts: true, typing: true },
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

let active = null;
const isGroup = (id) => id.slice(0, 2) === "g:";
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
  const c = chats[id] || {};
  if (isGroup(id)) return c.name || "Group";
  return c.nickname ? `${c.nickname} (@${id})` : "@" + id;
}
const shortName = (name) => (chats[name] && chats[name].nickname) || "@" + name;

// ---------- relay ----------

async function api(path, body) {
  let r;
  try { r = await request(RELAY_URL + path, body); } catch { throw new Error("Can't reach the relay. Check your connection."); }
  if (!r.ok) throw Object.assign(new Error(r.data.error || `Relay error ${r.status}`), { status: r.status });
  return r.data;
}

async function getKey(name) {
  if (peers[name]) return peers[name];
  const p = await api(`/api/user/${name}`);
  peers[name] = p.ecdhPub;
  savePeers();
  return peers[name];
}

let conn = null;

function connect() {
  conn = createConnection({
    relay: RELAY_URL,
    username: me.username,
    sign: (challenge) => E2E.signChallenge(me, challenge),
    store,
    onMessage: handleIncoming,
    onState: (on, mode) => {
      setConnected(on, mode);
      if (on) {
        flushOutbox();
        Push.refresh(conn);
      }
    },
    onFatal: () => toast("This browser's keys don't match your account. Restore your backup file."),
  });
}

const online = () => !!(conn && conn.ready);
const sendRaw = (to, body, ephemeral, hint) => conn ? conn.send(to, body, ephemeral, hint) : Promise.resolve({ error: "offline" });

// Messages people should hear about wake the other person's device; edits,
// receipts, file pieces and typing don't.
const pushHint = (p) => (p.kind === "text" || p.kind === "file" || (p.kind === "group" && p.op === "create") ? "msg" : p.kind === "call-offer" ? "call" : undefined);

async function sendPayload(to, payload, ephemeral = false) {
  try {
    return await sendRaw(to, await E2E.encrypt(me, await getKey(to), payload), ephemeral, pushHint(payload));
  } catch (e) {
    return { error: e.message };
  }
}

// Who a chat's messages go to.
function recipients(id) {
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

  if (p.kind === "group") return handleGroupEvent(env.from, p, env.ts);
  const id = p.gid ? "g:" + p.gid : env.from;
  if (p.gid && !acceptFromGroup(id, env.from)) return;

  switch (p.kind) {
    case "text":
    case "file":
      return receiveMessage(id, env, p);
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
      return applyReceipt(id, p);
    case "typing":
      return showTyping(id, env.from);
    case "ttl":
      return setTtl(id, Number(p.ttl) || 0, env.from);
    default:
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
  if (p.kind === "file") {
    m.file = {
      fid: String(p.fid), name: String(p.name || "file").slice(0, 200), type: String(p.type || ""),
      size: Number(p.size) || 0, n: Number(p.n) || 1, w: p.w, h: p.h, voice: !!p.voice, duration: p.duration,
    };
    files.get(m.file.fid).then((blob) => { if (blob) patchMessage(id, m.mid, { file: Object.assign({}, m.file, { ready: true }) }); });
  }
  clearTyping(id, env.from);
  addMessage(id, m);
  if (!isGroup(id)) queueReceipt(id, m.mid);
  notify(id, isGroup(id) ? `${shortName(env.from)} in ${chatTitle(id)}` : chatTitle(id), previewText(m));
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

function handleGroupEvent(from, p, ts) {
  const id = "g:" + String(p.gid);
  if (!/^g:[0-9a-f-]{36}$/.test(id)) return;
  const c = chats[id];
  const members = cleanMembers(p.members);
  const name = String(p.name || "Group").slice(0, 60);
  if (p.op === "leave") {
    if (!c || c.members.indexOf(from) === -1) return;
    c.members = c.members.filter((n) => n !== from);
    saveChats();
    if (active === id) renderHeader();
    return systemMessage(id, `${shortName(from)} left the group`, ts);
  }
  if (members.indexOf(me.username) === -1) return;
  if (c && !c.pending && c.members.indexOf(from) === -1) return;
  const before = c ? c.members : [];
  const wasPending = !c || c.pending;
  const added = members.filter((n) => before.indexOf(n) === -1 && n !== from && n !== me.username);
  const renamed = c && !c.pending && c.name !== name;
  chats[id] = Object.assign(c || { last: 0, unread: 0, preview: "" }, { type: "group", name, members, pending: false, left: false });
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
  chats[id] = { type: "group", name, members, last: Date.now(), unread: 0, preview: "" };
  saveChats();
  systemMessage(id, `You created "${name}"`);
  sendControlToChat(id, { kind: "group", op: "create", name, members });
  openChat(id);
}

async function updateGroup(id, changes) {
  const c = chats[id];
  const oldMembers = c.members.slice();
  Object.assign(c, changes);
  saveChats();
  const everyone = cleanMembers(oldMembers.concat(c.members)).filter((n) => n !== me.username);
  everyone.forEach((to) => sendControl(to, { kind: "group", op: "update", gid: id.slice(2), name: c.name, members: c.members }));
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

function sendText(id, text) {
  const m = newOutgoing(id, { text });
  clearDraft();
  addMessage(id, m);
  deliver(id, m);
}

async function sendFile(id, file, extra = {}) {
  if (file.size > F.MAX_FILE_BYTES) return toast(`Files can be up to ${F.humanSize(F.MAX_FILE_BYTES)}.`);
  let blob = file;
  let type = file.type || "application/octet-stream";
  let dims = {};
  if (/^image\//.test(type) && !extra.voice) {
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
      extra.voice ? { voice: true, duration: extra.duration } : {}),
  });
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
    const base = { mid: m.mid, text: m.text, reply: m.reply, exp: m.exp };
    const payload = withGroup(id, m.file
      ? Object.assign(base, { kind: "file", fid: m.file.fid, name: m.file.name, type: m.file.type, size: m.file.size, n: m.file.n,
          w: m.file.w, h: m.file.h, voice: m.file.voice, duration: m.file.duration })
      : Object.assign(base, { kind: "text" }));
    let chunks = null;
    if (m.file) {
      const blob = await files.get(m.file.fid);
      if (!blob) return patchMessage(id, m.mid, { status: "sent", pendingTo: null, failed: true });
      chunks = await F.toChunks(blob);
    }
    const failed = [];
    for (const name of to) {
      let r = await sendPayload(name, payload);
      if (!r.error && chunks) {
        for (let i = 0; i < chunks.length && !r.error; i++) {
          r = await sendPayload(name, withGroup(id, { kind: "chunk", fid: m.file.fid, i, n: chunks.length, type: m.file.type, data: chunks[i] }));
          if (active === id && i % 4 === 3) showSendProgress(m.mid, (i + 1) / chunks.length);
        }
      }
      if (r.error) failed.push(name);
    }
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
  return { sending: "Sending…", waiting: "Will send when you're back online", sent: "Sent", delivered: "Delivered", read: "Read" }[m.status] || "";
};

// ---------- receipts and typing ----------

const pendingReceipts = new Map(); // chat id -> Set of mids
let receiptTimer = null;

function queueReceipt(id, mid) {
  if (!pendingReceipts.has(id)) pendingReceipts.set(id, new Set());
  pendingReceipts.get(id).add(mid);
  clearTimeout(receiptTimer);
  receiptTimer = setTimeout(flushReceipts, 800);
}

function flushReceipts() {
  for (const [id, mids] of pendingReceipts) {
    const read = active === id && !document.hidden && settings.readReceipts;
    sendControl(id, { kind: "receipt", state: read ? "read" : "delivered", mids: Array.from(mids) });
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
  if (isGroup(id) || !settings.readReceipts || document.hidden) return;
  const mids = loadChat(id).filter((m) => !m.mine && !m.system && !m.readSent && !m.deleted).map((m) => m.mid);
  if (!mids.length) return;
  sendControl(id, { kind: "receipt", state: "read", mids: mids.slice(-200) });
  markReadSent(id, new Set(mids));
}

function applyReceipt(id, p) {
  if (isGroup(id) || !Array.isArray(p.mids)) return;
  const status = p.state === "read" ? "read" : "delivered";
  const set = new Set(p.mids.slice(0, 500).map(String));
  const list = loadChat(id);
  let changed = false;
  for (const m of list) {
    if (m.mine && set.has(m.mid) && STATUS_RANK[status] > (STATUS_RANK[m.status] || 0)) { m.status = status; changed = true; }
  }
  if (!changed) return;
  saveChat(id, list);
  if (active === id) for (const m of list) if (set.has(m.mid)) rerenderMessage(id, m);
}

const typing = new Map(); // chat id -> Map(name -> until)
let lastTypingSent = 0;

function showTyping(id, from) {
  if (!typing.has(id)) typing.set(id, new Map());
  typing.get(id).set(from, Date.now() + 5000);
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
  el.textContent = !names.length ? "" : isGroup(active)
    ? `${names.map(shortName).join(", ")} ${names.length > 1 ? "are" : "is"} typing…`
    : "typing…";
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

function renderChats() {
  const ul = $("contacts");
  clear(ul);
  const ids = Object.keys(chats).filter((id) => chats[id].last || id === active)
    .sort((a, b) => (chats[b].last || 0) - (chats[a].last || 0));
  for (const id of ids) ul.appendChild(chatRow(id));
  $("contacts-empty").hidden = ids.length > 0;
}

function chatRow(id, snippet) {
  const c = chats[id] || {};
  const li = document.createElement("li");
  li.className = id === active ? "active" : "";
  li.dataset.id = id;
  li.innerHTML = `<span class="avatar"></span><span class="meta"><strong></strong><small></small></span><span class="badge"></span>`;
  const title = chatTitle(id);
  const avatar = li.querySelector(".avatar");
  avatar.textContent = isGroup(id) ? (title[0] || "G").toUpperCase() : (c.nickname || id)[0].toUpperCase();
  if (isGroup(id)) avatar.classList.add("group");
  li.querySelector("strong").textContent = title + (c.muted ? " 🔕" : "") + (c.blocked ? " (blocked)" : "");
  li.querySelector("small").textContent = snippet || c.preview || "";
  const badge = li.querySelector(".badge");
  if (c.unread && !snippet) badge.textContent = c.unread; else badge.remove();
  return li;
}

$("contacts").onclick = $("results").onclick = (e) => {
  const li = e.target.closest("li");
  if (li && li.dataset.id) openChat(li.dataset.id, { highlight: li.dataset.mid });
};

// Links in messages open in a new tab; everything else is plain text.
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
      if (f.voice) box.classList.add("voice");
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
    if (m.file) renderFile(id, m, bubble);
    if (m.text) {
      const t = document.createElement("div");
      t.className = "text";
      if (!m.file && !m.reply && emojiOnly(m.text)) bubble.classList.add("jumbo");
      linkify(t, m.text);
      bubble.appendChild(t);
    }
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
  meta.textContent = time(m.ts) + (m.edited && !m.deleted ? " · edited" : "") + (m.exp ? " · ⏱" : "");
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
  $("voice-btn").hidden = $("video-btn").hidden = group || !!c.blocked;
  $("safety-btn").hidden = group;
  $("members-btn").hidden = !group;
  if (group) $("members-btn").textContent = c.left ? "You left this group" : `${(c.members || []).length} members`;
  const disabled = (group && c.left) || c.blocked;
  $("send-form").classList.toggle("disabled", !!disabled);
  $("send-text").disabled = !!disabled;
  $("send-text").placeholder = c.blocked ? "You blocked this person" : group && c.left ? "You left this group" : "Message";
  renderTyping();
}

function openChat(id, opts = {}) {
  const scrollTop = $("messages").scrollTop;
  if (active !== id) clearDraft();
  active = id;
  ensureChat(id);
  chats[id].unread = 0;
  saveChats();
  $("empty").hidden = true;
  $("convo").hidden = false;
  renderHeader();
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

function notify(id, title, body) {
  if (chats[id] && chats[id].muted) return;
  if (!document.hidden) return;
  Push.showLocal(title, String(body).slice(0, 120), id);
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
  more.onclick = () => {
    hideMessageMenu();
    const emoji = prompt("React with any emoji:");
    if (emoji && emoji.trim()) react(id, mid, emoji.trim().slice(0, 16));
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
  if (m.text) add("Copy text", () => copyText(m.text).then(() => toast("Copied.")));
  if (m.file && m.file.ready) add("Save file", () => saveFile(m.file));
  if (m.mine && !m.file && canSend) add("Edit", () => startEdit(id, m));
  if (m.mine && canSend) add("Delete for everyone", () => {
    if (!confirm("Delete this message for everyone in the chat?")) return;
    deleteMessage(id, mid, true);
    sendControlToChat(id, { kind: "delete", mid });
  }, "danger-text");
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
  sendText(active, text.slice(0, 8000));
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
  recordTimer = setInterval(tick, 500);
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
  const items = [["Search in this chat", () => {
    $("chat-search-bar").hidden = false;
    $("chat-search").focus();
  }]];
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
    if (!c.left) {
      items.push(["Rename group", () => {
        const name = prompt("Group name:", c.name);
        if (name && name.trim()) {
          updateGroup(id, { name: name.trim().slice(0, 60) });
          systemMessage(id, `You renamed the group to "${name.trim().slice(0, 60)}"`);
        }
      }]);
      items.push(["Add people", () => openGroupDialog(id)]);
      items.push(["Leave group", () => { if (confirm(`Leave "${c.name}"?`)) leaveGroup(id); }, "danger-text"]);
    }
  } else {
    items.push(["Set a nickname", () => {
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

// ---------- group dialog ----------

let groupDialogFor = null;

function openGroupDialog(id) {
  groupDialogFor = id || null;
  const c = id && chats[id];
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
    try { iceServers = (await api("/api/ice")).iceServers; } catch { iceServers = [{ urls: "stun:stun.cloudflare.com:3478" }]; }
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
    return await navigator.mediaDevices.getUserMedia({ audio: true, video: video ? { facingMode: call.facing } : false });
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
  Object.assign(call, { state: "calling", peer, id: uuid(), video, started: 0, pendingIce: [] });
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
    Object.assign(call, { state: "ringing", peer: from, id: p.callId, video: !!p.video, offer: p.sdp, started: 0, pendingIce: [] });
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

function openViewer(url, name) {
  $("viewer-img").src = url;
  $("viewer-save").href = url;
  $("viewer-save").download = name || "photo";
  $("viewer").hidden = false;
}
$("viewer-close").onclick = () => ($("viewer").hidden = true);
$("viewer").onclick = (e) => { if (e.target === $("viewer")) $("viewer").hidden = true; };

// ---------- settings ----------

function applySettings() {
  const root = document.documentElement;
  if (settings.theme === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", settings.theme);
  root.setAttribute("data-size", settings.size);
}
applySettings();

function openSettings() {
  $("set-theme").value = settings.theme;
  $("set-size").value = settings.size;
  $("set-enter").checked = settings.enterSends;
  $("set-receipts").checked = settings.readReceipts;
  $("set-typing").checked = settings.typing;
  $("notify-btn").textContent = Push.status();
  openDialog($("settings-dialog"));
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
  $("me-name").textContent = "@" + me.username;
  $("backup-banner").hidden = store.get("backedUp", false);
  renderChats();
  updateTitle();
  sweepExpired();
  composerChanged();
  connect();
  Push.init({ username: me.username, onOpenChat: (id) => chats[id] && openChat(id) });
  const hash = location.hash.slice(1).toLowerCase();
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
    await api("/api/register", { username: name, sigPub: identity.sigPub, ecdhPub: identity.ecdhPub });
    me = identity;
    store.set("identity", me);
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

$("attach-btn").onclick = () => $("attach-file").click();
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
$("voice-btn").onclick = () => active && !isGroup(active) && startCall(active, false);
$("video-btn").onclick = () => active && !isGroup(active) && startCall(active, true);
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
  if (!e.target.closest("#msg-menu")) hideMessageMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  hideMessageMenu();
  $("menu").hidden = $("chat-menu").hidden = $("viewer").hidden = true;
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
$("settings-btn").onclick = openSettings;
$("backup-btn").onclick = downloadBackup;
$("banner-backup-btn").onclick = downloadBackup;
$("export-btn").onclick = exportChats;
$("notify-btn").onclick = async () => {
  toast(await Push.enable(conn));
  $("notify-btn").textContent = Push.status();
};
$("install-btn").onclick = () => Push.install();
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
  if (me && USERNAME.test(hash) && hash !== me.username) openContact(hash);
});

Push.registerWorker();

if (me) {
  start();
} else {
  $("welcome").hidden = false;
  const hash = location.hash.slice(1).toLowerCase();
  if (USERNAME.test(hash)) $("invite-note").textContent = `@${hash} invited you. Pick a username to message them.`;
}
