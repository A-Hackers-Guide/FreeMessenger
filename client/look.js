// How FreeMessenger looks: a color, gradient or picture for each bar, a
// background and an animation for each chat, an accent color, and ready-made
// themes. All of it stays in this browser; pictures are kept in IndexedDB.

import { files } from "./store.js";
import { openDialog, closeDialog } from "./compat.js";
import * as Bgfx from "./bgfx.js";

const $ = (id) => document.getElementById(id);

export const BARS = [
  ["side", "Top bar over your chats", "#sidebar > .bar"],
  ["list", "Chat list", "#sidebar"],
  ["head", "Top bar in a chat", "#convo > .bar"],
  ["composer", "Message bar", "#send-form"],
];

// Live wallpapers first (drawn on the graphics chip), then the lighter CSS ones.
export const ANIMATIONS = (Bgfx.supported() ? Bgfx.SCENES : []).concat([
  ["none", "None"], ["aurora", "Aurora"], ["bubbles", "Bubbles"], ["stars", "Stars"], ["snow", "Snow"],
  ["hearts", "Hearts"], ["waves", "Waves"], ["rain", "Rain"], ["confetti", "Confetti"],
  ["fireflies", "Fireflies"], ["petals", "Falling petals"], ["balloons", "Balloons"], ["sparkles", "Sparkles"],
  ["lava", "Lava lamp"], ["matrix", "Matrix"], ["northern", "Northern lights"],
]);

// Fonts already on people's devices (no downloads, so nothing to track you).
export const FONTS = [
  ["system", "Standard", ""],
  ["rounded", "Rounded", 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Nunito", "Varela Round", system-ui, sans-serif'],
  ["serif", "Serif", 'ui-serif, Georgia, "Times New Roman", serif'],
  ["elegant", "Elegant", 'Didot, "Bodoni 72", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif'],
  ["mono", "Typewriter", 'ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace'],
  ["playful", "Playful", '"Comic Sans MS", "Chalkboard SE", "Comic Neue", "Marker Felt", cursive, sans-serif'],
  ["condensed", "Narrow", '"Avenir Next Condensed", "Arial Narrow", "Roboto Condensed", "Helvetica Neue", sans-serif'],
];

export const BUBBLES = [
  ["round", "Round"], ["soft", "Soft corners"], ["pill", "Pill"], ["square", "Square"], ["leaf", "Leaf"], ["outline", "Outline"],
];

const g = (c1, c2, angle = 135, text = "#ffffff") => ({ type: "gradient", c1, c2, angle, text });
const c = (c1, text) => ({ type: "color", c1, text });

export const PRESETS = {
  default: ["Standard", {}],
  ocean: ["Ocean", { accent: "#0284c7", bars: { side: g("#0ea5e9", "#2563eb"), head: g("#0ea5e9", "#2563eb"), composer: c("#e0f2fe", "#0c4a6e") }, chat: g("#e0f2fe", "#bfdbfe", 180, ""), anim: "bubbles" }],
  sunset: ["Sunset", { accent: "#ea580c", bars: { side: g("#f97316", "#db2777"), head: g("#f97316", "#db2777"), composer: c("#fff1e6", "#7c2d12") }, chat: g("#fed7aa", "#fbcfe8", 160, ""), anim: "aurora" }],
  forest: ["Forest", { accent: "#15803d", bars: { side: g("#166534", "#15803d"), head: g("#166534", "#15803d"), composer: c("#ecfdf5", "#14532d") }, chat: g("#dcfce7", "#bbf7d0", 180, ""), anim: "none" }],
  neon: ["Neon night", { accent: "#d946ef", bars: { side: g("#0f0c29", "#302b63"), head: g("#0f0c29", "#302b63"), composer: c("#18122b", "#f0abfc"), list: c("#120f24", "#e9d5ff") }, chat: g("#0f0c29", "#24243e", 180, ""), anim: "stars" }],
  candy: ["Candy", { accent: "#ec4899", bars: { side: g("#f472b6", "#a78bfa"), head: g("#f472b6", "#a78bfa"), composer: c("#fdf2f8", "#831843") }, chat: g("#fce7f3", "#ede9fe", 135, ""), anim: "hearts" }],
  midnight: ["Midnight", { accent: "#60a5fa", bars: { side: c("#0b1220", "#e2e8f0"), head: c("#0b1220", "#e2e8f0"), composer: c("#0b1220", "#e2e8f0"), list: c("#0f172a", "#e2e8f0") }, chat: g("#0f172a", "#1e293b", 180, ""), anim: "snow" }],
  rainbow: ["Rainbow", { accent: "#7c3aed", bars: { side: g("#ef4444", "#8b5cf6", 90), head: g("#f59e0b", "#06b6d4", 90), composer: g("#22c55e", "#3b82f6", 90) }, chat: g("#fef9c3", "#e0e7ff", 135, ""), anim: "confetti" }],
};

// ---------- turning a style into CSS ----------

const urls = new Map();
async function pictureUrl(key) {
  if (urls.has(key)) return urls.get(key);
  const blob = await files.get(key);
  const url = blob ? URL.createObjectURL(blob) : null;
  urls.set(key, url);
  return url;
}
export function forgetPicture(key) {
  const url = urls.get(key);
  if (url) URL.revokeObjectURL(url);
  urls.delete(key);
}

export async function background(style, key) {
  if (!style || style.type === "none" || !style.type) return "";
  if (style.type === "color") return style.c1 || "";
  if (style.type === "gradient") return `linear-gradient(${Number(style.angle) || 0}deg, ${style.c1 || "#2f6fed"}, ${style.c2 || "#7c4dff"})`;
  if (style.type === "picture") {
    const url = await pictureUrl(key);
    return url ? `url("${url}") center / cover no-repeat` : "";
  }
  return "";
}

async function paint(el, style, key) {
  if (!el) return;
  const bg = await background(style, key);
  el.style.background = bg;
  const text = style && style.type && style.type !== "none" && style.text;
  el.style.color = text || "";
  if (text) el.style.setProperty("--bar-icon", text); else el.style.removeProperty("--bar-icon");
  el.classList.toggle("styled", !!bg);
}

// The whole app: accent color and every bar.
export async function applyLook(look) {
  const root = document.documentElement;
  const font = FONTS.find((f) => f[0] === look.font);
  if (font && font[2]) root.style.setProperty("--font", font[2]); else root.style.removeProperty("--font");
  root.setAttribute("data-bubble", look.bubble || "round");
  for (const [k, v] of [["--mine", look.mine], ["--theirs", look.theirs]]) {
    if (v) {
      root.style.setProperty(k, v);
      root.style.setProperty(k + "-text", readable(v));
    } else {
      root.style.removeProperty(k + "-text");
    }
  }
  if (!look.theirs) root.style.removeProperty("--theirs");
  if (look.accent) {
    root.style.setProperty("--accent", look.accent);
    if (!look.mine) { root.style.setProperty("--mine", look.accent); root.style.setProperty("--mine-text", readable(look.accent)); }
  } else {
    root.style.removeProperty("--accent");
    if (!look.mine) root.style.removeProperty("--mine");
  }
  for (const [slot, , selector] of BARS) await paint(document.querySelector(selector), (look.bars || {})[slot], "ui:" + slot);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = look.accent || "#2f6fed";
}

// One chat's background: its own if it has one, otherwise the default.
export async function applyChat(chatLook, look) {
  const layer = $("chat-bg");
  const own = chatLook && chatLook.bg && chatLook.bg.type && chatLook.bg.type !== "none";
  const style = own ? chatLook.bg : look.chat;
  const key = own ? "ui:chat:" + chatLook.key : "ui:chat";
  layer.style.background = await background(style, key);
  const anim = chatLook && chatLook.anim && chatLook.anim !== "default" ? chatLook.anim : look.anim || "none";
  const scene = Bgfx.isScene(anim);
  if (scene) {
    layer.dataset.anim = anim;
    if (!layer.querySelector("canvas.bgfx")) layer.textContent = "";
    if (!Bgfx.start(layer, anim)) layer.dataset.anim = "aurora"; // no WebGL here: a CSS look instead
    layer.classList.toggle("dark-bg", !Bgfx.LIGHT_SCENES.has(anim));
    return;
  }
  Bgfx.stop();
  if (layer.dataset.anim !== anim) {
    layer.dataset.anim = anim;
    layer.textContent = "";
    // Bubbles, hearts and confetti are separate floating pieces.
    const pieces = {
      bubbles: ["", 16], hearts: ["❤️💖💕💗💘", 14], confetti: ["", 28], fireflies: ["", 22], petals: ["🌸🌺💮🌸", 16],
      balloons: ["🎈🎈🎈🎉", 12], sparkles: ["✨⭐💫🌟", 20], matrix: ["", 22],
    }[anim];
    if (pieces) {
      const emoji = Array.from(pieces[0]);
      for (let i = 0; i < pieces[1]; i++) {
        const s = document.createElement("span");
        s.className = "fx";
        if (emoji.length) s.textContent = emoji[i % emoji.length];
        s.style.left = Math.round(Math.random() * 96) + "%";
        s.style.animationDelay = (-Math.random() * 14).toFixed(1) + "s";
        s.style.animationDuration = (8 + Math.random() * 10).toFixed(1) + "s";
        const size = 10 + Math.round(Math.random() * 30);
        s.style.setProperty("--size", size + "px");
        if (anim === "confetti") s.style.setProperty("--hue", Math.round(Math.random() * 360));
        if (anim === "sparkles" || anim === "fireflies") s.style.top = Math.round(Math.random() * 92) + "%";
        if (anim === "matrix") s.textContent = Array.from({ length: 14 }, () => String.fromCharCode(0x30a0 + Math.floor(Math.random() * 96))).join("\n");
        layer.appendChild(s);
      }
    }
  }
  layer.classList.toggle("dark-bg", isDark(style));
}

// Black or white text, whichever reads better on that color.
function readable(hex) {
  const h = String(hex || "").replace("#", "");
  if (h.length !== 6) return "#ffffff";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#15171c" : "#ffffff";
}

function isDark(style) {
  if (!style || !style.c1 || style.type === "picture" || style.type === "none") return false;
  const hex = (style.c1 || "").replace("#", "");
  if (hex.length !== 6) return false;
  const [r, gg, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (r * 299 + gg * 587 + b * 114) / 1000 < 110;
}

// ---------- the "customize" dialog ----------

let editing = null;

export function editStyle({ title, style, key, withText, withAnim, anim, onChange }) {
  editing = { style: Object.assign({ type: "none", c1: "#2f6fed", c2: "#7c4dff", angle: 135, text: "" }, style), key, anim: anim || "default", onChange, picture: null };
  $("look-title").textContent = title;
  $("look-type").value = editing.style.type;
  $("look-c1").value = editing.style.c1;
  $("look-c2").value = editing.style.c2;
  $("look-angle").value = editing.style.angle;
  $("look-text-on").checked = !!editing.style.text;
  $("look-text").value = editing.style.text || "#ffffff";
  $("look-text-row").hidden = !withText;
  $("look-anim-row").hidden = !withAnim;
  const sel = $("look-anim");
  sel.textContent = "";
  for (const [v, label] of [["default", "Same as all chats"], ...ANIMATIONS]) {
    if (v === "default" && withAnim === "global") continue;
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = withAnim === "global" && editing.anim === "default" ? "none" : editing.anim;
  showFields();
  preview();
  openDialog($("look-dialog"));
}

function showFields() {
  const t = $("look-type").value;
  $("look-c1-row").hidden = t !== "color" && t !== "gradient";
  $("look-c2-row").hidden = $("look-angle-row").hidden = t !== "gradient";
  $("look-pic-row").hidden = t !== "picture";
}

function readForm() {
  const s = editing.style;
  s.type = $("look-type").value;
  s.c1 = $("look-c1").value;
  s.c2 = $("look-c2").value;
  s.angle = Number($("look-angle").value);
  s.text = $("look-text-on").checked ? $("look-text").value : "";
  editing.anim = $("look-anim").value;
}

async function preview() {
  readForm();
  const box = $("look-preview");
  const s = editing.style;
  const bg = s.type === "picture" && editing.picture ? `url("${editing.picture}") center / cover no-repeat` : await background(s, editing.key);
  box.style.background = bg || "var(--bg)";
  box.style.color = s.text || "";
}

["look-type", "look-c1", "look-c2", "look-angle", "look-text-on", "look-text", "look-anim"].forEach((id) => {
  $(id).addEventListener("input", () => { showFields(); preview(); });
});

$("look-pic-btn").onclick = () => $("look-pic").click();
$("look-pic").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (!/^image\//.test(file.type)) return;
  const blob = await shrink(file, 1920);
  await files.put(editing.key, blob);
  forgetPicture(editing.key);
  editing.picture = URL.createObjectURL(blob);
  $("look-type").value = "picture";
  showFields();
  preview();
};

$("look-reset").onclick = () => {
  $("look-type").value = "none";
  $("look-text-on").checked = false;
  if (!$("look-anim-row").hidden) $("look-anim").value = $("look-anim").options[0].value;
  showFields();
  preview();
};

$("look-done").onclick = () => {
  readForm();
  closeDialog($("look-dialog"));
  const s = editing.style;
  const out = s.type === "none" ? { type: "none" } : { type: s.type, c1: s.c1, c2: s.c2, angle: s.angle, text: s.text };
  editing.onChange(out, editing.anim);
};

// Pictures are made smaller so they don't fill the browser's storage.
export function shrink(file, side, type = "image/jpeg", quality = 0.85) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, side / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      if (canvas.toBlob) canvas.toBlob((b) => resolve(b || file), type, quality);
      else resolve(file);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

// A square picture as a data: URL, for profile pictures.
export function squareDataUrl(file, side, maxBytes) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(img.width, img.height);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = side;
      canvas.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, side, side);
      URL.revokeObjectURL(url);
      for (const q of [0.85, 0.7, 0.55, 0.4]) {
        const data = canvas.toDataURL("image/jpeg", q);
        if (data.length <= maxBytes) return resolve(data);
      }
      reject(new Error("That picture is too detailed. Try another one."));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That isn't a picture this browser can open.")); };
    img.src = url;
  });
}
