// Stories: a photo or a line of text your contacts can see for 24 hours,
// like WhatsApp Status. A story is sent once to each person you have a chat
// with, encrypted like any message, and every browser forgets it after a day.
// Opening someone's story tells them you saw it.

import { store } from "./store.js";
import { clear, uuid, openDialog, closeDialog } from "./compat.js";

const $ = (id) => document.getElementById(id);
const DAY = 24 * 3600e3;
const BGS = ["#2f6fed", "#7c3aed", "#db2777", "#ea580c", "#16a34a", "#0f172a", "#0891b2"];
let ctx = null; // { me(), contacts(), send(to, payload), name(user), avatar(el, user), toast(), shrink(file) }
let viewing = null;

const load = () => store.get("stories", []).filter((s) => Date.now() - s.ts < DAY);
const save = (list) => store.set("stories", list.slice(-300));

export function init(c) {
  ctx = c;
  $("story-cancel").onclick = () => closeDialog($("story-dialog"));
  $("story-photo-btn").onclick = () => $("story-photo").click();
  $("story-photo").onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      $("story-preview").src = await ctx.shrink(f);
      $("story-preview").hidden = false;
    } catch (err) {
      ctx.toast(err.message);
    }
  };
  $("story-bg").onclick = () => {
    const i = (BGS.indexOf($("story-text").dataset.bg) + 1) % BGS.length;
    setBg(BGS[i]);
  };
  $("story-form").onsubmit = (e) => { e.preventDefault(); post(); };
  $("story-viewer").onclick = (e) => {
    if (e.target.closest("#story-close")) return closeViewer();
    if (e.target.closest("#story-reply-form, #story-viewers")) return;
    const r = $("story-viewer").getBoundingClientRect();
    step(e.clientX < r.left + r.width / 3 ? -1 : 1);
  };
  $("story-reply-form").onsubmit = (e) => {
    e.preventDefault();
    const text = $("story-reply").value.trim();
    if (!text || !viewing) return;
    const s = viewing.list[viewing.i];
    ctx.reply(s.from, `↩️ Replying to your story${s.text ? `: "${s.text.slice(0, 60)}"` : ""}\n${text}`);
    $("story-reply").value = "";
    ctx.toast("Reply sent.");
  };
  setInterval(render, 60e3);
}

function setBg(bg) {
  $("story-text").dataset.bg = bg;
  $("story-text").style.background = bg;
}

export function compose() {
  $("story-text").value = "";
  $("story-preview").hidden = true;
  $("story-preview").removeAttribute("src");
  setBg(BGS[0]);
  openDialog($("story-dialog"));
}

function post() {
  const text = $("story-text").value.trim().slice(0, 500);
  const image = $("story-preview").hidden ? null : $("story-preview").src;
  if (!text && !image) return ctx.toast("Write something or pick a photo.");
  const story = { sid: uuid(), from: ctx.me(), ts: Date.now(), text, bg: $("story-text").dataset.bg, image, views: {} };
  const people = ctx.contacts();
  for (const to of people) ctx.send(to, { kind: "story", sid: story.sid, text, bg: story.bg, image });
  save(load().concat(story));
  closeDialog($("story-dialog"));
  render();
  ctx.toast(people.length ? `Shared with ${people.length} ${people.length === 1 ? "person" : "people"} for 24 hours.` : "Posted. Start a chat with someone so they can see your stories.");
}

// From the chat code: a story or a "seen" from someone.
export function receive(from, p, ts) {
  const list = load();
  if (p.kind === "story") {
    if (typeof p.sid !== "string" || list.some((s) => s.sid === p.sid)) return;
    const image = typeof p.image === "string" && p.image.length < 200000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p.image) ? p.image : null;
    list.push({ sid: p.sid, from, ts: Math.min(ts, Date.now()), text: String(p.text || "").slice(0, 500), bg: BGS.indexOf(p.bg) !== -1 ? p.bg : BGS[0], image, seen: false });
    save(list);
    render();
  } else if (p.kind === "story-view") {
    const s = list.find((x) => x.sid === p.sid && x.from === ctx.me());
    if (!s) return;
    s.views = Object.assign({}, s.views, { [from]: ts });
    save(list);
  } else if (p.kind === "story-delete") {
    save(list.filter((x) => !(x.sid === p.sid && x.from === from)));
    render();
  }
}

// The row of circles above the chat list.
export function render() {
  const bar = $("stories");
  if (!bar || !ctx) return;
  clear(bar);
  const list = load();
  const me = ctx.me();
  const mine = list.filter((s) => s.from === me);
  const add = document.createElement("button");
  add.className = "story-ring mine" + (mine.length ? " has" : "");
  const av = document.createElement("span");
  av.className = "avatar";
  ctx.avatar(av, me);
  const plus = document.createElement("b");
  plus.textContent = "+";
  const label = document.createElement("small");
  label.textContent = mine.length ? "My story" : "Add story";
  add.append(av, plus, label);
  add.onclick = () => (mine.length ? open(me) : compose());
  add.oncontextmenu = (e) => { e.preventDefault(); compose(); };
  bar.appendChild(add);
  const people = [];
  for (const s of list) if (s.from !== me && people.indexOf(s.from) === -1) people.push(s.from);
  people.sort((a, b) => unseen(b) - unseen(a));
  for (const name of people) {
    const b = document.createElement("button");
    b.className = "story-ring" + (unseen(name) ? " new" : "");
    const a = document.createElement("span");
    a.className = "avatar";
    ctx.avatar(a, name);
    const l = document.createElement("small");
    l.textContent = ctx.name(name).replace(/^@/, "");
    b.append(a, l);
    b.onclick = () => open(name);
    bar.appendChild(b);
  }
  bar.hidden = false;
}

const unseen = (name) => load().filter((s) => s.from === name && !s.seen).length;

function open(name) {
  const list = load().filter((s) => s.from === name).sort((a, b) => a.ts - b.ts);
  if (!list.length) return;
  const first = list.findIndex((s) => !s.seen);
  viewing = { name, list, i: first === -1 ? 0 : first, timer: null };
  $("story-viewer").hidden = false;
  show();
}

function show() {
  clearTimeout(viewing.timer);
  const s = viewing.list[viewing.i];
  const mine = s.from === ctx.me();
  $("story-who").textContent = (mine ? "You" : ctx.name(s.from)) + " · " + ago(s.ts);
  const stage = $("story-stage");
  clear(stage);
  stage.style.background = s.image ? "#000" : s.bg;
  if (s.image) {
    const img = document.createElement("img");
    img.src = s.image;
    img.alt = "";
    stage.appendChild(img);
  }
  if (s.text) {
    const t = document.createElement("p");
    t.className = s.image ? "caption" : "big";
    t.textContent = s.text;
    stage.appendChild(t);
  }
  const bars = $("story-progress");
  clear(bars);
  viewing.list.forEach((_, j) => {
    const b = document.createElement("i");
    b.className = j < viewing.i ? "done" : j === viewing.i ? "now" : "";
    bars.appendChild(b);
  });
  $("story-reply-form").hidden = mine;
  const viewers = $("story-viewers");
  viewers.hidden = !mine;
  if (mine) {
    const names = Object.keys(s.views || {});
    viewers.textContent = names.length ? `👁 ${names.length}: ${names.map(ctx.name).join(", ")}` : "👁 No views yet";
    const del = document.createElement("button");
    del.className = "link";
    del.textContent = " Delete";
    del.onclick = (e) => {
      e.stopPropagation();
      if (!confirm("Delete this story for everyone?")) return;
      for (const to of ctx.contacts()) ctx.send(to, { kind: "story-delete", sid: s.sid });
      save(load().filter((x) => x.sid !== s.sid));
      closeViewer();
      render();
    };
    viewers.appendChild(del);
  }
  if (!mine && !s.seen) {
    const all = load();
    const stored = all.find((x) => x.sid === s.sid);
    if (stored) { stored.seen = true; save(all); }
    s.seen = true;
    ctx.send(s.from, { kind: "story-view", sid: s.sid });
  }
  viewing.timer = setTimeout(() => step(1), s.image ? 6000 : 5000);
}

function step(d) {
  if (!viewing) return;
  viewing.i += d;
  if (viewing.i < 0) viewing.i = 0;
  if (viewing.i >= viewing.list.length) return closeViewer();
  show();
}

function closeViewer() {
  if (viewing) clearTimeout(viewing.timer);
  viewing = null;
  $("story-viewer").hidden = true;
  render();
}

function ago(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
}
