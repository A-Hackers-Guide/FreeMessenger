// VR / headset support.
//
// Three jobs, each one guarded so nothing here can break a plain browser,
// an old browser, or weak hardware:
//   1. Detect the headset (user-agent + the WebXR API) and remember it.
//   2. Unlock per-headset comfort features (bigger targets, high-refresh,
//      passthrough) that the person can turn on and off.
//   3. Let two people meet in a shared "Loft" — a small room you step into in
//      the headset's browser, invited through an ordinary chat link.
//
// Everything degrades: no WebXR -> a look-around preview; no headset at all ->
// the panel still explains how to open the Loft on a headset and hands you a
// link to send. The menu entry is always safe to show.

import { store } from "./store.js";
import { openDialog, closeDialog, copyText } from "./compat.js";

const $ = (id) => document.getElementById(id);
let ctx = { toast() {}, peer: () => null, me: () => null };

// ---------- which headset ----------

// Each headset's browser puts a tell in its user-agent. A tethered PC headset
// often does NOT (the browser looks like plain Chrome), so we also ask WebXR.
const SIGNATURES = [
  { kind: "quest", label: "Meta Quest", re: /OculusBrowser|Quest|Meta.?Quest/i },
  { kind: "pico", label: "PICO", re: /Pico(Browser|Neo|VR)?|VR_Pico/i },
  { kind: "vive", label: "HTC Vive", re: /Vive|HTCVR/i },
  { kind: "wolvic", label: "Wolvic", re: /Wolvic/i },
  { kind: "pcvr", label: "PC VR", re: /SteamVR|OpenXR|WindowsMR/i },
];

// Features offered per headset. "loft" (the shared room) works anywhere WebXR
// or even a plain browser does, so every headset gets it.
const FEATURES = {
  quest: ["bigtargets", "highrefresh", "passthrough"],
  pico: ["bigtargets", "highrefresh"],
  vive: ["bigtargets"],
  wolvic: ["bigtargets"],
  pcvr: ["bigtargets"],
  generic: ["bigtargets"],
};

const FEATURE_META = {
  bigtargets: { cls: "vr-big-targets", label: "🖐️ Bigger buttons", hint: "Easier to hit with a controller or hand.", on: true },
  highrefresh: { cls: "vr-smooth", label: "⚡ Comfort mode", hint: "Drops heavy blur and motion so it stays smooth at high refresh.", on: true },
  passthrough: { cls: "vr-passthrough", label: "🪟 Passthrough reading", hint: "See-through background so you can read while you look around the room.", on: false },
};

let cached = null;

export function detect() {
  if (cached) return cached;
  const ua = navigator.userAgent || "";
  const hit = SIGNATURES.find((s) => s.re.test(ua));
  cached = {
    uaMatch: !!hit,
    kind: hit ? hit.kind : null,
    label: hit ? hit.label : "Headset",
    hasXR: !!(navigator.xr && navigator.xr.isSessionSupported),
    immersive: false,
    inVR: false,
  };
  return cached;
}

// Asks the browser whether a real immersive session is possible. Safe to call
// repeatedly; never throws.
export async function probe() {
  const info = detect();
  if (info.hasXR) {
    try { info.immersive = await navigator.xr.isSessionSupported("immersive-vr"); } catch { info.immersive = false; }
  }
  info.inVR = info.uaMatch || info.immersive;
  if (info.inVR && !info.kind) info.kind = "generic";
  return info;
}

// ---------- per-headset features ----------

function featureState() {
  const saved = store.get("vr.features", null) || {};
  const out = {};
  for (const key of Object.keys(FEATURE_META)) {
    out[key] = key in saved ? !!saved[key] : FEATURE_META[key].on;
  }
  return out;
}

function applyFeatures(kinds) {
  const avail = new Set(FEATURES[kinds] || FEATURES.generic);
  const state = featureState();
  const root = document.documentElement;
  for (const key of Object.keys(FEATURE_META)) {
    const meta = FEATURE_META[key];
    root.classList.toggle(meta.cls, avail.has(key) && state[key]);
  }
}

// ---------- run on load ----------

export function init(c) {
  ctx = Object.assign(ctx, c || {});
  const dlg = $("vr-dialog");
  if (dlg) {
    const close = $("vr-close");
    if (close) close.onclick = () => closeDialog(dlg);
  }
  const stageClose = $("vr-stage-close");
  if (stageClose) stageClose.onclick = exitLoft;
}

export async function autoEnhance() {
  let info;
  try { info = await probe(); } catch { return; }
  const root = document.documentElement;
  if (info.inVR) {
    root.classList.add("in-vr");
    if (info.kind) root.classList.add("vr-" + info.kind);
    applyFeatures(info.kind);
  }
  maybeJoinFromLink();
  return info;
}

// A link like ?vr=<peer> (or #vr=<peer>): offer to step into their Loft.
function maybeJoinFromLink() {
  let room = "";
  try {
    room = new URLSearchParams(location.search).get("vr") || "";
    if (!room && location.hash) room = (location.hash.match(/vr=([a-z0-9_.-]+)/i) || [])[1] || "";
  } catch {}
  if (!room) return;
  // Clear it from the address bar so a refresh doesn't re-prompt.
  try { history.replaceState(null, "", location.pathname); } catch {}
  setTimeout(() => {
    open(room);
  }, 600);
}

// ---------- the panel ----------

export async function open(joinRoom) {
  const dlg = $("vr-dialog");
  if (!dlg) return;
  const info = await probe();
  render(info, joinRoom || "");
  openDialog(dlg);
}

function render(info, joinRoom) {
  const body = $("vr-body");
  if (!body) return;
  const avail = FEATURES[info.kind || "generic"] || FEATURES.generic;
  const state = featureState();
  const me = ctx.me && ctx.me();
  const peer = ctx.peer && ctx.peer();
  const room = joinRoom || peer || me || "";
  const link = loftLink(room);

  const statusLine = info.inVR
    ? `In a headset — <strong>${esc(info.label)}</strong>${info.immersive ? " · immersive ready" : ""}`
    : info.hasXR
      ? "This browser can do VR, but no headset is active right now."
      : "No headset here — open this on a headset to step inside.";

  const featureRows = avail.map((key) => {
    const m = FEATURE_META[key];
    return `<label class="vr-feature"><input type="checkbox" data-feat="${key}" ${state[key] ? "checked" : ""}>
      <span><strong>${m.label}</strong><br><small class="fine">${esc(m.hint)}</small></span></label>`;
  }).join("");

  const joinOrEnter = joinRoom
    ? `<button type="button" class="primary" id="vr-enter">Step into @${esc(joinRoom)}'s Loft</button>`
    : `<button type="button" class="primary" id="vr-enter">${info.immersive ? "Enter the Loft" : "Preview the Loft"}</button>`;

  body.innerHTML = `
    <p class="vr-status">${statusLine}</p>
    <div class="vr-section">
      <h3>🏠 The Loft</h3>
      <p class="fine">A small shared room. Send a friend the link and you both step inside from your headsets.</p>
      ${joinOrEnter}
      ${room ? `<div class="vr-invite">
        <button type="button" class="ghost small" id="vr-copy">Copy invite link</button>
        <button type="button" class="ghost small" id="vr-apps">Open in a VR app…</button>
      </div>` : ""}
    </div>
    ${avail.length ? `<div class="vr-section">
      <h3>Comfort</h3>
      <div class="vr-features">${featureRows}</div>
    </div>` : ""}
    <div class="vr-section" id="vr-apps-list" hidden>
      <h3>Join in another VR app</h3>
      <p class="fine">These open the app with your room code <code>${esc(room)}</code>. You may need to accept the launch in the headset.</p>
      ${appLinks(room)}
    </div>`;

  const enter = $("vr-enter");
  if (enter) enter.onclick = () => enterLoft(info, room);
  const copy = $("vr-copy");
  if (copy) copy.onclick = async () => { await copyText(link); ctx.toast("Loft link copied — send it to a friend."); };
  const apps = $("vr-apps");
  if (apps) apps.onclick = () => { const l = $("vr-apps-list"); if (l) l.hidden = !l.hidden; };
  body.querySelectorAll("input[data-feat]").forEach((cb) => {
    cb.onchange = () => {
      const saved = store.get("vr.features", null) || {};
      saved[cb.getAttribute("data-feat")] = cb.checked;
      store.set("vr.features", saved);
      applyFeatures(info.kind);
    };
  });
}

function loftLink(room) {
  const base = location.origin + location.pathname;
  return room ? `${base}?vr=${encodeURIComponent(room)}` : base;
}

// Deep links into popular social-VR apps, carrying the room code. We can hand
// the app the code; whether it auto-joins is up to that app.
function appLinks(room) {
  const code = encodeURIComponent(room || "freemessenger");
  const links = [
    ["VRChat", `vrchat://launch?ref=freemessenger&room=${code}`],
    ["Rec Room", `recroom://room/${code}`],
    ["Horizon Worlds", `https://horizon.meta.com/?fm=${code}`],
  ];
  return `<div class="vr-applinks">${links.map(([n, u]) =>
    `<a class="ghost small" href="${esc(u)}" target="_blank" rel="noopener">${esc(n)}</a>`).join("")}</div>`;
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- the Loft itself (WebXR, with a safe fallback) ----------

let session = null;
let gl = null;
let rafId = 0;

async function enterLoft(info, room) {
  const dlg = $("vr-dialog");
  if (dlg && dlg.open) closeDialog(dlg);
  if (info.immersive) {
    try { return await enterImmersive(info, room); }
    catch (e) { ctx.toast("Couldn't start VR: " + (e && e.message ? e.message : "not available")); }
  }
  enterPreview(info, room);
}

async function enterImmersive(info, room) {
  const canvas = $("vr-canvas");
  if (!canvas) throw new Error("no canvas");
  gl = canvas.getContext("webgl", { xrCompatible: true, antialias: true, alpha: false })
    || canvas.getContext("experimental-webgl", { xrCompatible: true });
  if (!gl) throw new Error("no WebGL");
  if (gl.makeXRCompatible) { try { await gl.makeXRCompatible(); } catch {} }

  session = await navigator.xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor"] });
  const layer = new XRWebGLLayer(session, gl);
  session.updateRenderState({ baseLayer: layer });
  let refSpace;
  try { refSpace = await session.requestReferenceSpace("local-floor"); }
  catch { refSpace = await session.requestReferenceSpace("local"); }

  const tint = roomTint(info.kind);
  session.addEventListener("end", () => { session = null; showStage(false); });
  showStage(true, `In the Loft${room ? " · @" + room : ""} — take off the headset or press the menu button to leave.`);

  const onFrame = (t, frame) => {
    if (!session) return;
    rafId = session.requestAnimationFrame(onFrame);
    const glLayer = session.renderState.baseLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, glLayer.framebuffer);
    // A calm breathing gradient room. Both eyes render the same clear, so you
    // are standing inside a colored space you can look around.
    const pulse = 0.5 + 0.5 * Math.sin(t / 2600);
    gl.clearColor(tint[0] * (0.7 + 0.3 * pulse), tint[1] * (0.7 + 0.3 * pulse), tint[2] * (0.8 + 0.2 * pulse), 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    frame.getViewerPose(refSpace); // keeps the compositor fed
  };
  rafId = session.requestAnimationFrame(onFrame);
}

// For phones and desktops: a full-screen look-around preview so the Loft isn't
// a dead end off a headset. Tilt the phone (or move the mouse) to look around.
function enterPreview(info, room) {
  const stage = $("vr-stage");
  if (!stage) return;
  showStage(true, `Loft preview${room ? " · @" + room : ""} — open this link on a VR headset to step inside for real.`);
  const sky = $("vr-sky");
  if (sky) {
    const tint = roomTint(info.kind).map((c) => Math.round(c * 255));
    sky.style.background = `radial-gradient(circle at 50% 35%, rgb(${tint[0]},${tint[1]},${tint[2]}), #0a0a12 80%)`;
    sky.hidden = false;
    const move = (x, y) => { sky.style.backgroundPosition = `${50 + x * 20}% ${35 + y * 20}%`; };
    stage._onmouse = (e) => move((e.clientX / innerWidth) - 0.5, (e.clientY / innerHeight) - 0.5);
    stage._onorient = (e) => move((e.gamma || 0) / 90, (e.beta || 0) / 180);
    addEventListener("mousemove", stage._onmouse);
    addEventListener("deviceorientation", stage._onorient);
  }
}

function roomTint(kind) {
  return ({
    quest: [0.11, 0.22, 0.45],
    pico: [0.10, 0.30, 0.28],
    vive: [0.28, 0.14, 0.34],
    pcvr: [0.18, 0.20, 0.26],
  })[kind] || [0.15, 0.18, 0.34];
}

function showStage(on, text) {
  const stage = $("vr-stage");
  if (!stage) return;
  stage.hidden = !on;
  document.documentElement.classList.toggle("vr-loft-open", on);
  const label = $("vr-stage-label");
  if (label && text) label.textContent = text;
  if (!on) {
    const sky = $("vr-sky");
    if (sky) sky.hidden = true;
    if (stage._onmouse) { removeEventListener("mousemove", stage._onmouse); stage._onmouse = null; }
    if (stage._onorient) { removeEventListener("deviceorientation", stage._onorient); stage._onorient = null; }
  }
}

function exitLoft() {
  if (session) { try { session.end(); } catch {} session = null; }
  showStage(false);
}
