// Photos, files and voice messages. They go through the relay like any other
// message: split into 32 KB pieces, each encrypted on its own, and put back
// together on the other side. The relay never sees what's inside.

import { b64, unb64 } from "./compat.js";

export const CHUNK_BYTES = 32 * 1024;   // fits the relay's 64 KB message limit after encryption
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PHOTO_SIDE = 1600;

export function readBytes(blob) {
  if (blob.arrayBuffer) return blob.arrayBuffer().then((b) => new Uint8Array(b));
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result));
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(blob);
  });
}

export async function toChunks(blob) {
  const bytes = await readBytes(blob);
  const out = [];
  for (let i = 0; i < bytes.length; i += CHUNK_BYTES) out.push(b64(bytes.subarray(i, i + CHUNK_BYTES)));
  return out.length ? out : [""];
}

export function fromChunks(parts, type) {
  return new Blob(parts.map((p) => unb64(p)), { type: type || "application/octet-stream" });
}

const loadImage = (blob) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("not an image")); };
  img.src = url;
});

// Photos are made smaller before sending so they arrive quickly, like other
// messengers do. GIFs are sent as they are so they keep moving.
export async function preparePhoto(file) {
  if (!/^image\//.test(file.type) || file.type === "image/gif" || file.type === "image/svg+xml") {
    return { blob: file, type: file.type };
  }
  let img;
  try { img = await loadImage(file); } catch { return { blob: file, type: file.type }; }
  const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  if (scale === 1 && file.size < 400 * 1024) return { blob: file, type: file.type, w, h };
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  const blob = await new Promise((resolve) => {
    try { canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85); } catch { resolve(null); }
  });
  // Keep the original only if it's already small enough and the copy didn't help.
  if (!blob || (scale === 1 && blob.size >= file.size)) {
    return scale === 1 ? { blob: file, type: file.type, w, h } : { blob: file, type: file.type, w: img.naturalWidth, h: img.naturalHeight };
  }
  return { blob, type: "image/jpeg", w, h };
}

// ---------- incoming pieces ----------

const incoming = new Map(); // fid -> { parts: [], got: 0, total, envs: [] }

// Returns the finished Blob when the last piece arrives, otherwise null.
export function addChunk(fid, index, total, data, type, env) {
  let f = incoming.get(fid);
  if (!f) incoming.set(fid, (f = { parts: [], got: 0, total, envs: [] }));
  if (env) f.envs.push(env);
  if (f.parts[index] === undefined) { f.parts[index] = data; f.got++; }
  if (f.got < f.total) return null;
  incoming.delete(fid);
  return { blob: fromChunks(f.parts, type), envs: f.envs };
}

export function progress(fid) {
  const f = incoming.get(fid);
  return f ? f.got / f.total : null;
}

// ---------- voice messages ----------

export const canRecord = () =>
  !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const types = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined);
  const parts = [];
  const started = Date.now();
  rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  rec.start(250);
  const finish = () => new Promise((resolve) => {
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const type = (rec.mimeType || mimeType || "audio/webm").split(";")[0];
      resolve({ blob: new Blob(parts, { type }), type, duration: Math.round((Date.now() - started) / 1000) });
    };
    try { rec.stop(); } catch { resolve(null); }
  });
  return {
    started,
    stop: finish,
    cancel: () => { finish(); },
  };
}

export function humanSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}
