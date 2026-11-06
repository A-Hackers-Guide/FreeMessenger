// The admin panel, shown only to the site admin (the relay checks this too).
// Messages come from the home PC's storage as "admin copies" that each
// sender's browser encrypted for the admin, and are decrypted here, in the
// admin's own browser.

import * as E2E from "./crypto.js";
import * as F from "./files.js";
import { clear } from "./compat.js";
import * as Device from "./device.js";

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
  if (r.error) throw Object.assign(new Error(r.error), { needCode: !!r.needCode });
  return r;
}

// A trusted browser unlocks by itself; anywhere else asks for the code
// shown on a trusted browser (or the first-time setup code from the PC).
async function tryDevice() {
  if (!(await Device.known())) return false;
  try {
    const conn = ctx.conn();
    const d = await Device.get();
    await call("device-unlock", { deviceId: d.id, sig: await Device.sign("fm-admin-device:" + conn.nonce) });
    trustedHere = true;
    return true;
  } catch {
    return false;
  }
}

function askCode(body, first, then) {
  clear(body);
  const input = el("input", { autocomplete: "one-time-code", maxlength: "10", placeholder: first ? "ABCD2345" : "123456", class: "admin-filter code-input", autocapitalize: "characters", spellcheck: "false" });
  const err = el("p", { class: "error", role: "alert" });
  const trust = el("input", { type: "checkbox" });
  const form = el("form", { class: "admin-code" },
    el("h3", {}, first ? "Trust this browser" : "Enter your admin code"),
    el("p", { class: "hint" }, first
      ? "Type the setup code from E:\\FreeMessenger\\data\\device-setup-code.txt on the home PC. This browser will then open the admin panel without a code."
      : "Open the admin panel on your trusted browser (your Mac), tap \u201cCode for another device\u201d, and type the 6-digit code here."),
    input,
    first ? null : el("label", { class: "trust-row" }, trust, " Trust this browser too (no code next time)"),
    err,
    el("button", { type: "submit", class: "primary" }, "Unlock"));
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.textContent = "";
    try {
      const extra = { code: input.value.trim(), trust: first || trust.checked };
      if (extra.trust) extra.device = await Device.publicInfo();
      const r = await call("unlock", extra);
      trustedHere = !!r.trusted;
      then();
    } catch (x) {
      err.textContent = x.message;
      input.select();
    }
  };
  body.appendChild(form);
  input.focus();
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
    } catch (e) {
      if (e.needCode && (await tryDevice())) return show(name, true);
      if (e.needCode) return askCode(body, /setup code/.test(e.message), () => show(name, true));
      clear(body);
      body.appendChild(el("p", { class: "error" }, e.message));
      return;
    }
  }
  clear(body);
  if (name === "accounts") renderAccounts(body);
  else if (name === "messages") renderMessages(body);
  else if (name === "viewer") renderViewer(body);
  else if (name === "devices") renderDevices(body);
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
      fact("Sent", `${a.sent} messages · ${size(a.bytes)}`),
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
    case "text": return p.text || "";
    case "file": return `📎 ${p.voice ? "Voice message" : p.name} (${size(p.size)})${p.text ? " — " + p.text : ""}`;
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
      stat("Accounts", s.accounts), stat("Online now", s.online), stat("Messages", s.messages),
      stat("Messages today", s.messagesToday), stat("Waiting to be delivered", s.waiting)),
    el("h3", {}, "Storage"),
    el("div", { class: "meter" }, el("span", { style: `width:${pct.toFixed(1)}%` })),
    el("p", { class: "hint" }, `${size(s.used)} of ${size(s.cap)} used${pct > 90 ? " — almost full: the oldest file pieces are removed first" : ""}.`),
    el("h3", {}, "Connections"),
    el("p", { class: "hint" }, `Home server address: ${s.tunnel || "not up yet"}`),
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

// ---------- trusted browsers, and codes for other devices ----------

let codeTimer = null;

async function renderDevices(body) {
  clearInterval(codeTimer);
  if (trustedHere) {
    const code = el("strong", { class: "big-code" }, "······");
    const left = el("small", {}, "");
    const tick = async () => {
      if ($("admin").hidden || tab !== "devices") return clearInterval(codeTimer);
      try {
        const r = await call("current-code");
        code.textContent = r.code.slice(0, 3) + " " + r.code.slice(3);
        left.textContent = `Changes in ${r.left} seconds`;
      } catch (e) {
        code.textContent = "—";
        left.textContent = e.message;
      }
    };
    body.appendChild(el("div", { class: "stat code-card" }, el("small", {}, "Code for another device"), code, left));
    tick();
    codeTimer = setInterval(tick, 5000);
  } else {
    body.appendChild(el("p", { class: "hint" }, "This browser isn't trusted, so it can't show codes. Codes appear on your trusted browser."));
  }
  body.appendChild(el("h3", {}, "Trusted browsers"));
  const list = el("div", {}, el("p", { class: "hint" }, "Loading…"));
  body.appendChild(list);
  try {
    const r = await call("devices");
    clear(list);
    if (!r.devices.length) list.appendChild(el("p", { class: "hint" }, "None yet."));
    for (const d of r.devices) {
      list.appendChild(el("div", { class: "admin-msg" },
        el("strong", {}, d.name + (d.current ? " (this browser)" : "")),
        el("small", {}, "Trusted " + when(d.added)),
        el("button", { class: "link danger-text", onclick: async () => {
          if (!confirm(`Stop trusting ${d.name}${d.current ? " (this browser)" : ""}? It will need a code next time.`)) return;
          await call("untrust", { id: d.id }).catch((e) => ctx.toast(e.message));
          if (d.current) trustedHere = false;
          show("devices");
        } }, "Stop trusting")));
    }
  } catch (e) {
    clear(list);
    list.appendChild(el("p", { class: "error" }, e.message));
  }
}
