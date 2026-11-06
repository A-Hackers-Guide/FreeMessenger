// The admin panel, shown only to the site admin (the relay checks this too).
// Messages come from the home PC's storage as "admin copies" that each
// sender's browser encrypted for the admin, and are decrypted here, in the
// admin's own browser.

import * as E2E from "./crypto.js";
import * as F from "./files.js";
import { clear } from "./compat.js";
import * as Device from "./device.js";
import * as BigFile from "./bigfile.js";
import * as Relays from "./relays.js";

const $ = (id) => document.getElementById(id);
let ctx = null;          // { conn(), me(), toast() }
let tab = "accounts";
let trustedHere = false;
let data = null;         // last overview
const plain = new Map(); // archive id -> decrypted payload (or null)

const when = (ts) => (ts ? new Date(ts).toLocaleString() : "—");
const size = (n) => F.humanSize(n || 0);
function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e[k] = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.appendChild(typeof kid === "string" || typeof kid === "number" ? document.createTextNode(String(kid)) : kid);
  return e;
}

async function call(action, extra) {
  const conn = ctx.conn();
  if (!conn || !conn.ready) throw new Error("Not connected.");
  const r = await conn.op("admin", Object.assign({ action }, extra));
  if (r.error) throw Object.assign(new Error(r.error), { needApproval: !!r.needApproval, banned: !!r.banned });
  return r;
}

// An approved browser opens the panel by itself (it signs this connection's
// challenge with its device key). Any other browser asks for approval, which
// the owner gives from one of their own browsers; not approved within 10
// minutes, or banned, and this browser can't ask again.
let isSuperHere = false;

async function tryDevice() {
  if (!(await Device.known())) return false;
  try {
    const conn = ctx.conn();
    const d = await Device.get();
    const r = await call("device-unlock", { deviceId: d.id, sig: await Device.sign("fm-admin-device:" + conn.nonce) });
    isSuperHere = !!r.super;
    trustedHere = true;
    return true;
  } catch {
    return false;
  }
}

let waitTimer = null;

// Admin panel on a browser that isn't approved yet: nothing is sent until you
// press "Ask for approval".
function askApproval(body, then) {
  clear(body);
  clearInterval(waitTimer);
  const btn = el("button", { class: "primary" }, "🔐 Ask for approval");
  btn.onclick = () => { btn.disabled = true; requestApproval(body, then); };
  body.appendChild(el("div", { class: "admin-code" },
    el("h3", {}, "This browser isn't approved yet"),
    el("p", { class: "hint" }, "Ask, then approve it from one of your approved browsers: an Approve / Ban prompt appears there (also in the Security tab)."),
    el("p", { class: "hint" }, "If it isn't approved within 10 minutes of asking, this browser is banned from the admin panel."),
    btn));
}

async function requestApproval(body, then) {
  clear(body);
  clearInterval(waitTimer);
  let info;
  try {
    info = await call("request", { device: await Device.publicInfo() });
  } catch (e) {
    body.appendChild(el("div", { class: "admin-code" }, el("h3", {}, e.banned ? "🚫 This browser is banned" : "Can't open the admin panel"), el("p", { class: "hint" }, e.message)));
    return;
  }
  if (info.needSetup) return askSetup(body, then);
  const status = el("p", { class: "hint" }, "");
  body.appendChild(el("div", { class: "admin-code" },
    el("h3", {}, "⏳ Waiting for approval"),
    el("p", { class: "hint" }, "Open the admin panel on one of the owner's approved browsers. A request for this browser is waiting there (also in the Security tab): tap Approve."),
    el("p", { class: "hint" }, "If it isn't approved within 10 minutes, this browser is banned from the admin panel."),
    status));
  const poll = async () => {
    try {
      const r = await call("request-status", { rid: info.rid });
      if (r.status === "approved") {
        clearInterval(waitTimer);
        if (await tryDevice()) return then();
      } else if (r.status === "banned" || r.status === "gone") {
        clearInterval(waitTimer);
        clear(body);
        body.appendChild(el("div", { class: "admin-code" }, el("h3", {}, "🚫 Not approved"), el("p", { class: "hint" }, "This browser is now banned from the admin panel.")));
      } else {
        status.textContent = `Time left: ${Math.floor(r.left / 60000)}:${String(Math.floor((r.left % 60000) / 1000)).padStart(2, "0")}`;
      }
    } catch {}
  };
  poll();
  waitTimer = setInterval(() => { if ($("admin").hidden) return clearInterval(waitTimer); poll(); }, 3000);
}

// The very first browser: the setup code written on the home PC.
function askSetup(body, then) {
  clear(body);
  const input = el("input", { autocomplete: "one-time-code", maxlength: "10", placeholder: "ABCD2345", class: "admin-filter code-input", autocapitalize: "characters", spellcheck: "false" });
  const err = el("p", { class: "error", role: "alert" });
  const form = el("form", { class: "admin-code" },
    el("h3", {}, "Set up the admin panel"),
    el("p", { class: "hint" }, "Type the setup code from E:\\FreeMessenger\\data\\device-setup-code.txt on the home PC. This browser becomes your first approved admin browser."),
    input, err, el("button", { type: "submit", class: "primary" }, "Set up"));
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.textContent = "";
    try {
      const r = await call("unlock", { code: input.value.trim(), device: await Device.publicInfo() });
      isSuperHere = !!r.super;
      trustedHere = true;
      then();
    } catch (x) {
      err.textContent = x.message;
    }
  };
  body.appendChild(form);
  input.focus();
}

// The owner's quick answer to a request that just came in.
export async function decide(rid, approve) {
  try {
    if (!trustedHere && !(await tryDevice())) throw new Error("Open the admin panel on an approved browser first.");
    await call(approve ? "approve-browser" : "ban-request", { rid });
    ctx.toast(approve ? "Approved." : "Banned.");
    if (!$("admin").hidden && tab === "security") show("security");
  } catch (e) {
    ctx.toast(e.message);
  }
}

export function init(c) {
  ctx = c;
  $("admin-close").onclick = close;
  $("admin-refresh").onclick = () => show(tab, true);
  document.querySelectorAll("#admin .tabs button").forEach((b) => (b.onclick = () => show(b.dataset.tab)));
}

export function open() {
  $("admin").hidden = false;
  document.body.classList.add("panel-open");
  show(tab, true);
}

function close() {
  $("admin").hidden = true;
  document.body.classList.remove("panel-open");
}

async function show(name, reload) {
  tab = name;
  document.querySelectorAll("#admin .tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  const body = $("admin-body");
  if (reload || !data) {
    clear(body);
    body.appendChild(el("p", { class: "hint" }, "Loading…"));
    try {
      data = await call("overview");
      if (!trustedHere) { const w = await call("whoami"); isSuperHere = !!w.super; trustedHere = true; }
      document.querySelectorAll("#admin .tabs [data-owner]").forEach((b) => (b.hidden = !isSuperHere));
    } catch (e) {
      if (e.needApproval && (await tryDevice())) return show(name, true);
      if (e.needApproval) return askApproval(body, () => show(name, true));
      clear(body);
      body.appendChild(el("p", { class: "error" }, e.message));
      return;
    }
  }
  clear(body);
  if (name === "accounts") renderAccounts(body);
  else if (name === "messages") renderMessages(body);
  else if (name === "viewer") renderViewer(body);
  else if (name === "security") renderSecurity(body);
  else if (name === "reports") renderReports(body);
  else if (name === "alerts") renderAlerts(body);
  else if (name === "settings") renderSettings(body);
  else renderActivity(body);
}

// ---------- accounts ----------

async function act(action, user, extra, done) {
  try {
    await call(action, Object.assign({ user }, extra));
    ctx.toast(done);
    show(tab, true);
  } catch (e) {
    ctx.toast(e.message);
  }
}

function statusText(a) {
  const parts = [];
  if (a.status === "pending") parts.push("Waiting for approval");
  if (a.status === "banned") parts.push("Banned");
  if (a.status === "frozen") parts.push("Frozen");
  if (a.timeoutUntil > Date.now()) parts.push("Timed out until " + when(a.timeoutUntil));
  if (a.admin) parts.push("Admin");
  if (a.proxy) parts.push("Web viewer");
  return parts.join(" · ") || "OK";
}

function avatarOf(a) {
  const p = a.profile || {};
  const box = el("span", { class: "avatar" });
  if (p.avatar) box.appendChild(el("img", { src: p.avatar, alt: "" }));
  else box.textContent = (p.display || a.username)[0].toUpperCase();
  return box;
}

function renderAccounts(body) {
  const filter = el("input", { type: "search", placeholder: "Filter by username, name or IP", class: "admin-filter" });
  const list = el("div", { class: "admin-list" });
  const draw = () => {
    clear(list);
    const f = filter.value.trim().toLowerCase();
    for (const a of data.accounts) {
      const p = a.profile || {};
      const hay = [a.username, p.display, p.real, a.lastIp, a.signupIp, a.note].join(" ").toLowerCase();
      if (f && hay.indexOf(f) === -1) continue;
      list.appendChild(accountCard(a));
    }
    if (!list.firstChild) list.appendChild(el("p", { class: "hint" }, "No accounts match."));
  };
  filter.oninput = draw;
  body.append(el("p", { class: "hint" }, `${data.accounts.length} accounts. Tap an action to apply it right away.`), filter, list);
  draw();
}

function accountCard(a) {
  const p = a.profile || {};
  const u = a.username;
  const actions = el("div", { class: "admin-actions" });
  const btn = (label, fn, cls) => actions.appendChild(el("button", { class: "ghost small " + (cls || ""), onclick: fn }, label));
  if (a.status === "pending") btn("Approve", () => act("approve", u, {}, `@${u} can send messages now.`));
  btn("Read messages", () => { tab = "messages"; msgState.user = u; show("messages"); });
  if (!a.admin) {
    if (a.status === "banned") btn("Unban", () => act("unban", u, {}, `@${u} unbanned.`));
    else {
      btn(a.status === "frozen" ? "Unfreeze" : "Freeze", () => act("freeze", u, { on: a.status !== "frozen" }, a.status === "frozen" ? `@${u} can send again.` : `@${u} is frozen: they can read but not send.`));
      btn(a.timeoutUntil > Date.now() ? "End time-out" : "Time out", () => {
        if (a.timeoutUntil > Date.now()) return act("timeout", u, { minutes: 0 }, `@${u}'s time-out ended.`);
        const m = prompt(`Time out @${u} for how many minutes? (60 = 1 hour, 1440 = 1 day)`, "60");
        if (m && Number(m) > 0) act("timeout", u, { minutes: Number(m) }, `@${u} is timed out for ${m} minutes.`);
      });
      btn("Ban", () => {
        if (!confirm(`Ban @${u}? They're signed out everywhere and can't sign in again. Their username stays taken.`)) return;
        const ip = confirm(`Also block @${u}'s IP addresses (${[a.lastIp, a.signupIp].filter(Boolean).join(", ") || "none known"}) from signing up or in?`);
        act("ban", u, { ip }, `@${u} banned.`);
      }, "danger-text");
    }
    btn("Remove", () => {
      if (confirm(`Remove @${u}'s account? Their username becomes free for anyone. Saved messages stay in the archive.`)) act("remove", u, {}, `@${u} removed.`);
    }, "danger-text");
  }
  btn(a.proxy || a.admin ? "Web viewer: on" : "Web viewer: off", () => {
    if (a.admin) return ctx.toast("Admins always have the web viewer.");
    act("proxy", u, { on: !a.proxy }, a.proxy ? `@${u} can't use the web viewer now.` : `@${u} can use the web viewer.`);
  });
  if (!a.admin) btn("Storage limit", () => {
    const v = prompt(`Storage limit for @${u} in GB (0 = unlimited, empty = the default):`, a.quotaGB == null ? "" : String(a.quotaGB));
    if (v !== null) act("quota", u, { gb: v.trim() === "" ? null : Number(v) }, "Storage limit saved.");
  });
  btn("Note", () => {
    const n = prompt(`Private note about @${u} (only admins see it):`, a.note || "");
    if (n !== null) act("note", u, { note: n }, "Note saved.");
  });
  return el("div", { class: "admin-card" + (a.status === "banned" ? " banned" : "") },
    el("div", { class: "admin-card-head" },
      avatarOf(a),
      el("div", { class: "grow" },
        el("strong", {}, p.display ? `${p.display} (@${u})` : "@" + u, a.online ? el("span", { class: "dot on inline", title: "Online" }) : null),
        el("small", {}, statusText(a))),
    ),
    el("dl", { class: "admin-facts" },
      fact("Real name", p.real), fact("Status", p.status), fact("About", p.bio),
      fact("Joined", when(a.created)), fact("Last seen", when(a.lastSeen)),
      fact("Last IP", a.lastIp), fact("Sign-up IP", a.signupIp),
      fact("Sent", `${a.sent} messages`),
      fact("Storage", `${size(a.used)} of ${a.quota ? size(a.quota) : "unlimited"}`),
      fact("Made on", a.origin === "cf" ? "Backup relay" : "Home server"),
      fact("Note", a.note)),
    actions);
}

const fact = (k, v) => (v ? el("div", {}, el("dt", {}, k), el("dd", {}, String(v))) : null);

// ---------- messages ----------

const msgState = { user: "", rows: [], keys: {}, done: false, convo: null, search: "" };

async function decryptRows(rows, keys) {
  const me = ctx.me();
  for (const r of rows) {
    if (plain.has(r.id)) continue;
    let p = null;
    try {
      if (r.escrow && keys[r.sender]) p = await E2E.decrypt(me, keys[r.sender], r.escrow);
    } catch {}
    plain.set(r.id, p);
  }
}

function renderMessages(body) {
  const pick = el("select", { class: "admin-filter" }, el("option", { value: "" }, "Pick an account…"),
    data.accounts.map((a) => el("option", { value: a.username }, "@" + a.username + (a.profile && a.profile.display ? ` (${a.profile.display})` : ""))));
  pick.value = msgState.user;
  const search = el("input", { type: "search", placeholder: "Search their messages", class: "admin-filter", value: msgState.search });
  const wrap = el("div", { class: "admin-msgs" });
  body.append(el("p", { class: "hint" }, "Everything an account sent or received, decrypted here in your browser from the admin copies."), el("div", { class: "row" }, pick, search), wrap);
  pick.onchange = () => { msgState.user = pick.value; msgState.rows = []; msgState.done = false; msgState.convo = null; load(wrap); };
  search.oninput = () => { msgState.search = search.value; drawConvos(wrap); };
  if (msgState.user) {
    if (msgState.rows.length) drawConvos(wrap); else load(wrap);
  }
}

async function load(wrap, more) {
  clear(wrap);
  wrap.appendChild(el("p", { class: "hint" }, "Loading and decrypting…"));
  try {
    const before = more && msgState.rows.length ? msgState.rows[msgState.rows.length - 1].ts : undefined;
    const r = await call("messages", { user: msgState.user, before });
    Object.assign(msgState.keys, r.keys);
    await decryptRows(r.messages, msgState.keys);
    msgState.rows = msgState.rows.concat(r.messages);
    msgState.done = r.done;
    drawConvos(wrap);
  } catch (e) {
    clear(wrap);
    wrap.appendChild(el("p", { class: "error" }, e.message));
  }
}

// Turns the archive rows into conversations: direct chats by the other person,
// group chats by group. A group message is stored once per member, so
// copies of the same message are shown once.
function conversations() {
  const u = msgState.user;
  const convos = new Map();
  const groupNames = new Map();
  const seen = new Set();
  for (const r of msgState.rows) {
    const p = plain.get(r.id);
    if (p && p.kind === "group" && p.name && p.gid) groupNames.set(p.gid, p.name);
  }
  for (const r of msgState.rows.slice().reverse()) {
    const p = plain.get(r.id);
    if (p && (p.kind === "receipt" || p.kind === "typing")) continue;
    const key = p && p.gid ? "g:" + p.gid : r.sender === u ? r.recipient : r.sender;
    const dedupe = r.sender + ":" + (p && p.mid ? p.kind + p.mid : r.id) + (p && p.kind === "react" ? p.emoji : "");
    if (p && p.gid && seen.has(dedupe)) continue;
    seen.add(dedupe);
    if (!convos.has(key)) convos.set(key, { key, title: key.startsWith("g:") ? `Group: ${groupNames.get(key.slice(2)) || "unnamed"}` : `@${u} ↔ @${key}`, items: [] });
    convos.get(key).items.push({ r, p });
  }
  return [...convos.values()].sort((a, b) => b.items[b.items.length - 1].r.ts - a.items[a.items.length - 1].r.ts);
}

function describe(p) {
  if (!p) return "[couldn't decrypt: sent before admin copies existed, or by an old app]";
  switch (p.kind) {
    case "text": return (p.fwd ? "↪ " : "") + (p.text || "") + (p.preview ? `  [link: ${p.preview.title}]` : "") + (p.card ? `👤 contact @${p.card.u}` : "") + (p.loc ? `📍 ${p.loc.lat}, ${p.loc.lon}` : "");
    case "file": return `📎 ${p.voice ? "Voice message" : p.name} (${size(p.size)})${p.text ? " — " + p.text : ""}`;
    case "poll": return `📊 Poll: ${p.poll && p.poll.q} — ${((p.poll && p.poll.options) || []).join(" / ")}`;
    case "sticker": return `${p.sticker && p.sticker.e} (sticker)`;
    case "story": return `📸 Story: ${p.text || ""}${p.image ? " [photo]" : ""}`;
    case "story-view": return "👁 viewed a story";
    case "story-delete": return "deleted a story";
    case "game": return `🎮 started ${p.game && p.game.type === "c4" ? "Connect Four" : "tic-tac-toe"}`;
    case "game-move": return "🎮 played a move";
    case "vote": return `voted in a poll (${(p.choices || []).map((c) => c + 1).join(", ") || "removed vote"})`;
    case "pin": return p.on ? "📌 pinned a message" : "unpinned a message";
    case "edit": return `✏️ edited a message to: ${p.text}`;
    case "delete": return "🗑 deleted a message for everyone";
    case "react": return p.emoji ? `reacted ${p.emoji}` : "removed a reaction";
    case "ttl": return `⏱ set disappearing messages to ${p.ttl ? p.ttl / 3600 + " h" : "off"}`;
    case "group": return p.op === "leave" ? "left the group" : `${p.op === "create" ? "created" : "updated"} group "${p.name}" with ${(p.members || []).map((m) => "@" + m).join(", ")}`;
    default: return p.kind ? `[${p.kind}]` : "[unknown]";
  }
}

function drawConvos(wrap) {
  clear(wrap);
  const list = conversations();
  const s = msgState.search.trim().toLowerCase();
  if (!list.length) wrap.appendChild(el("p", { class: "hint" }, "No messages saved for this account."));
  const side = el("div", { class: "admin-convos" });
  const main = el("div", { class: "admin-thread" });
  for (const c of list) {
    const hits = s ? c.items.filter(({ p }) => describe(p).toLowerCase().indexOf(s) !== -1).length : 0;
    if (s && !hits) continue;
    const last = c.items[c.items.length - 1];
    side.appendChild(el("button", {
      class: "admin-convo" + (msgState.convo === c.key ? " on" : ""),
      onclick: () => { msgState.convo = c.key; drawConvos(wrap); },
    }, el("strong", {}, c.title), el("small", {}, `${c.items.length} items · ${when(last.r.ts)}${hits ? ` · ${hits} matches` : ""}`)));
  }
  const current = list.find((c) => c.key === msgState.convo);
  if (current) {
    for (const { r, p } of current.items) {
      const text = describe(p);
      const row = el("div", { class: "admin-msg" + (s && text.toLowerCase().indexOf(s) !== -1 ? " hit" : "") },
        el("small", {}, `@${r.sender}${current.key.startsWith("g:") ? "" : " → @" + r.recipient} · ${when(r.ts)}`),
        el("div", {}, text));
      if (p && p.kind === "file") row.appendChild(el("button", { class: "ghost small", onclick: () => openFile(p, row) }, "Open file"));
      main.appendChild(row);
    }
  } else if (list.length) {
    main.appendChild(el("p", { class: "hint" }, "Pick a conversation."));
  }
  wrap.append(el("div", { class: "admin-split" }, side, main));
  if (!msgState.done) wrap.appendChild(el("button", { class: "ghost small", onclick: () => load(wrap, true) }, "Load older messages"));
}

// Puts a file back together from its pieces. Pictures, video and audio are
// shown here; anything else is downloaded, never opened, so a file can't
// run anything in this page.
async function openFile(p, row) {
  if (p.big) {
    try {
      const r = await BigFile.save({ conn: ctx.conn(), base: Relays.get(), big: p.big, name: p.name || "file", type: p.type });
      if (r === "streaming") ctx.toast("Downloading — your browser shows the progress.");
    } catch (e) {
      ctx.toast(e.message);
    }
    return;
  }
  try {
    const r = await call("file", { fid: p.fid });
    const parts = [];
    for (const piece of r.pieces) {
      const d = await E2E.decrypt(ctx.me(), r.keys[piece.sender], piece.escrow);
      parts[d.i] = d.data;
    }
    if (parts.filter((x) => x !== undefined).length < (p.n || 1)) return ctx.toast("Some pieces of this file are missing.");
    const blob = F.fromChunks(parts, p.type);
    const url = URL.createObjectURL(blob);
    let view;
    if (/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(p.type)) view = el("img", { src: url, class: "admin-media", alt: "" });
    else if (/^video\//.test(p.type)) view = el("video", { src: url, class: "admin-media", controls: true });
    else if (/^audio\//.test(p.type)) view = el("audio", { src: url, controls: true });
    const save = el("a", { href: url, download: p.name || "file", class: "ghost small" }, "Download");
    row.append(view || "", save);
  } catch (e) {
    ctx.toast(e.message || "Couldn't open that file.");
  }
}

// ---------- web viewer ----------

async function renderViewer(body) {
  const allowed = data.accounts.filter((a) => a.proxy || a.admin);
  body.append(
    el("p", { class: "hint" }, "Who can use the web viewer. Give it to someone from their card on the Accounts tab."),
    el("ul", { class: "admin-plain" }, allowed.map((a) => el("li", {}, "@" + a.username + (a.admin ? " (admin)" : ""),
      a.admin ? null : el("button", { class: "link", onclick: () => act("proxy", a.username, { on: false }, `@${a.username} can't use the web viewer now.`) }, " Take away")))),
    el("h3", {}, "Pages opened"),
  );
  const box = el("div", {}, el("p", { class: "hint" }, "Loading…"));
  body.appendChild(box);
  try {
    const r = await call("proxy-log");
    clear(box);
    if (!r.log.length) box.appendChild(el("p", { class: "hint" }, "Nobody has used it yet."));
    for (const l of r.log) box.appendChild(el("div", { class: "admin-msg" }, el("small", {}, `@${l.username} · ${when(l.ts)}`), el("div", { class: "wrap" }, l.url)));
  } catch (e) {
    clear(box);
    box.appendChild(el("p", { class: "error" }, e.message));
  }
}

// ---------- activity ----------

function renderActivity(body) {
  const s = data.stats;
  const pct = Math.min(100, (s.used / s.cap) * 100);
  body.append(
    el("div", { class: "admin-stats" },
      stat("Open reports", s.openReports), stat("Waiting for approval", s.pending),
      stat("Accounts", s.accounts), stat("Online now", s.online), stat("Messages", s.messages),
      stat("Messages today", s.messagesToday), stat("Waiting to be delivered", s.waiting)),
    el("h3", {}, "Storage"),
    el("div", { class: "meter" }, el("span", { style: `width:${pct.toFixed(1)}%` })),
    el("p", { class: "hint" }, `${size(s.used)} of ${size(s.cap)} used${pct > 90 ? " — almost full: the oldest file pieces are removed first" : ""}.`),
    el("p", { class: "hint" }, s.dbBackup ? `Last backup: ${when(s.dbBackup.ts)} (${size(s.dbBackup.bytes)})` : "No backup yet. Backups run every night at 3 AM (Settings tab → Back up now)."),
    el("h3", {}, "Connections"),
    el("p", { class: "hint" }, `Home server address: ${s.tunnel || "not up yet"}`),
    el("p", { class: "hint" }, s.forwards && s.forwards.ts
      ? (s.forwards.failed ? `Router port forwarding: ${s.forwards.failed} ports failed (${s.forwards.error}). Calls through strict networks may not connect.` : `Router port forwarding: all ${s.forwards.ok} TURN ports forwarded (renewed ${when(s.forwards.ts)}).`)
      : "Router port forwarding: not set up."),
    el("p", { class: "hint" }, s.turnCheck ? (s.turnCheck.ok ? `Calls relay (TURN): reachable from the internet (checked ${when(s.turnCheck.ts)}).` : `Calls relay (TURN): NOT reachable from the internet — ${s.turnCheck.error} (checked ${when(s.turnCheck.ts)}).`) : "Calls relay (TURN): not checked yet."),
    el("p", { class: "hint" }, s.backup ? `Last sync with the backup relay: ${when(s.backup.ts)} — ${s.backup.ok ? "OK" : "failed: " + s.backup.error}` : "Not synced with the backup relay yet."),
    el("h3", {}, "Blocked IP addresses"),
  );
  if (!data.bannedIps.length) body.appendChild(el("p", { class: "hint" }, "None."));
  for (const b of data.bannedIps) {
    body.appendChild(el("div", { class: "admin-msg" }, el("strong", {}, b.ip), el("small", {}, ` ${b.reason || ""} · ${when(b.ts)} `),
      el("button", { class: "link", onclick: () => act("unban-ip", "", { ip: b.ip }, `${b.ip} unblocked.`) }, "Unblock")));
  }
  body.appendChild(el("h3", {}, "Recent events"));
  for (const e of data.events) body.appendChild(el("div", { class: "admin-msg" }, el("small", {}, when(e.ts)), el("div", {}, e.text)));
}

const stat = (label, value) => el("div", { class: "stat" }, el("strong", {}, String(value)), el("small", {}, label));

// ---------- security: admin sessions, approvals, bans, admins (owner only) ----------

async function renderSecurity(body) {
  let r;
  try { r = await call("security"); } catch (e) { return body.appendChild(el("p", { class: "error" }, e.message)); }
  const btn = (label, fn, cls) => el("button", { class: "ghost small " + (cls || ""), onclick: fn }, label);
  const act2 = async (action, extra, done) => {
    try { await call(action, extra); ctx.toast(done); } catch (e) { ctx.toast(e.message); }
    show("security");
  };

  body.appendChild(el("h3", {}, `Waiting for approval (${r.requests.length})`));
  if (!r.requests.length) body.appendChild(el("p", { class: "hint" }, "No browsers are asking right now."));
  for (const q of r.requests) {
    body.appendChild(el("div", { class: "admin-card request" },
      el("strong", {}, `@${q.user} wants admin access`),
      el("small", {}, `${q.device} · IP ${q.ip || "?"} · asked ${when(q.ts)} · banned in ${Math.ceil(q.left / 60000)} min if not approved`),
      el("div", { class: "admin-actions" },
        btn("✅ Approve", () => act2("approve-browser", { rid: q.rid }, "Approved.")),
        btn("🚫 Ban this browser", () => act2("ban-request", { rid: q.rid }, "Banned."), "danger-text"))));
  }

  body.appendChild(el("h3", {}, `Open admin sessions (${r.sessions.length})`));
  for (const v of r.sessions) {
    body.appendChild(el("div", { class: "admin-msg" },
      el("strong", {}, `@${v.user} · ${v.device}${v.you ? " (this browser)" : ""}`),
      el("small", {}, `IP ${v.ip || "?"} · ${v.kind} · since ${when(v.since)} · last: ${v.lastAction || "—"} at ${when(v.last)}`),
      v.you ? null : btn("🚫 Ban this session", () => {
        if (confirm(`Throw out this admin session (@${v.user}, ${v.device}, ${v.ip}) and ban that browser?`)) act2("ban-session", { id: v.id }, "Session banned.");
      }, "danger-text")));
  }

  body.appendChild(el("h3", {}, "Admins"));
  for (const a of r.admins) {
    body.appendChild(el("div", { class: "admin-msg" },
      el("strong", {}, "@" + a.user + (a.owner ? " (owner)" : "")),
      el("small", {}, a.owner ? "Everything, including reading messages and managing admins" : `Moderation only (can't read messages or change settings) · given by @${a.by} ${when(a.ts)}`),
      a.owner ? null : btn("Take admin away", () => { if (confirm(`Take admin power away from @${a.user}?`)) act2("revoke-admin", { user: a.user }, "Done."); }, "danger-text")));
  }
  const who = el("input", { placeholder: "@username", class: "admin-filter", style: "max-width:220px" });
  body.appendChild(el("div", { class: "row" }, who, btn("Make admin", () => {
    const u = who.value.trim().replace(/^@/, "").toLowerCase();
    if (!u) return;
    if (confirm(`Give @${u} admin power? They can see accounts and IP addresses and freeze, time out or ban people. Their browser still needs your approval.`)) act2("grant-admin", { user: u }, `@${u} is an admin now.`);
  })));

  body.appendChild(el("h3", {}, `Approved admin browsers (${r.browsers.length})`));
  for (const d of r.browsers) {
    body.appendChild(el("div", { class: "admin-msg" },
      el("strong", {}, `${d.name} · @${d.user}${d.you ? " (this browser)" : ""}`),
      el("small", {}, "Approved " + when(d.added)),
      d.you ? null : btn("Remove", () => act2("untrust", { id: d.id }, "Removed."), "danger-text")));
  }

  body.appendChild(el("h3", {}, `Banned browsers (${r.bans.length})`));
  if (!r.bans.length) body.appendChild(el("p", { class: "hint" }, "None."));
  for (const b of r.bans) {
    body.appendChild(el("div", { class: "admin-msg" },
      el("strong", {}, `${b.name || "Browser"} · @${b.user || "?"}`),
      el("small", {}, `IP ${b.ip || "?"} · ${b.why || ""} · ${when(b.ts)}`),
      btn("Unban", () => act2("unban-browser", { id: b.id }, "Unbanned."))));
  }

  body.appendChild(el("h3", {}, "Admin activity"));
  for (const e of r.log) body.appendChild(el("div", { class: "admin-msg" }, el("small", {}, when(e.ts)), el("div", {}, e.text)));
}

// ---------- reports ----------

async function renderReports(body) {
  const box = el("div", {}, el("p", { class: "hint" }, "Loading…"));
  body.append(el("p", { class: "hint" }, "Messages people reported. Each report includes the reported message and the chat around it, as the reporter's browser saw them."), box);
  try {
    const r = await call("reports");
    clear(box);
    if (!r.reports.length) box.appendChild(el("p", { class: "hint" }, "No reports."));
    for (const rep of r.reports) {
      let m = {};
      let ctxList = [];
      try { m = JSON.parse(rep.message || "{}"); } catch {}
      try { ctxList = JSON.parse(rep.context || "[]"); } catch {}
      const details = el("details", {}, el("summary", {}, `The chat around it (${ctxList.length} messages)`),
        ctxList.map((x) => el("div", { class: "admin-msg" }, el("small", {}, `@${x.from} · ${when(x.ts)}`), el("div", {}, x.text || (x.file ? "📎 " + x.file : "")))));
      box.appendChild(el("div", { class: "admin-card" + (rep.status === "done" ? " banned" : "") },
        el("strong", {}, `@${rep.reporter} reported @${rep.reported}`),
        el("small", {}, `${when(rep.ts)}${rep.status === "done" ? " · handled" : ""}`),
        rep.reason ? el("div", {}, "Reason: " + rep.reason) : null,
        el("div", { class: "admin-msg" }, el("small", {}, `@${m.from || rep.reported}${m.chat ? " in " + m.chat : ""} · ${when(m.ts)}`), el("div", {}, m.text || (m.file ? "📎 " + m.file : ""))),
        details,
        el("div", { class: "admin-actions" },
          el("button", { class: "ghost small", onclick: () => { msgState.user = rep.reported; msgState.rows = []; show("messages"); } }, "Read their messages"),
          el("button", { class: "ghost small", onclick: () => { show("accounts"); setTimeout(() => { const f = document.querySelector(".admin-filter"); if (f) { f.value = rep.reported; f.oninput(); } }, 50); } }, "Their account"),
          el("button", { class: "ghost small", onclick: async () => { await call("resolve-report", { n: rep.n, open: rep.status === "done" }).catch((e) => ctx.toast(e.message)); show("reports"); } },
            rep.status === "done" ? "Reopen" : "Mark handled"))));
    }
  } catch (e) {
    clear(box);
    box.appendChild(el("p", { class: "error" }, e.message));
  }
}

// ---------- word alerts ----------
//
// The server can't read messages, so the words are checked here, in the
// admin's browser, after decrypting the admin copies of the last 7 days.

async function renderAlerts(body) {
  const box = el("div", {}, el("p", { class: "hint" }, "Decrypting the last 7 days of messages and checking them…"));
  body.append(el("p", { class: "hint" }, "Messages from the last 7 days that contain one of your watch words (whole words only). Change the words on the Settings tab."), box);
  try {
    const r = await call("recent");
    const words = r.watchWords || [];
    clear(box);
    if (!words.length) return box.appendChild(el("p", { class: "hint" }, "You haven't set any watch words yet (Settings tab)."));
    await decryptRows(r.messages, r.keys);
    // Whole words only: a watch word never matches inside a longer word.
    const alt = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    let re;
    try { re = new RegExp("(?<![A-Za-z0-9])(" + alt + ")(?![A-Za-z0-9])", "i"); } catch { re = new RegExp("\\b(" + alt + ")\\b", "i"); }
    const seen = new Set();
    let hits = 0;
    for (const row of r.messages) {
      const p = plain.get(row.id);
      const text = p && (p.text || p.name || "");
      if (!text || !re.test(text)) continue;
      const key = row.sender + ":" + (p.mid || row.id);
      if (seen.has(key)) continue;
      seen.add(key);
      hits++;
      const line = el("div", {});
      for (const part of text.split(re)) line.appendChild(words.indexOf(part.toLowerCase()) !== -1 ? el("mark", { class: "hl" }, part) : document.createTextNode(part));
      box.appendChild(el("div", { class: "admin-msg" },
        el("small", {}, `@${row.sender} → ${p.gid ? "a group" : "@" + row.recipient} · ${when(row.ts)}`), line,
        el("button", { class: "link", onclick: () => { msgState.user = row.sender; msgState.rows = []; show("messages"); } }, "Open their messages")));
    }
    if (!hits) box.appendChild(el("p", { class: "hint" }, `No matches for: ${words.join(", ")}.`));
  } catch (e) {
    clear(box);
    box.appendChild(el("p", { class: "error" }, e.message));
  }
}

// ---------- settings: sign-ups, invites, storage, watch words, backups, announcements ----------

const SITE = "https://a-hackers-guide.github.io/FreeMessenger/";

async function renderSettings(body) {
  let cfg;
  try { cfg = await call("settings"); } catch (e) { return body.appendChild(el("p", { class: "error" }, e.message)); }

  const mode = el("select", {},
    el("option", { value: "open" }, "Anyone can sign up"),
    el("option", { value: "approval" }, "Anyone, but I approve them before they can send"),
    el("option", { value: "invite" }, "Only with an invite code"),
    el("option", { value: "closed" }, "Nobody (closed)"));
  mode.value = cfg.signupMode;
  mode.onchange = () => call("set-settings", { signupMode: mode.value }).then(() => ctx.toast("Sign-ups updated.")).catch((e) => ctx.toast(e.message));

  const invites = el("div", {});
  const drawInvites = (list) => {
    clear(invites);
    for (const i of list) {
      const link = SITE + "?invite=" + i.code;
      invites.appendChild(el("div", { class: "admin-msg" },
        el("strong", {}, i.code), el("small", {}, `Used ${i.used} of ${i.uses}${i.note ? " · " + i.note : ""} · ${when(i.created)}`),
        el("div", { class: "wrap" }, link),
        el("div", { class: "admin-actions" },
          el("button", { class: "ghost small", onclick: () => navigator.clipboard.writeText(link).then(() => ctx.toast("Link copied.")) }, "Copy link"),
          el("button", { class: "ghost small danger-text", onclick: async () => { await call("delete-invite", { code: i.code }); show("settings"); } }, "Delete"))));
    }
  };
  drawInvites(cfg.invites);
  const uses = el("input", { type: "number", min: "1", max: "1000", value: "1", style: "width:90px" });
  const note = el("input", { placeholder: "Who it's for (optional)" });

  const quota = el("input", { type: "number", min: "0", step: "0.5", value: String(cfg.defaultQuotaGB), style: "width:110px" });
  quota.onchange = () => call("set-settings", { defaultQuotaGB: Number(quota.value) }).then(() => ctx.toast("Default storage limit saved."));

  const words = el("textarea", { rows: "4", placeholder: "One word or phrase per line" });
  words.value = cfg.watchWords.join("\n");

  const ann = el("textarea", { rows: "3", maxlength: "2000", placeholder: "Message for everyone" });
  const annList = el("div", {});
  call("announcements").then((r) => {
    for (const a of r.announcements) annList.appendChild(el("div", { class: "admin-msg" }, el("small", {}, when(a.ts)), el("div", {}, a.text),
      el("button", { class: "link danger-text", onclick: async () => { await call("delete-announcement", { n: a.n }); show("settings"); } }, "Delete")));
  }).catch(() => {});

  body.append(
    el("div", { class: "admin-form" },
      el("h3", {}, "Sign-ups"), mode,
      el("p", { class: "hint" }, "While the home server is off, sign-ups only work when this is set to “Anyone can sign up”."),
      el("h3", {}, "Invite codes"),
      el("div", { class: "row" }, el("span", {}, "Uses:"), uses, note,
        el("button", { class: "primary small", onclick: async () => {
          const r = await call("invite", { uses: Number(uses.value), note: note.value }).catch((e) => ctx.toast(e.message));
          if (r) { ctx.toast("Invite made: " + r.code); show("settings"); }
        } }, "Make invite")),
      invites,
      el("h3", {}, "Big files (over 10 MB)"),
      el("p", { class: "hint" }, "Kept on the home server only briefly, unless enough people download them in time."),
      bigRulesForm(cfg),
      el("h3", {}, "Storage per person"),
      el("div", { class: "row" }, el("span", {}, "Default limit (GB, 0 = unlimited):"), quota),
      el("h3", {}, "Watch words"),
      words,
      el("button", { class: "ghost small", onclick: () => call("set-settings", { watchWords: words.value.split("\n") }).then(() => ctx.toast("Watch words saved.")) }, "Save watch words"),
      el("h3", {}, "Announcement"),
      ann,
      el("button", { class: "primary small", onclick: async () => {
        if (!ann.value.trim() || !confirm("Send this to everyone?")) return;
        await call("announce", { text: ann.value }).then(() => { ctx.toast("Sent."); show("settings"); }).catch((e) => ctx.toast(e.message));
      } }, "Send to everyone"),
      annList,
      el("h3", {}, "Backups"),
      el("p", { class: "hint" }, `${cfg.backupDir ? "Every night at 3 AM to " + cfg.backupDir + ", keeping 14." : "No backup folder set."} ${cfg.backup ? "Last: " + when(cfg.backup.ts) + " (" + size(cfg.backup.bytes) + ")." : ""}`),
      el("button", { class: "ghost small", onclick: async () => {
        ctx.toast("Backing up…");
        const r = await call("backup").catch((e) => ctx.toast(e.message));
        if (r) { ctx.toast("Backed up (" + size(r.backup.bytes) + ")."); show("settings"); }
      } }, "Back up now")));
}

function bigRulesForm(cfg) {
  const r = cfg.bigRules || {};
  const num = (v, min, w) => el("input", { type: "number", min, value: String(v), style: `width:${w || 80}px` });
  const ttl = num(r.ttlMin, 1);
  const people = num(r.keepDownloads, 0);
  const win = num(r.keepWindowMin, 1);
  const days = num(r.keepDays, 0);
  const save = () => call("set-settings", { bigRules: { ttlMin: ttl.value, keepDownloads: people.value, keepWindowMin: win.value, keepDays: days.value } })
    .then(() => ctx.toast("Big file rules saved.")).catch((e) => ctx.toast(e.message));
  [ttl, people, win, days].forEach((i) => (i.onchange = save));
  const list = el("div", {});
  for (const b of cfg.bigFiles || []) {
    list.appendChild(el("div", { class: "admin-msg" },
      el("small", {}, `@${b.owner} · ${size(b.size)} · ${b.downloads} downloads · ${!b.done ? "uploading" : b.kept ? (b.expires ? "kept until " + when(b.expires) : "kept forever") : "deleted " + when(b.expires)}`)));
  }
  return el("div", { class: "admin-form" },
    el("div", { class: "row" }, el("span", {}, "Delete after (minutes):"), ttl),
    el("div", { class: "row" }, el("span", {}, "…unless this many people download it:"), people),
    el("div", { class: "row" }, el("span", {}, "…within (minutes):"), win),
    el("div", { class: "row" }, el("span", {}, "…then keep it (days, 0 = forever):"), days),
    el("p", { class: "hint" }, "Recent big files:"), list);
}
