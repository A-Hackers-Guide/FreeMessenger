// Doodles (draw, or draw on a photo), round video messages, and QR codes
// for your username.

import qrcode from "qrcode-generator";
import { clear } from "./compat.js";

const $ = (id) => document.getElementById(id);

// ---------- doodles ----------

const COLORS = ["#111111", "#ffffff", "#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ec4899"];
let pad = null; // { canvas, ctx, strokes, color, size, bg, onSend }

export function openDoodle(onSend) {
  const canvas = $("doodle-canvas");
  const wrap = $("doodle");
  wrap.hidden = false;
  const rect = canvas.parentElement.getBoundingClientRect();
  const scale = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(rect.width * scale);
  canvas.height = Math.round(rect.height * scale);
  pad = { canvas, ctx: canvas.getContext("2d"), strokes: [], color: COLORS[2], size: 6 * scale, bg: null, scale, onSend };
  const colors = $("doodle-colors");
  clear(colors);
  for (const c of COLORS) {
    const b = document.createElement("button");
    b.style.background = c;
    b.className = c === pad.color ? "on" : "";
    b.onclick = () => { pad.color = c; colors.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); };
    colors.appendChild(b);
  }
  redraw();
}

function redraw() {
  const { ctx, canvas } = pad;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (pad.bg) {
    const s = Math.min(canvas.width / pad.bg.width, canvas.height / pad.bg.height);
    const w = pad.bg.width * s, h = pad.bg.height * s;
    ctx.drawImage(pad.bg, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  }
  ctx.lineCap = ctx.lineJoin = "round";
  for (const st of pad.strokes) {
    ctx.strokeStyle = st.color;
    ctx.lineWidth = st.size;
    ctx.beginPath();
    st.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (st.points.length === 1) ctx.lineTo(st.points[0][0] + 0.1, st.points[0][1]);
    ctx.stroke();
  }
}

function point(e) {
  const r = pad.canvas.getBoundingClientRect();
  return [(e.clientX - r.left) * (pad.canvas.width / r.width), (e.clientY - r.top) * (pad.canvas.height / r.height)];
}

export function initDoodle() {
  const canvas = $("doodle-canvas");
  let drawing = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (!pad) return;
    canvas.setPointerCapture(e.pointerId);
    drawing = { color: pad.color, size: pad.size, points: [point(e)] };
    pad.strokes.push(drawing);
    redraw();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    drawing.points.push(point(e));
    redraw();
  });
  const end = () => { drawing = null; };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  $("doodle-size").oninput = () => { if (pad) pad.size = Number($("doodle-size").value) * pad.scale; };
  $("doodle-undo").onclick = () => { if (pad) { pad.strokes.pop(); redraw(); } };
  $("doodle-clear").onclick = () => { if (pad) { pad.strokes = []; pad.bg = null; redraw(); } };
  $("doodle-photo").onclick = () => $("doodle-file").click();
  $("doodle-file").onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f || !pad) return;
    const img = new Image();
    img.onload = () => { pad.bg = img; redraw(); };
    img.src = URL.createObjectURL(f);
  };
  $("doodle-cancel").onclick = () => { $("doodle").hidden = true; pad = null; };
  $("doodle-send").onclick = () => {
    if (!pad) return;
    const p = pad;
    p.canvas.toBlob((blob) => {
      $("doodle").hidden = true;
      pad = null;
      if (blob) p.onSend(new File([blob], "doodle.jpg", { type: "image/jpeg" }));
    }, "image/jpeg", 0.88);
  };
}

// ---------- round video messages ----------

let rec = null;

export async function startVideoNote(onDone, toast) {
  if (!(navigator.mediaDevices && window.MediaRecorder)) return toast("This browser can't record video.");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: "user", width: { ideal: 480 }, height: { ideal: 480 } } });
  } catch {
    return toast("Camera or microphone unavailable. Check your browser's permissions.");
  }
  const types = ["video/mp4;codecs=avc1,mp4a", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/mp4", "video/webm"];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
  const r = new MediaRecorder(stream, Object.assign({ videoBitsPerSecond: 600000, audioBitsPerSecond: 48000 }, mimeType ? { mimeType } : {}));
  const parts = [];
  r.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  r.start(500);
  rec = { r, stream, started: Date.now(), send: false };
  $("vnote").hidden = false;
  $("vnote-preview").srcObject = stream;
  const tick = setInterval(() => {
    const s = Math.floor((Date.now() - rec.started) / 1000);
    $("vnote-time").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} / 1:00`;
    if (s >= 60) $("vnote-send").click();
  }, 250);
  r.onstop = () => {
    clearInterval(tick);
    stream.getTracks().forEach((t) => t.stop());
    $("vnote").hidden = true;
    $("vnote-preview").srcObject = null;
    const send = rec && rec.send;
    const duration = Math.round((Date.now() - rec.started) / 1000);
    rec = null;
    if (!send || !parts.length) return;
    const type = (r.mimeType || mimeType || "video/webm").split(";")[0];
    onDone(new File([new Blob(parts, { type })], /mp4/.test(type) ? "video-message.mp4" : "video-message.webm", { type }), duration);
  };
}

export function initVideoNote() {
  $("vnote-send").onclick = () => { if (rec) { rec.send = true; rec.r.stop(); } };
  $("vnote-cancel").onclick = () => { if (rec) { rec.send = false; rec.r.stop(); } };
}

// ---------- QR codes ----------

export function drawQr(el, text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  clear(el);
  const n = qr.getModuleCount();
  const cell = Math.max(4, Math.floor(260 / (n + 8)));
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = (n + 8) * cell;
  const c = canvas.getContext("2d");
  c.fillStyle = "#fff";
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.fillStyle = "#111";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) c.fillRect((x + 4) * cell, (y + 4) * cell, cell, cell);
  el.appendChild(canvas);
}

let scanning = null;

// Scans with the camera where the browser can read QR codes itself.
export async function scanQr(onText, toast) {
  if (!("BarcodeDetector" in window)) return toast("This browser can't scan codes. Use your phone's camera app instead: it opens the link.");
  let detector;
  try { detector = new window.BarcodeDetector({ formats: ["qr_code"] }); } catch { return toast("This browser can't scan codes."); }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }); } catch { return toast("Camera unavailable."); }
  const video = $("qr-video");
  video.srcObject = stream;
  video.hidden = false;
  await video.play().catch(() => {});
  scanning = { stream, stop: false };
  const stop = () => {
    if (!scanning) return;
    scanning.stop = true;
    stream.getTracks().forEach((t) => t.stop());
    video.hidden = true;
    video.srcObject = null;
    scanning = null;
  };
  const loop = async () => {
    if (!scanning || scanning.stop) return;
    try {
      const found = await detector.detect(video);
      if (found && found[0] && found[0].rawValue) { stop(); return onText(found[0].rawValue); }
    } catch {}
    setTimeout(loop, 250);
  };
  loop();
  return stop;
}

export function stopScan() {
  if (scanning) {
    scanning.stop = true;
    scanning.stream.getTracks().forEach((t) => t.stop());
    $("qr-video").hidden = true;
    scanning = null;
  }
}
