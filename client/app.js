import { RELAY_URL } from "./config.js";
import * as E2E from "./crypto.js";

const $ = (id) => document.getElementById(id);
const USERNAME = /^[a-z0-9_]{3,20}$/;
const MAX_HISTORY = 1000;

// ---------- local storage (everything stays in this browser) ----------

const store = {
  get(k, fallback) {
    try { const v = localStorage.getItem("fm." + k); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem("fm." + k, JSON.stringify(v)); } catch {} },
  clearAll() {
    try { Object.keys(localStorage).filter((k) => k.startsWith("fm.")).forEach((k) => localStorage.removeItem(k)); } catch {}
  },
};

let me = store.get("identity", null);
let contacts = store.get("contacts", {}); // name -> { ecdhPub, last, unread, preview }
let active = null;
const saveContacts = () => store.set("contacts", contacts);
const loadChat = (name) => store.get("chat." + name, []);
const saveChat = (name, list) => store.set("chat." + name, list.slice(-MAX_HISTORY));

// ---------- relay ----------

async function api(path, opts = {}) {
  let r;
  try { r = await fetch(RELAY_URL + path, opts); } catch { throw new Error("Can't reach the relay. Check your connection."); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `Relay error ${r.status}`), { status: r.status });
  return data;
}

async function getContact(name) {
  if (contacts[name]?.ecdhPub) return contacts[name];
  const p = await api(`/api/user/${name}`);
  contacts[name] = { last: 0, unread: 0, preview: "", ...contacts[name], ecdhPub: p.ecdhPub };
  saveContacts();
  return contacts[name];
}

let ws = null;
let wsReady = false;
let retry = 0;
let refSeq = 0;
const pending = new Map();

function connect() {
  ws = new WebSocket(RELAY_URL.replace(/^http/, "ws") + "/api/ws/" + me.username);
  ws.onmessage = async (ev) => {
    if (ev.data === "pong") return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "challenge") {
      ws.send(JSON.stringify({ type: "auth", signature: await E2E.signChallenge(me, msg.challenge) }));
    } else if (msg.type === "ready") {
      wsReady = true;
      retry = 0;
      setConnected(true);
      flushOutbox();
    } else if (msg.type === "message") {
      handleIncoming(msg);
    } else if (msg.type === "sent") {
      pending.get(msg.ref)?.(msg);
      pending.delete(msg.ref);
    }
  };
  ws.onclose = (ev) => {
    wsReady = false;
    setConnected(false);
    for (const resolve of pending.values()) resolve({ error: "offline" });
    pending.clear();
    if (ev.code === 4001) return toast("This browser's keys don't match your account. Restore your backup file.");
    setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++));
  };
}

setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send("ping"); }, 50000);

function sendRaw(to, body, ephemeral) {
  return new Promise((resolve) => {
    if (!wsReady) return resolve({ error: "offline" });
    const ref = ++refSeq;
    pending.set(ref, resolve);
    ws.send(JSON.stringify({ type: "send", ref, to, body, ephemeral }));
    setTimeout(() => { if (pending.delete(ref)) resolve({ error: "timeout" }); }, 15000);
  });
}

async function sendPayload(to, payload, ephemeral = false) {
  try {
    const c = await getContact(to);
    return await sendRaw(to, await E2E.encrypt(me, c.ecdhPub, payload), ephemeral);
  } catch (e) {
    return { error: e.message };
  }
}

async function handleIncoming(env) {
  if (!env.ephemeral) ws.send(JSON.stringify({ type: "ack", items: [{ id: env.id, ts: env.ts }] }));
  let payload;
  try {
    const c = await getContact(env.from);
    payload = await E2E.decrypt(me, c.ecdhPub, env.body);
  } catch {
    return; // not really from them, or corrupted — drop it
  }
  if (payload.kind === "text") {
    if (loadChat(env.from).some((m) => m.mid === payload.mid)) return;
    addMessage(env.from, { mid: payload.mid, mine: false, text: String(payload.text), ts: env.ts });
    notify(`@${env.from}`, payload.text);
  } else {
    handleCall(env.from, payload, env.ts);
  }
}

// ---------- messages ----------

function addMessage(name, m) {
  const list = loadChat(name);
  list.push(m);
  saveChat(name, list);
  const c = (contacts[name] ||= { last: 0, unread: 0, preview: "" });
  c.last = m.ts;
  c.preview = (m.mine ? "You: " : "") + m.text;
  if (!m.mine && !(active === name && !document.hidden)) c.unread = (c.unread || 0) + 1;
  saveContacts();
  renderContacts();
  if (active === name) appendMessage(m, true);
  updateTitle();
}

function updateMessage(name, mid, patch) {
  const list = loadChat(name);
  const m = list.find((x) => x.mid === mid);
  if (!m) return;
  Object.assign(m, patch);
  saveChat(name, list);
  if (active === name) {
    const el = document.querySelector(`[data-mid="${mid}"] .status`);
    if (el) el.textContent = statusLabel(m);
  }
}

async function sendText(to, text) {
  const m = { mid: crypto.randomUUID(), mine: true, text, ts: Date.now(), status: "sending" };
  addMessage(to, m);
  deliverText(to, m);
}

async function deliverText(to, m) {
  const r = await sendPayload(to, { kind: "text", mid: m.mid, text: m.text });
  updateMessage(to, m.mid, { status: r.error ? "waiting" : "sent" });
}

function flushOutbox() {
  for (const name of Object.keys(contacts)) {
    for (const m of loadChat(name)) if (m.mine && m.status && m.status !== "sent") deliverText(name, m);
  }
}

const statusLabel = (m) => !m.mine || !m.status ? "" : m.status === "sent" ? "Sent" : m.status === "sending" ? "Sending…" : "Will send when you're back online";

// ---------- rendering ----------

const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function renderContacts() {
  const ul = $("contacts");
  ul.replaceChildren();
  const names = Object.keys(contacts).sort((a, b) => (contacts[b].last || 0) - (contacts[a].last || 0));
  for (const name of names) {
    const c = contacts[name];
    const li = document.createElement("li");
    li.className = name === active ? "active" : "";
    li.innerHTML = `<span class="avatar"></span><span class="meta"><strong></strong><small></small></span><span class="badge"></span>`;
    li.querySelector(".avatar").textContent = name[0].toUpperCase();
    li.querySelector("strong").textContent = "@" + name;
    li.querySelector("small").textContent = c.preview || "";
    const badge = li.querySelector(".badge");
    if (c.unread) badge.textContent = c.unread; else badge.remove();
    li.onclick = () => openChat(name);
    ul.append(li);
  }
  $("contacts-empty").hidden = names.length > 0;
}

function appendMessage(m, scroll) {
  const li = document.createElement("li");
  li.className = m.system ? "system" : m.mine ? "mine" : "theirs";
  li.dataset.mid = m.mid;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = m.text;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.innerHTML = `<span></span> <span class="status"></span>`;
  meta.firstChild.textContent = time(m.ts);
  meta.querySelector(".status").textContent = statusLabel(m);
  li.append(bubble, meta);
  $("messages").append(li);
  if (scroll) li.scrollIntoView({ block: "end" });
}

function openChat(name) {
  active = name;
  if (contacts[name]) { contacts[name].unread = 0; saveContacts(); }
  $("empty").hidden = true;
  $("convo").hidden = false;
  $("peer-name").textContent = "@" + name;
  $("messages").replaceChildren();
  for (const m of loadChat(name)) appendMessage(m, false);
  $("messages").lastElementChild?.scrollIntoView({ block: "end" });
  document.body.classList.add("in-convo");
  renderContacts();
  updateTitle();
  $("send-text").focus();
}

function closeChat() {
  active = null;
  document.body.classList.remove("in-convo");
  $("convo").hidden = true;
  $("empty").hidden = false;
  renderContacts();
}

function setConnected(on) {
  $("conn").className = "dot " + (on ? "on" : "off");
  $("conn").title = on ? "Connected" : "Reconnecting…";
}

function updateTitle() {
  const n = Object.values(contacts).reduce((s, c) => s + (c.unread || 0), 0);
  document.title = n ? `(${n}) FreeMessenger` : "FreeMessenger";
}

let toastTimer;
function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 4000);
}

function notify(title, body) {
  if (!document.hidden || !("Notification" in window) || Notification.permission !== "granted") return;
  try { new Notification(title, { body: String(body).slice(0, 120) }); } catch {}
}

// ---------- calls (WebRTC, browser to browser) ----------

const call = { state: "idle", peer: null, id: null, video: false, pc: null, local: null, offer: null, pendingIce: [], started: 0, timer: null };
const earlyIce = new Map();
let iceServers = null;

async function getIceServers() {
  if (!iceServers) {
    try { iceServers = (await api("/api/ice")).iceServers; } catch { iceServers = [{ urls: "stun:stun.cloudflare.com:3478" }]; }
  }
  return iceServers;
}

async function getMedia(video) {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true, video });
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
    if (e.candidate) sendPayload(call.peer, { kind: "ice", callId: call.id, candidate: e.candidate.toJSON() }, true);
  };
  pc.ontrack = (e) => { $("remote-video").srcObject = e.streams[0]; };
  pc.onconnectionstatechange = () => {
    if (pc !== call.pc) return;
    if (pc.connectionState === "connected") {
      call.state = "live";
      call.started ||= Date.now();
      clearInterval(call.timer);
      call.timer = setInterval(() => setCallStatus(duration()), 1000);
      setCallStatus(duration());
      showCallControls();
    } else if (pc.connectionState === "disconnected") {
      setCallStatus("Reconnecting…");
    } else if (pc.connectionState === "failed") {
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
  if (!wsReady) return toast("You're offline right now.");
  Object.assign(call, { state: "calling", peer, id: crypto.randomUUID(), video, started: 0, pendingIce: [] });
  showCallScreen(`Calling…`);
  try {
    call.local = await getMedia(video);
    const pc = await makePeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const r = await sendPayload(peer, { kind: "call-offer", callId: call.id, video, sdp: offer.sdp }, true);
    if (r.error || !r.delivered) {
      setCallStatus(`@${peer} isn't online right now`);
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
    showCallScreen(p.video ? "Incoming video call" : "Incoming voice call", true);
    startRinging(true);
    notify(`@${from} is calling`, p.video ? "Video call" : "Voice call");
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
    setCallStatus(`@${from} is on another call`);
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
  call.pc?.close();
  Object.assign(call, { state: "idle", peer: null, id: null, pc: null, local: null, offer: null, pendingIce: [], started: 0 });
  $("remote-video").srcObject = null;
  $("local-video").srcObject = null;
  $("call").hidden = true;
  if (peer) addMessage(peer, { mid: crypto.randomUUID(), system: true, mine: false, text: "📞 " + label, ts: Date.now() });
}

function duration() {
  const s = Math.floor((Date.now() - call.started) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function showCallScreen(status, incoming = false) {
  $("call").hidden = false;
  $("call").classList.toggle("audio", !call.video);
  $("call-peer").textContent = "@" + call.peer;
  $("call-avatar").textContent = call.peer[0].toUpperCase();
  $("accept-btn").hidden = !incoming;
  $("hangup-btn").textContent = incoming ? "Decline" : "End";
  $("mute-btn").hidden = $("cam-btn").hidden = incoming;
  $("mute-btn").textContent = "Mute";
  $("cam-btn").textContent = "Camera off";
  $("cam-btn").hidden ||= !call.video;
  setCallStatus(status);
}

function showCallControls() {
  $("hangup-btn").textContent = "End";
  $("mute-btn").hidden = false;
  $("cam-btn").hidden = !call.video;
}

const setCallStatus = (text) => ($("call-status").textContent = text);

// A soft two-tone ring made with WebAudio, so there's no sound file to host.
let ring = null;
function startRinging(incoming) {
  stopRinging();
  try {
    const ctx = new AudioContext();
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

// ---------- account ----------

function downloadBackup() {
  const blob = new Blob([JSON.stringify({ freemessenger: 1, ...me }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `freemessenger-${me.username}-backup.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  store.set("backedUp", true);
  $("backup-banner").hidden = true;
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
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
  renderContacts();
  updateTitle();
  connect();
  const hash = location.hash.slice(1).toLowerCase();
  if (USERNAME.test(hash) && hash !== me.username) openContact(hash);
}

async function openContact(name) {
  $("add-error").textContent = "";
  if (!USERNAME.test(name)) return ($("add-error").textContent = "Usernames are 3-20 characters: a-z, 0-9 and _");
  if (name === me.username) return ($("add-error").textContent = "That's you!");
  try {
    await getContact(name);
    renderContacts();
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
    await api("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: name, sigPub: identity.sigPub, ecdhPub: identity.ecdhPub }),
    });
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
  const text = $("send-text").value.trim();
  if (!text || !active) return;
  $("send-text").value = "";
  $("send-text").style.height = "";
  sendText(active, text.slice(0, 8000));
};
$("send-text").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("send-form").requestSubmit();
  }
};
$("send-text").oninput = (e) => {
  e.target.style.height = "";
  e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
};

$("back-btn").onclick = closeChat;
$("voice-btn").onclick = () => active && startCall(active, false);
$("video-btn").onclick = () => active && startCall(active, true);
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

$("safety-btn").onclick = async () => {
  if (!active) return;
  const c = await getContact(active);
  $("safety-peer").textContent = "@" + active;
  $("safety-code").textContent = await E2E.safetyCode(me.ecdhPub, c.ecdhPub);
  $("safety-dialog").showModal();
};
$("safety-close").onclick = () => $("safety-dialog").close();

$("menu-btn").onclick = (e) => { e.stopPropagation(); $("menu").hidden = !$("menu").hidden; };
document.addEventListener("click", () => ($("menu").hidden = true));
$("share-btn").onclick = async () => {
  const link = `${location.origin}${location.pathname}#${me.username}`;
  try {
    if (navigator.share) await navigator.share({ title: "Message me on FreeMessenger", url: link });
    else { await navigator.clipboard.writeText(link); toast("Link copied: " + link); }
  } catch {}
};
$("backup-btn").onclick = downloadBackup;
$("banner-backup-btn").onclick = downloadBackup;
$("notify-btn").onclick = async () => {
  if (!("Notification" in window)) return toast("This browser doesn't support notifications.");
  const p = await Notification.requestPermission();
  toast(p === "granted" ? "Notifications on (while this tab is open)." : "Notifications are blocked in browser settings.");
};
$("logout-btn").onclick = () => {
  if (!confirm("Sign out of this browser? Your account only comes back with your backup file. Messages saved here will be removed.")) return;
  store.clearAll();
  location.hash = "";
  location.reload();
};

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && active && contacts[active]?.unread) {
    contacts[active].unread = 0;
    saveContacts();
    renderContacts();
    updateTitle();
  }
});
window.addEventListener("hashchange", () => {
  const hash = location.hash.slice(1).toLowerCase();
  if (me && USERNAME.test(hash) && hash !== me.username) openContact(hash);
});

if (me) {
  start();
} else {
  $("welcome").hidden = false;
  const hash = location.hash.slice(1).toLowerCase();
  if (USERNAME.test(hash)) $("invite-note").textContent = `@${hash} invited you. Pick a username to message them.`;
}
