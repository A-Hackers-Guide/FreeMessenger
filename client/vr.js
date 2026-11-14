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

// ---------- the Loft: a shared WebXR room with head-pose sync ----------
//
// Both people enter the same room (named after one of them). Each sends its
// head position and facing to the other a few times a second over the normal
// messenger channel (ephemeral, so nothing is stored), and draws the other as
// an avatar that moves and turns in real time. Off a headset you get the same
// room as a look-around preview, so you can still meet.

const EYE = [0, 1.6, 0]; // standing eye height, for the preview camera

let loft = null; // { peer, room, mode, session, gl, prog, geo, refSpace, raf,
                 //   localPose, remote, sendTimer, tint, yaw, pitch, handlers }

// ----- tiny column-major 4x4 matrix math (matches WebGL / WebXR) -----
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
// A facing quaternion from look angles (yaw about Y, then pitch about X).
function quatFromAngles(yaw, pitch) {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  return [cy * sp, sy * cp, -sy * sp, cy * cp];
}

// ----- WebGL scene (floor grid + avatar cubes) -----
function buildScene(gl) {
  const vs = "attribute vec3 p;uniform mat4 mvp;void main(){gl_Position=mvp*vec4(p,1.0);}";
  const fs = "precision mediump float;uniform vec4 c;void main(){gl_FragColor=c;}";
  const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  const buf = (arr) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STATIC_DRAW); return b; };
  // floor grid lines, 10m square at 1m spacing
  const grid = [];
  for (let i = -5; i <= 5; i++) { grid.push(i, 0, -5, i, 0, 5, -5, 0, i, 5, 0, i); }
  // unit cube (36 verts), centered
  const h = 0.5, cube = [];
  const faces = [[[-h, -h, h], [h, -h, h], [h, h, h], [-h, -h, h], [h, h, h], [-h, h, h]]];
  // build all six faces by rotating the +z face
  const rots = [(v) => v, (v) => [-v[0], v[1], -v[2]], (v) => [v[2], v[1], -v[0]], (v) => [-v[2], v[1], v[0]], (v) => [v[0], v[2], -v[1]], (v) => [v[0], -v[2], v[1]]];
  for (const rf of rots) for (const v of faces[0]) { const r = rf(v); cube.push(r[0], r[1], r[2]); }
  return {
    prog,
    a_p: gl.getAttribLocation(prog, "p"),
    u_mvp: gl.getUniformLocation(prog, "mvp"),
    u_c: gl.getUniformLocation(prog, "c"),
    grid: { buf: buf(grid), n: grid.length / 3, mode: gl.LINES },
    cube: { buf: buf(cube), n: cube.length / 3, mode: gl.TRIANGLES },
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

function drawScene(gl, g, viewProj) {
  gl.useProgram(g.prog);
  drawObj(gl, g, g.grid, viewProj, [0.5, 0.6, 0.85, 1]);
  const rp = loft && loft.remote && loft.remote.pos;
  if (rp) {
    const q = loft.remote.quat || [0, 0, 0, 1];
    drawObj(gl, g, g.cube, mul(viewProj, model(rp, q, 0.26)), [1, 0.62, 0.2, 1]); // head
    // a brighter marker just in front of the face, so you can see which way they look
    const nose = mul(model(rp, q, 1), translate(0, 0, -0.18));
    drawObj(gl, g, g.cube, mul(viewProj, mul(nose, scaleM(0.09))), [1, 0.95, 0.6, 1]);
  }
}

// ----- pose sync over the messenger -----
export function onPeer(from, p) {
  if (!loft || !loft.peer || from !== loft.peer || p.room !== loft.room) return;
  if (p.op === "leave") { loft.remote = null; updatePresence(); return; }
  if (p.op === "pose" || p.op === "join") {
    if (Array.isArray(p.p)) loft.remote = { pos: p.p, quat: p.q || [0, 0, 0, 1], seen: Date.now() };
    if (p.op === "join" && ctx.send && loft.localPose) ctx.send(from, { op: "pose", room: loft.room, p: loft.localPose.pos, q: loft.localPose.quat });
    updatePresence();
  }
}

function startSync(peer, room) {
  if (!peer || !ctx.send) return;
  loft.peer = peer; loft.room = room;
  ctx.send(peer, { op: "join", room });
  loft.sendTimer = setInterval(() => {
    // drop a peer we haven't heard from in 8s
    if (loft.remote && Date.now() - loft.remote.seen > 8000) { loft.remote = null; updatePresence(); }
    if (loft.localPose) ctx.send(peer, { op: "pose", room, p: loft.localPose.pos, q: loft.localPose.quat });
  }, 120);
}

function stopSync() {
  if (!loft) return;
  if (loft.sendTimer) clearInterval(loft.sendTimer);
  if (loft.peer && ctx.send) try { ctx.send(loft.peer, { op: "leave", room: loft.room }); } catch {}
}

function updatePresence() {
  const label = $("vr-stage-label");
  if (!label || !loft) return;
  const who = loft.peer ? "@" + loft.peer : "";
  const here = loft.remote ? `${who} is here` : (loft.peer ? `waiting for ${who}…` : "solo");
  label.textContent = `In the Loft — ${here}. Take off the headset or press Leave to go.`;
}

// ----- entering -----
async function enterLoft(info, roomPeer) {
  const dlg = $("vr-dialog");
  if (dlg && dlg.open) closeDialog(dlg);
  const me = ctx.me && ctx.me();
  const peer = roomPeer && roomPeer !== me && /^[a-z0-9_]{3,20}$/.test(roomPeer) ? roomPeer : null;
  const room = [me || "me", peer || "solo"].sort().join("~");
  loft = { peer, room, tint: roomTint(info.kind), remote: null, localPose: null, yaw: 0, pitch: 0, handlers: [] };
  showStage(true, "Entering the Loft…");
  if (info.immersive) {
    try { await enterImmersive(); startSync(peer, room); updatePresence(); return; }
    catch (e) { ctx.toast("Couldn't start VR: " + (e && e.message ? e.message : "not available")); }
  }
  enterPreview();
  startSync(peer, room);
  updatePresence();
}

async function enterImmersive() {
  const canvas = $("vr-canvas");
  if (!canvas) throw new Error("no canvas");
  const gl = canvas.getContext("webgl", { xrCompatible: true, antialias: true })
    || canvas.getContext("experimental-webgl", { xrCompatible: true });
  if (!gl) throw new Error("no WebGL");
  if (gl.makeXRCompatible) { try { await gl.makeXRCompatible(); } catch {} }
  const session = await navigator.xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor"] });
  session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
  let refSpace;
  try { refSpace = await session.requestReferenceSpace("local-floor"); }
  catch { refSpace = await session.requestReferenceSpace("local"); }
  const g = buildScene(gl);
  gl.enable(gl.DEPTH_TEST);
  loft.mode = "xr"; loft.session = session; loft.gl = gl; loft.prog = g; loft.refSpace = refSpace;
  session.addEventListener("end", () => exitLoft());

  const onFrame = (t, frame) => {
    if (!loft || loft.session !== session) return;
    loft.raf = session.requestAnimationFrame(onFrame);
    const pose = frame.getViewerPose(refSpace);
    const glLayer = session.renderState.baseLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, glLayer.framebuffer);
    const tint = loft.tint;
    gl.clearColor(tint[0], tint[1], tint[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!pose) return;
    const p = pose.transform.position, o = pose.transform.orientation;
    loft.localPose = { pos: [p.x, p.y, p.z], quat: [o.x, o.y, o.z, o.w] };
    for (const view of pose.views) {
      const vp = glLayer.getViewport(view);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);
      drawScene(gl, g, mul(view.projectionMatrix, view.transform.inverse.matrix));
    }
  };
  loft.raf = session.requestAnimationFrame(onFrame);
}

// Off a headset: the same room, with a camera you steer by moving the mouse or
// tilting the phone. Your facing is sent to the headset peer so they see you turn.
function enterPreview() {
  const canvas = $("vr-canvas");
  const stage = $("vr-stage");
  if (!canvas || !stage) return;
  const gl = canvas.getContext("webgl", { antialias: true }) || canvas.getContext("experimental-webgl");
  if (!gl) { // no WebGL at all: fall back to the CSS backdrop
    const sky = $("vr-sky");
    if (sky) { const t = loft.tint.map((c) => Math.round(c * 255)); sky.style.background = `radial-gradient(circle at 50% 40%, rgb(${t[0]},${t[1]},${t[2]}), #0a0a12 80%)`; sky.hidden = false; }
    return;
  }
  const g = buildScene(gl);
  gl.enable(gl.DEPTH_TEST);
  loft.mode = "preview"; loft.gl = gl; loft.prog = g;
  const resize = () => { canvas.width = stage.clientWidth || innerWidth; canvas.height = stage.clientHeight || innerHeight; };
  resize();
  const onMove = (x, y) => { loft.yaw = -x * Math.PI; loft.pitch = Math.max(-1.2, Math.min(1.2, -y * 1.2)); };
  const mouse = (e) => onMove((e.clientX / innerWidth) - 0.5, (e.clientY / innerHeight) - 0.5);
  const orient = (e) => onMove((e.gamma || 0) / 90, (e.beta || 0) / 180 - 0.25);
  addEventListener("mousemove", mouse); addEventListener("deviceorientation", orient); addEventListener("resize", resize);
  loft.handlers = [["mousemove", mouse], ["deviceorientation", orient], ["resize", resize]];

  const tick = () => {
    if (!loft || loft.mode !== "preview") return;
    loft.raf = requestAnimationFrame(tick);
    const quat = quatFromAngles(loft.yaw, loft.pitch);
    loft.localPose = { pos: EYE.slice(), quat };
    gl.viewport(0, 0, canvas.width, canvas.height);
    const tint = loft.tint;
    gl.clearColor(tint[0], tint[1], tint[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const proj = perspective(1.1, (canvas.width || 1) / (canvas.height || 1), 0.1, 100);
    const viewM = mul(mul(rotX(-loft.pitch), rotY(-loft.yaw)), translate(-EYE[0], -EYE[1], -EYE[2]));
    drawScene(gl, g, mul(proj, viewM));
  };
  loft.raf = requestAnimationFrame(tick);
}

function roomTint(kind) {
  return ({
    quest: [0.11, 0.22, 0.45], pico: [0.10, 0.30, 0.28], vive: [0.28, 0.14, 0.34], pcvr: [0.18, 0.20, 0.26],
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
  if (loft.mode === "preview" && loft.raf) cancelAnimationFrame(loft.raf);
  for (const [ev, fn] of (loft.handlers || [])) removeEventListener(ev, fn);
  if (loft.session) { try { loft.session.end(); } catch {} }
  loft = null;
  showStage(false);
}
