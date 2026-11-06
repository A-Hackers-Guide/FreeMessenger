// Group voice and video calls: every person connects straight to every other
// person (a "mesh"), up to 20 people. Each person sends their video to
// everyone else, so video quality is lowered automatically as people join,
// keeping the total upload within an ordinary home or phone connection
// (about 2–3 Mbps with 20 people). Voice is small enough not to need it. Call setup travels as encrypted
// messages through the relay like 1-to-1 calls; audio and video don't.
//
// Whoever is already in the call sends the offer to someone who joins, so
// two people never offer to each other at the same time.

import { uuid, clear } from "./compat.js";

const $ = (id) => document.getElementById(id);
const MAX = 20;

// Video bitrate (bits/s) and size reduction for each stream, by call size.
function quality(people) {
  if (people <= 3) return { bitrate: 1200000, scale: 1 };
  if (people <= 5) return { bitrate: 700000, scale: 1 };
  if (people <= 8) return { bitrate: 400000, scale: 1.5 };
  if (people <= 12) return { bitrate: 250000, scale: 2 };
  return { bitrate: 150000, scale: 3 };
}

async function applyQuality() {
  if (!gc || !gc.video) return;
  const q = quality(gc.peers.size + 1);
  for (const p of gc.peers.values()) {
    for (const sender of p.pc.getSenders()) {
      if (!sender.track || sender.track.kind !== "video" || !sender.getParameters) continue;
      try {
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = q.bitrate;
        params.encodings[0].scaleResolutionDownBy = gc.screen ? 1 : q.scale;
        await sender.setParameters(params);
      } catch {}
    }
  }
  $("gcall-grid").dataset.size = gc.peers.size + 1 > 8 ? "big" : "";
}
let ctx = null; // { me(), send(to, payload), members(gid), title(gid), name(user), ice(), media(video), toast(), log(entry), ring(on) }
let gc = null;  // the call this browser is in
let invite = null;
const recent = new Map(); // gid -> { cid, video, ts } calls heard about

export function init(c) {
  ctx = c;
  $("gcall-leave").onclick = () => leave();
  $("gcall-mute").onclick = () => {
    const tracks = gc && gc.local ? gc.local.getAudioTracks() : [];
    const muted = tracks.some((t) => t.enabled);
    tracks.forEach((t) => (t.enabled = !muted));
    $("gcall-mute").textContent = muted ? "Unmute" : "Mute";
  };
  $("gcall-cam").onclick = () => {
    const tracks = gc && gc.local ? gc.local.getVideoTracks() : [];
    const off = tracks.some((t) => t.enabled);
    tracks.forEach((t) => (t.enabled = !off));
    $("gcall-cam").textContent = off ? "Camera on" : "Camera off";
  };
  $("gcall-screen").onclick = toggleScreen;
  $("gcall-join").onclick = () => { const i = invite; hideInvite(); if (i) join(i.gid, i.cid, i.video); };
  $("gcall-ignore").onclick = hideInvite;
}

export const inCall = () => !!gc;

// Start a call in a group, or join the one already going there.
export async function start(gid, video) {
  if (gc) return ctx.toast("You're already in a call.");
  const known = recent.get(gid);
  if (known && Date.now() - known.ts < 2 * 3600e3) return join(gid, known.cid, video);
  const members = ctx.members(gid);
  if (members.length + 1 > MAX) return ctx.toast(`Group calls work with up to ${MAX} people. This group has ${members.length + 1}.`);
  const cid = uuid();
  if (!(await enter(gid, cid, video))) return;
  recent.set(gid, { cid, video, ts: Date.now() });
  for (const to of members) ctx.send(to, { kind: "gcall-ring", gid, cid, video });
  status("Ringing everyone…");
  setTimeout(() => { if (gc && gc.cid === cid && !gc.peers.size) status("Waiting for people to join…"); }, 30000);
}

async function join(gid, cid, video) {
  if (gc) return;
  if (!(await enter(gid, cid, video))) return;
  for (const to of ctx.members(gid)) ctx.send(to, { kind: "gcall-join", gid, cid });
  status("Joining…");
  setTimeout(() => {
    if (gc && gc.cid === cid && !gc.peers.size) {
      status("Nobody else is in this call right now.");
      recent.delete(gid);
    }
  }, 15000);
}

async function enter(gid, cid, video) {
  let local;
  try {
    local = await ctx.media(video);
  } catch (e) {
    ctx.toast(e.message);
    return false;
  }
  gc = { gid, cid, video, local, peers: new Map(), started: Date.now(), screen: null };
  $("gcall").hidden = false;
  $("gcall").classList.toggle("audio", !video);
  $("gcall-title").textContent = ctx.title(gid);
  $("gcall-cam").hidden = !video;
  $("gcall-screen").hidden = !video || !(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  $("gcall-mute").textContent = "Mute";
  $("gcall-cam").textContent = "Camera off";
  clear($("gcall-grid"));
  addTile(ctx.me(), local, true);
  return true;
}

function status(text) {
  $("gcall-status").textContent = text;
}

function updateStatus() {
  if (!gc) return;
  applyQuality();
  const n = gc.peers.size + 1;
  status(n === 1 ? "Just you so far" : `${n} people`);
}

function addTile(name, stream, self) {
  let tile = document.querySelector(`#gcall-grid [data-user="${name}"]`);
  if (!tile) {
    tile = document.createElement("div");
    tile.className = "gtile" + (self ? " self" : "");
    tile.dataset.user = name;
    const v = document.createElement("video");
    v.autoplay = true;
    v.playsInline = true;
    if (self) v.muted = true;
    const label = document.createElement("span");
    label.textContent = self ? "You" : ctx.name(name);
    const letter = document.createElement("b");
    letter.textContent = (self ? "Y" : ctx.name(name).replace("@", "")[0] || "?").toUpperCase();
    tile.append(v, letter, label);
    $("gcall-grid").appendChild(tile);
  }
  if (stream) tile.querySelector("video").srcObject = stream;
  $("gcall-grid").dataset.count = String($("gcall-grid").children.length);
  return tile;
}

function removeTile(name) {
  const tile = document.querySelector(`#gcall-grid [data-user="${name}"]`);
  if (tile) tile.remove();
  $("gcall-grid").dataset.count = String($("gcall-grid").children.length);
}

async function peerConnection(name) {
  const pc = new RTCPeerConnection({ iceServers: await ctx.ice() });
  const peer = { pc, pendingIce: [] };
  gc.peers.set(name, peer);
  gc.local.getTracks().forEach((t) => pc.addTrack(t, gc.local));
  pc.onicecandidate = (e) => {
    if (!e.candidate || !gc) return;
    const c = e.candidate.toJSON ? e.candidate.toJSON() : { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex };
    ctx.send(name, { kind: "gcall-ice", gid: gc.gid, cid: gc.cid, c });
  };
  const remote = new MediaStream();
  pc.ontrack = (e) => {
    const stream = e.streams && e.streams[0] ? e.streams[0] : (remote.addTrack(e.track), remote);
    addTile(name, stream, false);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") dropPeer(name);
    if (pc.connectionState === "connected") applyQuality();
  };
  addTile(name, null, false);
  updateStatus();
  return peer;
}

function dropPeer(name) {
  if (!gc) return;
  const p = gc.peers.get(name);
  if (p) { try { p.pc.close(); } catch {} }
  gc.peers.delete(name);
  removeTile(name);
  updateStatus();
}

// Call setup messages from other members (already decrypted and checked to
// come from someone in the group).
export async function handle(from, p, ts) {
  const gid = p.gid;
  if (p.kind === "gcall-ring" || p.kind === "gcall-join") recent.set(gid, { cid: p.cid, video: !!p.video || (recent.get(gid) || {}).video, ts: Date.now() });
  if (p.kind === "gcall-ring") {
    if (gc || Date.now() - ts > 60000) return;
    invite = { gid, cid: p.cid, video: !!p.video, from };
    $("gcall-invite-text").textContent = `${ctx.name(from)} started a ${p.video ? "video" : "voice"} call in ${ctx.title(gid)}`;
    $("gcall-invite").hidden = false;
    ctx.ring(true);
    ctx.log({ group: gid, video: !!p.video, dir: "in", ts: Date.now(), result: "Group call", from });
    setTimeout(() => { if (invite && invite.cid === p.cid) hideInvite(); }, 45000);
    return;
  }
  if (!gc || gc.gid !== gid || gc.cid !== p.cid) return;
  if (p.kind === "gcall-join") {
    if (gc.peers.has(from)) dropPeer(from);
    if (gc.peers.size + 1 >= MAX) return;
    const peer = await peerConnection(from);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    ctx.send(from, { kind: "gcall-offer", gid, cid: gc.cid, sdp: offer.sdp });
  } else if (p.kind === "gcall-offer") {
    if (gc.peers.has(from)) dropPeer(from);
    const peer = await peerConnection(from);
    await peer.pc.setRemoteDescription({ type: "offer", sdp: p.sdp });
    for (const c of peer.pendingIce.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    ctx.send(from, { kind: "gcall-answer", gid, cid: gc.cid, sdp: answer.sdp });
  } else if (p.kind === "gcall-answer") {
    const peer = gc.peers.get(from);
    if (!peer) return;
    await peer.pc.setRemoteDescription({ type: "answer", sdp: p.sdp });
    for (const c of peer.pendingIce.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
  } else if (p.kind === "gcall-ice") {
    const peer = gc.peers.get(from);
    if (!peer) return;
    if (peer.pc.remoteDescription) peer.pc.addIceCandidate(p.c).catch(() => {});
    else peer.pendingIce.push(p.c);
  } else if (p.kind === "gcall-leave") {
    dropPeer(from);
  }
}

function hideInvite() {
  invite = null;
  $("gcall-invite").hidden = true;
  ctx.ring(false);
}

export function leave() {
  if (!gc) return;
  const { gid, cid, started, video } = gc;
  for (const to of ctx.members(gid)) ctx.send(to, { kind: "gcall-leave", gid, cid });
  for (const name of [...gc.peers.keys()]) dropPeer(name);
  gc.local.getTracks().forEach((t) => t.stop());
  if (gc.screen) gc.screen.getTracks().forEach((t) => t.stop());
  gc = null;
  $("gcall").hidden = true;
  clear($("gcall-grid"));
  const secs = Math.round((Date.now() - started) / 1000);
  ctx.log({ group: gid, video, dir: "out", ts: started, dur: secs, result: "Group call" });
}

async function toggleScreen() {
  if (!gc) return;
  const swap = async (track) => {
    for (const p of gc.peers.values()) {
      const sender = p.pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) await sender.replaceTrack(track);
    }
    const self = document.querySelector("#gcall-grid .gtile.self video");
    if (self) self.srcObject = new MediaStream([track]);
  };
  if (gc.screen) {
    gc.screen.getTracks().forEach((t) => t.stop());
    gc.screen = null;
    const cam = gc.local.getVideoTracks()[0];
    if (cam) await swap(cam);
    $("gcall-screen").textContent = "Share screen";
    return;
  }
  try {
    gc.screen = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const track = gc.screen.getVideoTracks()[0];
    track.onended = () => { if (gc && gc.screen) toggleScreen(); };
    await swap(track);
    $("gcall-screen").textContent = "Stop sharing";
  } catch {
    if (gc) gc.screen = null;
  }
}
