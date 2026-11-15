// The Loft — FreeMessenger's shared hangout space.
//
// The Loft is the place people meet in 3D. Step in from a headset and you share
// a room with everyone else in the same chat: you see each other's heads and
// hands move in real time, and you can bat a shared ball around together. On a
// Quest it can run in *passthrough* so the room sits in your real space. No
// headset? You "cast" in — a flat window into the same room, so you can still
// hang out and watch from a phone or computer.
//
// Everything is guarded so nothing here can break a plain, old, or weak browser.
// No WebXR -> cast (a flat view). No WebGL at all -> a calm backdrop and the
// invite link still works. The menu entry and the invite are always safe.
//
// How people find each other: the Loft for a chat IS that chat. Pose and ball
// updates ride the normal messenger channel as ephemeral "loft" messages (never
// stored), addressed to the chat — so a group chat becomes a group hangout, a
// DM becomes a two-person room, all with the membership the chat already has.

import { store } from "./store.js";
import { openDialog, closeDialog, copyText } from "./compat.js";

const $ = (id) => document.getElementById(id);
let ctx = { toast() {}, peer: () => null, me: () => null, send: null, invite: null };

// ---------- which headset ----------

const SIGNATURES = [
  { kind: "quest", label: "Meta Quest", re: /OculusBrowser|Quest|Meta.?Quest/i },
  { kind: "pico", label: "PICO", re: /Pico(Browser|Neo|VR)?|VR_Pico/i },
  { kind: "vive", label: "HTC Vive", re: /Vive|HTCVR/i },
  { kind: "visionpro", label: "Apple Vision Pro", re: /Vision ?Pro|XROS|visionOS/i },
  { kind: "wolvic", label: "Wolvic", re: /Wolvic/i },
  { kind: "pcvr", label: "PC VR", re: /SteamVR|OpenXR|WindowsMR/i },
];

// Per-headset comfort toggles. The Loft itself works anywhere, so these are only
// polish for the people who have the hardware for them.
const FEATURES = {
  quest: ["bigtargets", "highrefresh", "passthrough"],
  pico: ["bigtargets", "highrefresh", "passthrough"],
  visionpro: ["bigtargets", "passthrough"],
  vive: ["bigtargets", "highrefresh"],
  wolvic: ["bigtargets"],
  pcvr: ["bigtargets"],
  generic: ["bigtargets"],
};

const FEATURE_META = {
  bigtargets: { cls: "vr-big-targets", label: "🖐️ Bigger buttons", hint: "Easier to hit with a controller or hand.", on: true },
  highrefresh: { cls: "vr-smooth", label: "⚡ Comfort mode", hint: "Drops heavy blur and motion so it stays smooth at high refresh.", on: true },
  passthrough: { cls: "vr-passthrough", label: "🪟 Passthrough reading", hint: "See-through background so you can read while you look around.", on: false },
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
    passthrough: false,
    inVR: false,
  };
  return cached;
}

// Ask the browser what it can really do. Safe to call repeatedly; never throws.
export async function probe() {
  const info = detect();
  if (info.hasXR) {
    try { info.immersive = await navigator.xr.isSessionSupported("immersive-vr"); } catch { info.immersive = false; }
    try { info.passthrough = await navigator.xr.isSessionSupported("immersive-ar"); } catch { info.passthrough = false; }
  }
  info.inVR = info.uaMatch || info.immersive || info.passthrough;
  if (info.inVR && !info.kind) info.kind = "generic";
  return info;
}

// ---------- per-headset features ----------

function featureState() {
  const saved = store.get("vr.features", null) || {};
  const out = {};
  for (const key of Object.keys(FEATURE_META)) out[key] = key in saved ? !!saved[key] : FEATURE_META[key].on;
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
  if (dlg) { const close = $("vr-close"); if (close) close.onclick = () => closeDialog(dlg); }
  const stageClose = $("vr-stage-close");
  if (stageClose) stageClose.onclick = exitLoft;
  // The headset-only button on the chat bar opens the Loft for the current chat.
  const callBtn = $("vr-call-btn");
  if (callBtn) callBtn.onclick = () => open(ctx.peer && ctx.peer());
}

export async function autoEnhance() {
  let info;
  try { info = await probe(); } catch { return; }
  const root = document.documentElement;
  if (info.inVR) {
    root.classList.add("in-vr");
    if (info.kind) root.classList.add("vr-" + info.kind);
    applyFeatures(info.kind);
    // Reveal the blue headset button beside the call buttons.
    const callBtn = $("vr-call-btn");
    if (callBtn) callBtn.hidden = false;
  }
  maybeJoinFromLink();
  return info;
}

// A link like ?vr=<peer> (or #vr=<peer>): step into their Loft on arrival.
function maybeJoinFromLink() {
  let room = "";
  try {
    room = new URLSearchParams(location.search).get("vr") || "";
    if (!room && location.hash) room = (location.hash.match(/vr=([a-z0-9_.-]+)/i) || [])[1] || "";
  } catch {}
  if (!room) return;
  try { history.replaceState(null, "", location.pathname); } catch {}
  setTimeout(() => open(room), 600);
}

// ---------- the panel ----------

export async function open(joinRoom) {
  const dlg = $("vr-dialog");
  if (!dlg) return;
  const info = await probe();
  render(info, typeof joinRoom === "string" ? joinRoom : "");
  openDialog(dlg);
}

function render(info, joinRoom) {
  const body = $("vr-body");
  if (!body) return;
  const avail = FEATURES[info.kind || "generic"] || FEATURES.generic;
  const state = featureState();
  const me = ctx.me && ctx.me();
  const peer = ctx.peer && ctx.peer();
  const room = joinRoom || peer || "";
  const link = loftLink(room);
  const named = /^[a-z0-9_]{3,20}$/i.test(room);

  const statusLine = info.inVR
    ? `In a headset — <strong>${esc(info.label)}</strong>${info.passthrough ? " · passthrough ready" : info.immersive ? " · immersive ready" : ""}`
    : info.hasXR
      ? "This browser can do VR, but no headset is active — you can still cast in to watch."
      : "No headset here — cast in to hang out, or send the invite to open it on a headset.";

  // Entry buttons differ by device. Headset: Enter (+ Passthrough if the device
  // can). No headset: Cast in (a flat window) — no "preview", you're really there.
  let entryButtons;
  if (info.inVR) {
    entryButtons = `<button type="button" class="primary" id="vr-enter">${joinRoom && named ? `Step into @${esc(joinRoom)}'s Loft` : "Enter the Loft"}</button>`;
    if (info.passthrough) entryButtons += `<button type="button" class="primary vr-pass-btn" id="vr-enter-pass">🪟 Loft Passthrough</button>`;
  } else {
    entryButtons = `<button type="button" class="primary" id="vr-cast">📺 Cast in &amp; watch</button>`;
  }

  const featureRows = avail.map((key) => {
    const m = FEATURE_META[key];
    return `<label class="vr-feature"><input type="checkbox" data-feat="${key}" ${state[key] ? "checked" : ""}>
      <span><strong>${m.label}</strong><br><small class="fine">${esc(m.hint)}</small></span></label>`;
  }).join("");

  body.innerHTML = `
    <p class="vr-status">${statusLine}</p>
    <div class="vr-section">
      <h3>🏠 The Loft</h3>
      <p class="fine">A shared room for everyone in this chat. Heads and hands move in real time, and there's a ball to bat around together.</p>
      <div class="vr-entry">${entryButtons}</div>
      <div class="vr-invite">
        ${ctx.invite && named ? `<button type="button" class="ghost small" id="vr-invite-chat">💬 Invite to the Loft</button>` : ""}
        <button type="button" class="ghost small" id="vr-copy">Copy invite link</button>
        <button type="button" class="ghost small" id="vr-apps">Open in a VR app…</button>
      </div>
    </div>
    ${info.inVR && avail.length ? `<div class="vr-section">
      <h3>Comfort</h3>
      <div class="vr-features">${featureRows}</div>
    </div>` : ""}
    <div class="vr-section" id="vr-apps-list" hidden>
      <h3>Join in another VR app</h3>
      <p class="fine">These hand the app your room code <code>${esc(room || "freemessenger")}</code>. Whether it auto-joins is up to that app.</p>
      ${appLinks(room)}
    </div>`;

  const bind = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  bind("vr-enter", () => enterLoft(info, room, false));
  bind("vr-enter-pass", () => enterLoft(info, room, true));
  bind("vr-cast", () => enterLoft(info, room, false));
  bind("vr-copy", async () => { await copyText(link); ctx.toast("Loft link copied — send it to a friend."); });
  bind("vr-apps", () => { const l = $("vr-apps-list"); if (l) l.hidden = !l.hidden; });
  bind("vr-invite-chat", () => {
    try { ctx.invite(`🥽 Come hang out in my Loft: ${link}`); ctx.toast("Invite sent."); closeDialog($("vr-dialog")); }
    catch { ctx.toast("Couldn't send the invite."); }
  });
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

// ===================== the shared room =====================

const EYE = [0, 1.6, 0];       // standing eye height for the cast camera
const GRAB_R = 0.28;           // how close a hand must be to grab the ball
const BALL_START = [0, 1.2, 0];

let loft = null;
// loft = { target, room, mode("xr"|"ar"|"cast"), ar, session, gl, prog, refSpace,
//          raf, localPose, peers:{name:{head,quat,l,r,seen,col}}, ball, ballOwner,
//          hands:{left,right}, selecting:Set, lastHand:{}, tint, yaw, pitch, handlers, me }

// ----- column-major 4x4 matrix math (matches WebGL / WebXR) -----
function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; }
  return o;
}
const translate = (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
const scaleM = (s) => new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]);
function fromQuat(q) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  return new Float32Array([1 - (yy + zz), xy + wz, xz - wy, 0, xy - wz, 1 - (xx + zz), yz + wx, 0, xz + wy, yz - wx, 1 - (xx + yy), 0, 0, 0, 0, 1]);
}
function rotX(a) { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]); }
function rotY(a) { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]); }
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
const model = (pos, quat, s) => mul(mul(translate(pos[0], pos[1], pos[2]), fromQuat(quat || [0, 0, 0, 1])), scaleM(s || 1));
function quatFromAngles(yaw, pitch) {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  return [cy * sp, sy * cp, -sy * sp, cy * cp];
}

// ----- geometry -----
function cubeVerts() {
  const h = 0.5, out = [];
  const face = [[-h, -h, h], [h, -h, h], [h, h, h], [-h, -h, h], [h, h, h], [-h, h, h]];
  const rots = [(v) => v, (v) => [-v[0], v[1], -v[2]], (v) => [v[2], v[1], -v[0]], (v) => [-v[2], v[1], v[0]], (v) => [v[0], v[2], -v[1]], (v) => [v[0], -v[2], v[1]]];
  for (const rf of rots) for (const v of face) { const r = rf(v); out.push(r[0], r[1], r[2]); }
  return out;
}
// A low-poly UV sphere so the ball reads as round.
function sphereVerts(seg) {
  const out = [], R = 0.5, P = Math.PI;
  const pt = (i, j) => { const u = i / seg * 2 * P, v = j / seg * P; return [R * Math.sin(v) * Math.cos(u), R * Math.cos(v), R * Math.sin(v) * Math.sin(u)]; };
  for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) {
    const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1);
    out.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  return out;
}

function buildScene(gl) {
  const vs = "attribute vec3 p;uniform mat4 mvp;void main(){gl_Position=mvp*vec4(p,1.0);}";
  const fs = "precision mediump float;uniform vec4 c;void main(){gl_FragColor=c;}";
  const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn("Loft shader:", gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn("Loft program link failed:", gl.getProgramInfoLog(prog)); return null; }
  const buf = (arr) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STATIC_DRAW); return b; };
  const grid = [];
  for (let i = -5; i <= 5; i++) { grid.push(i, 0, -5, i, 0, 5, -5, 0, i, 5, 0, i); }
  const cube = cubeVerts(), ball = sphereVerts(10);
  return {
    prog,
    a_p: gl.getAttribLocation(prog, "p"),
    u_mvp: gl.getUniformLocation(prog, "mvp"),
    u_c: gl.getUniformLocation(prog, "c"),
    grid: { buf: buf(grid), n: grid.length / 3, mode: gl.LINES },
    cube: { buf: buf(cube), n: cube.length / 3, mode: gl.TRIANGLES },
    ball: { buf: buf(ball), n: ball.length / 3, mode: gl.TRIANGLES },
  };
}

function drawObj(gl, g, geo, mvp, color) {
  gl.bindBuffer(gl.ARRAY_BUFFER, geo.buf);
  gl.enableVertexAttribArray(g.a_p);
  gl.vertexAttribPointer(g.a_p, 3, gl.FLOAT, false, 0, 0);
  gl.uniformMatrix4fv(g.u_mvp, false, mvp);
  gl.uniform4fv(g.u_c, color);
  gl.drawArrays(geo.mode, 0, geo.n);
}

// A stable, pleasant colour per person from their name.
function hashColor(name) {
  let h = 0; const s = String(name || "friend");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffff;
  const hue = h % 360, f = (n) => { const k = (n + hue / 30) % 12; return 0.55 - 0.32 * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [0.55 + f(0), 0.55 + f(8), 0.55 + f(4), 1];
}

function drawPerson(gl, g, vp, p) {
  const q = p.quat || [0, 0, 0, 1];
  drawObj(gl, g, g.cube, mul(vp, model(p.head, q, 0.26)), p.col);               // head
  const nose = mul(model(p.head, q, 1), translate(0, 0, -0.18));
  drawObj(gl, g, g.cube, mul(vp, mul(nose, scaleM(0.09))), [1, 0.96, 0.7, 1]);  // facing marker
  if (p.l) drawObj(gl, g, g.cube, mul(vp, model(p.l, null, 0.09)), p.col);      // hands
  if (p.r) drawObj(gl, g, g.cube, mul(vp, model(p.r, null, 0.09)), p.col);
}

function drawScene(gl, g, viewProj, drawSelf) {
  if (!g || !g.prog) return;
  gl.useProgram(g.prog);
  if (!loft.ar && !loft.env) drawObj(gl, g, g.grid, viewProj, [0.5, 0.6, 0.85, 1]);
  for (const name of Object.keys(loft.peers)) drawPerson(gl, g, viewProj, loft.peers[name]);
  if (drawSelf && loft.hands) {
    if (loft.hands.left) drawObj(gl, g, g.cube, mul(viewProj, model(loft.hands.left, null, 0.09)), [0.9, 0.9, 1, 1]);
    if (loft.hands.right) drawObj(gl, g, g.cube, mul(viewProj, model(loft.hands.right, null, 0.09)), [0.9, 0.9, 1, 1]);
  }
  if (loft.ball) drawObj(gl, g, g.ball, mul(viewProj, model(loft.ball.p, null, 0.3)), [1, 0.5, 0.35, 1]);
}

// ----- the real environment: a Horizon home scene loaded from a GLB -----
//
// A small in-house GLB reader (no three.js, so the old-browser promise holds).
// It only needs what our exporter writes: unlit textured triangle meshes with
// POSITION + TEXCOORD_0, u32 indices, node matrices, and PNG textures. Loaded
// lazily when you step in, so a plain chat never pays for it.

const ENV_FILE = "loft/spacestation.glb";
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function envUrl() {
  try { return new URL(ENV_FILE, location.origin + location.pathname.replace(/[^/]*$/, "")).href; }
  catch { return ENV_FILE; }
}

function buildEnvProgram(gl) {
  const vs = "attribute vec3 p;attribute vec2 uv;uniform mat4 mvp;varying vec2 vUv;void main(){vUv=uv;gl_Position=mvp*vec4(p,1.0);}";
  const fs = "precision mediump float;varying vec2 vUv;uniform sampler2D tex;uniform float useTex;uniform vec4 base;void main(){gl_FragColor=useTex>0.5?texture2D(tex,vUv):base;}";
  const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn("Env shader:", gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn("Env link:", gl.getProgramInfoLog(prog)); return null; }
  return {
    prog,
    a_p: gl.getAttribLocation(prog, "p"),
    a_uv: gl.getAttribLocation(prog, "uv"),
    u_mvp: gl.getUniformLocation(prog, "mvp"),
    u_tex: gl.getUniformLocation(prog, "tex"),
    u_useTex: gl.getUniformLocation(prog, "useTex"),
    u_base: gl.getUniformLocation(prog, "base"),
  };
}

async function loadEnv(gl, url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("env " + res.status);
  const buf = await res.arrayBuffer();
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB");
  const jlen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jlen)));
  const binStart = 20 + jlen + 8;
  const BV = json.bufferViews, AC = json.accessors;
  const view = (i) => { const v = BV[i]; return { off: binStart + (v.byteOffset || 0), len: v.byteLength }; };
  const acc = (ai, Ctor, comp) => { const a = AC[ai]; const v = view(a.bufferView); return new Ctor(buf, v.off + (a.byteOffset || 0), a.count * comp); };
  gl.getExtension("OES_element_index_uint");

  const texCache = {};
  const makeTex = (imgIndex) => {
    if (texCache[imgIndex] != null) return texCache[imgIndex];
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([190, 185, 180, 255]));
    const im = json.images[imgIndex], v = view(im.bufferView);
    const blob = new Blob([new Uint8Array(buf, v.off, v.len)], { type: im.mimeType || "image/png" });
    const u = URL.createObjectURL(blob), img = new Image();
    img.onload = () => {
      try {
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      } catch {} URL.revokeObjectURL(u);
    };
    img.src = u;
    texCache[imgIndex] = t;
    return t;
  };
  const mats = (json.materials || []).map((m) => {
    const pbr = m.pbrMetallicRoughness || {};
    let tex = null;
    if (pbr.baseColorTexture) { const src = json.textures[pbr.baseColorTexture.index].source; tex = makeTex(src); }
    return { tex, base: pbr.baseColorFactor || [1, 1, 1, 1] };
  });

  const prims = [];
  (json.nodes || []).forEach((n) => {
    if (n.mesh == null) return;
    for (const p of json.meshes[n.mesh].primitives) {
      const pos = acc(p.attributes.POSITION, Float32Array, 3);
      const posBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
      let uvBuf = null;
      if (p.attributes.TEXCOORD_0 != null) { const uv = acc(p.attributes.TEXCOORD_0, Float32Array, 2); uvBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf); gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW); }
      const idx = acc(p.indices, Uint32Array, 1);
      const idxBuf = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      const mat = p.material != null ? mats[p.material] : { tex: null, base: [0.72, 0.7, 0.66, 1] };
      prims.push({ posBuf, uvBuf, idxBuf, count: idx.length, matrix: new Float32Array(n.matrix || IDENTITY), tex: mat.tex, base: mat.base });
    }
  });
  return { prims };
}

function drawEnv(gl, prog, viewProj) {
  if (!loft || !loft.env || !prog || !prog.prog) return;
  gl.useProgram(prog.prog);
  gl.enableVertexAttribArray(prog.a_p);
  for (const pr of loft.env.prims) {
    gl.uniformMatrix4fv(prog.u_mvp, false, mul(viewProj, pr.matrix));
    gl.bindBuffer(gl.ARRAY_BUFFER, pr.posBuf);
    gl.vertexAttribPointer(prog.a_p, 3, gl.FLOAT, false, 0, 0);
    if (prog.a_uv >= 0) {
      if (pr.uvBuf) { gl.enableVertexAttribArray(prog.a_uv); gl.bindBuffer(gl.ARRAY_BUFFER, pr.uvBuf); gl.vertexAttribPointer(prog.a_uv, 2, gl.FLOAT, false, 0, 0); }
      else gl.disableVertexAttribArray(prog.a_uv);
    }
    if (pr.tex) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, pr.tex); gl.uniform1i(prog.u_tex, 0); gl.uniform1f(prog.u_useTex, 1); }
    else { gl.uniform1f(prog.u_useTex, 0); gl.uniform4fv(prog.u_base, pr.base); }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, pr.idxBuf);
    gl.drawElements(gl.TRIANGLES, pr.count, gl.UNSIGNED_INT, 0);
  }
  if (prog.a_uv >= 0) gl.disableVertexAttribArray(prog.a_uv);
}

// Kick off the environment download for the current gl context.
function beginEnv(gl) {
  loft.envProg = buildEnvProgram(gl);
  if (!loft.envProg) return;
  loadEnv(gl, envUrl()).then((e) => {
    if (loft) { loft.env = e; const l = $("vr-stage-label"); if (l && loft.mode === "cast") updatePresence(); }
  }).catch((e) => console.warn("Loft env:", e && e.message));
}

// ----- presence + ball sync over the messenger -----
export function onPeer(from, p) {
  if (!loft || !p || p.room !== loft.room || from === loft.me) return;
  if (p.op === "leave") { delete loft.peers[from]; updatePresence(); return; }
  if (p.op === "ball") {
    // Someone else owns the ball now (or reports its rest state). Adopt it.
    if (p.held || loft.ballOwner !== loft.me) {
      loft.ball = { p: p.p ? p.p.slice() : BALL_START.slice(), v: p.v ? p.v.slice() : [0, 0, 0] };
      loft.ballOwner = p.held ? from : null;
    }
    return;
  }
  if (p.op === "pose" || p.op === "join") {
    const prev = loft.peers[from] || {};
    loft.peers[from] = {
      head: Array.isArray(p.h) ? p.h : (prev.head || [0, 1.6, -1]),
      quat: p.q || prev.quat || [0, 0, 0, 1],
      l: p.l || null, r: p.r || null,
      col: prev.col || hashColor(from),
      seen: Date.now(),
    };
    // Answer a newcomer right away so they see us without waiting for the timer.
    if (p.op === "join" && ctx.send && loft.localPose) sendPose();
    updatePresence();
  }
}

function sendPose() {
  if (!loft || !ctx.send || !loft.localPose) return;
  const lp = loft.localPose;
  try { ctx.send(loft.target, { op: "pose", room: loft.room, h: lp.pos, q: lp.quat, l: lp.l || null, r: lp.r || null }); } catch {}
}

function startSync() {
  if (!loft || !ctx.send || !loft.target) return;
  try { ctx.send(loft.target, { op: "join", room: loft.room }); } catch {}
  loft.sendTimer = setInterval(() => {
    // forget anyone we haven't heard from in 8s
    let changed = false;
    for (const name of Object.keys(loft.peers)) if (Date.now() - loft.peers[name].seen > 8000) { delete loft.peers[name]; changed = true; }
    if (changed) updatePresence();
    sendPose();
    if (loft.ballOwner === loft.me && loft.ball) {
      try { ctx.send(loft.target, { op: "ball", room: loft.room, p: loft.ball.p, v: loft.ball.v, held: loft.ballHeld ? 1 : 0 }); } catch {}
    }
  }, 90);
}

function stopSync() {
  if (!loft) return;
  if (loft.sendTimer) clearInterval(loft.sendTimer);
  if (loft.target && ctx.send) try { ctx.send(loft.target, { op: "leave", room: loft.room }); } catch {}
}

function updatePresence() {
  const label = $("vr-stage-label");
  if (!label || !loft) return;
  const n = Object.keys(loft.peers).length;
  const who = n === 0 ? (loft.target ? "waiting for others…" : "solo — share the link to invite someone")
    : n === 1 ? `${"@" + Object.keys(loft.peers)[0]} is here`
      : `${n} people here`;
  const how = loft.mode === "cast" ? "Casting" : "In the Loft";
  label.textContent = `${how} — ${who}. Press Leave or take the headset off to go.`;
}

// ----- the shared ball -----
function stepBall(dt) {
  if (!loft || !loft.ball) return;
  const b = loft.ball;
  if (loft.ballHeld) return; // held = pinned to a hand, moved in updateHands
  // Only simulate if we own it, or nobody does (so it never freezes mid-air).
  if (loft.ballOwner && loft.ballOwner !== loft.me) return;
  b.v[1] -= 9.8 * dt;
  for (let i = 0; i < 3; i++) b.p[i] += b.v[i] * dt;
  const floor = 0.3 * 0.5; // ball radius
  if (b.p[1] < floor) { b.p[1] = floor; b.v[1] = -b.v[1] * 0.55; for (const i of [0, 2]) b.v[i] *= 0.82; if (Math.abs(b.v[1]) < 0.4) b.v[1] = 0; }
  for (const i of [0, 2]) { if (b.p[i] < -4.8) { b.p[i] = -4.8; b.v[i] = Math.abs(b.v[i]) * 0.6; } if (b.p[i] > 4.8) { b.p[i] = 4.8; b.v[i] = -Math.abs(b.v[i]) * 0.6; } }
}

// In a headset, a hand that's close while the trigger is down grabs the ball.
function handleGrab(dt) {
  if (!loft || !loft.ball || !loft.hands) return;
  const b = loft.ball;
  let grabbed = false;
  for (const side of ["left", "right"]) {
    const hp = loft.hands[side];
    if (!hp || !loft.selecting.has(side)) continue;
    const d = Math.hypot(hp[0] - b.p[0], hp[1] - b.p[1], hp[2] - b.p[2]);
    if (d < GRAB_R) {
      const last = loft.lastHand[side];
      b.v = last ? [(hp[0] - last[0]) / dt, (hp[1] - last[1]) / dt, (hp[2] - last[2]) / dt] : [0, 0, 0];
      b.p = hp.slice();
      loft.ballOwner = loft.me; loft.ballHeld = true; grabbed = true;
    }
  }
  if (!grabbed && loft.ballHeld) loft.ballHeld = false; // released: velocity (set above) carries it
  loft.lastHand = { left: loft.hands.left && loft.hands.left.slice(), right: loft.hands.right && loft.hands.right.slice() };
}

// ----- entering -----
async function enterLoft(info, roomPeer, wantPassthrough) {
  const dlg = $("vr-dialog");
  if (dlg && dlg.open) closeDialog(dlg);
  const me = ctx.me && ctx.me();
  // The room is this chat. A link-join targets that one person.
  const target = (typeof roomPeer === "string" && roomPeer) || (ctx.peer && ctx.peer()) || null;
  loft = {
    target, room: target || "solo", me: me || "me", mode: "cast", ar: false,
    peers: {}, ball: { p: BALL_START.slice(), v: [0, 0, 0] }, ballOwner: null, ballHeld: false,
    hands: null, selecting: new Set(), lastHand: {}, localPose: null,
    tint: roomTint(info.kind), yaw: 0, pitch: 0, handlers: [],
  };
  showStage(true, "Entering the Loft…");
  const ar = wantPassthrough && info.passthrough;
  if (info.immersive || info.passthrough) {
    try { await enterImmersive(ar); startSync(); updatePresence(); return; }
    catch (e) { ctx.toast("Couldn't start VR: " + (e && e.message ? e.message : "not available")); }
  }
  enterCast();
  startSync();
  updatePresence();
}

async function enterImmersive(ar) {
  const canvas = $("vr-canvas");
  if (!canvas) throw new Error("no canvas");
  const gl = canvas.getContext("webgl", { xrCompatible: true, antialias: true, alpha: true })
    || canvas.getContext("experimental-webgl", { xrCompatible: true });
  if (!gl) throw new Error("no WebGL");
  if (gl.makeXRCompatible) { try { await gl.makeXRCompatible(); } catch {} }
  const mode = ar ? "immersive-ar" : "immersive-vr";
  const session = await navigator.xr.requestSession(mode, { optionalFeatures: ["local-floor", "hand-tracking"] });
  session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl), depthFar: 20000 });
  let refSpace;
  try { refSpace = await session.requestReferenceSpace("local-floor"); }
  catch { refSpace = await session.requestReferenceSpace("local"); }
  const g = buildScene(gl);
  gl.enable(gl.DEPTH_TEST);
  loft.mode = ar ? "ar" : "xr"; loft.ar = ar; loft.session = session; loft.gl = gl; loft.prog = g; loft.refSpace = refSpace;
  beginEnv(gl);
  session.addEventListener("end", () => exitLoft());
  // Trigger press/release = grab/throw.
  const which = (e) => (e.inputSource && e.inputSource.handedness === "left") ? "left" : "right";
  const onStart = (e) => loft.selecting.add(which(e));
  const onEnd = (e) => loft.selecting.delete(which(e));
  session.addEventListener("selectstart", onStart);
  session.addEventListener("selectend", onEnd);

  let last = 0;
  const onFrame = (t, frame) => {
    if (!loft || loft.session !== session) return;
    loft.raf = session.requestAnimationFrame(onFrame);
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 0.016; last = t;
    const pose = frame.getViewerPose(refSpace);
    const glLayer = session.renderState.baseLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, glLayer.framebuffer);
    if (ar) gl.clearColor(0, 0, 0, 0); else { const c = loft.tint; gl.clearColor(c[0], c[1], c[2], 1); }
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!pose) return;
    // hands
    const hands = { left: null, right: null };
    for (const src of session.inputSources) {
      if (!src.gripSpace || !src.handedness) continue;
      const hp = frame.getPose(src.gripSpace, refSpace);
      if (hp) hands[src.handedness] = [hp.transform.position.x, hp.transform.position.y, hp.transform.position.z];
    }
    loft.hands = hands;
    const p = pose.transform.position, o = pose.transform.orientation;
    loft.localPose = { pos: [p.x, p.y, p.z], quat: [o.x, o.y, o.z, o.w], l: hands.left, r: hands.right };
    handleGrab(dt); stepBall(dt);
    for (const view of pose.views) {
      const vp = glLayer.getViewport(view);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);
      const vpMat = mul(view.projectionMatrix, view.transform.inverse.matrix);
      drawEnv(gl, loft.envProg, vpMat);
      drawScene(gl, g, vpMat, false);
    }
  };
  loft.raf = session.requestAnimationFrame(onFrame);
}

// Casting: a flat window into the same room, steered by the mouse or by tilting
// the phone. You appear to everyone else as a floating head, so you're really
// there — just watching from a screen instead of a headset.
function enterCast() {
  const canvas = $("vr-canvas"), stage = $("vr-stage");
  if (!canvas || !stage) return;
  const gl = canvas.getContext("webgl", { antialias: true }) || canvas.getContext("experimental-webgl");
  const g = gl && buildScene(gl);
  if (!gl || !g) {
    const sky = $("vr-sky");
    if (sky) { const t = loft.tint.map((c) => Math.round(c * 255)); sky.style.background = `radial-gradient(circle at 50% 40%, rgb(${t[0]},${t[1]},${t[2]}), #0a0a12 80%)`; sky.hidden = false; }
    return;
  }
  gl.enable(gl.DEPTH_TEST);
  loft.mode = "cast"; loft.gl = gl; loft.prog = g;
  beginEnv(gl);
  const resize = () => { canvas.width = stage.clientWidth || innerWidth; canvas.height = stage.clientHeight || innerHeight; };
  resize();
  const onMove = (x, y) => { loft.yaw = -x * Math.PI; loft.pitch = Math.max(-1.2, Math.min(1.2, -y * 1.2)); };
  const mouse = (e) => onMove((e.clientX / innerWidth) - 0.5, (e.clientY / innerHeight) - 0.5);
  const orient = (e) => onMove((e.gamma || 0) / 90, (e.beta || 0) / 180 - 0.25);
  addEventListener("mousemove", mouse); addEventListener("deviceorientation", orient); addEventListener("resize", resize);
  loft.handlers = [["mousemove", mouse], ["deviceorientation", orient], ["resize", resize]];

  let last = 0;
  const tick = (t) => {
    if (!loft || loft.mode !== "cast") return;
    loft.raf = requestAnimationFrame(tick);
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 0.016; last = t;
    const quat = quatFromAngles(loft.yaw, loft.pitch);
    loft.localPose = { pos: EYE.slice(), quat, l: null, r: null };
    stepBall(dt);
    gl.viewport(0, 0, canvas.width, canvas.height);
    const c = loft.tint; gl.clearColor(c[0], c[1], c[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const proj = perspective(1.1, (canvas.width || 1) / (canvas.height || 1), 0.1, 20000);
    const viewM = mul(mul(rotX(-loft.pitch), rotY(-loft.yaw)), translate(-EYE[0], -EYE[1], -EYE[2]));
    const vpMat = mul(proj, viewM);
    drawEnv(gl, loft.envProg, vpMat);
    drawScene(gl, g, vpMat, false);
  };
  loft.raf = requestAnimationFrame(tick);
}

function roomTint(kind) {
  return ({
    quest: [0.11, 0.22, 0.45], pico: [0.10, 0.30, 0.28], visionpro: [0.14, 0.14, 0.2],
    vive: [0.28, 0.14, 0.34], pcvr: [0.18, 0.20, 0.26],
  })[kind] || [0.15, 0.18, 0.34];
}

function showStage(on, text) {
  const stage = $("vr-stage");
  if (!stage) return;
  stage.hidden = !on;
  document.documentElement.classList.toggle("vr-loft-open", on);
  const label = $("vr-stage-label");
  if (label && text) label.textContent = text;
  if (!on) { const sky = $("vr-sky"); if (sky) sky.hidden = true; }
}

function exitLoft() {
  if (!loft) { showStage(false); return; }
  stopSync();
  if ((loft.mode === "cast") && loft.raf) cancelAnimationFrame(loft.raf);
  for (const [ev, fn] of (loft.handlers || [])) removeEventListener(ev, fn);
  if (loft.session) { try { loft.session.end(); } catch {} }
  loft = null;
  showStage(false);
}
