// "My services" — opens the services running on your own computer (Plex,
// Jellyfin, Audiobookshelf, Sunshine, ...) through the home server.
//
// How it reaches a service:
//   * on your home network, it links straight to the service (full speed), and
//   * off-site, it goes through the home server's /svc/ gateway.
// The server decides who may open what: your own services are private to you;
// you can share one service with one person by name; the site admin can open
// anyone's, for moderation.

import { store } from "./store.js";
import { openDialog, closeDialog, copyText } from "./compat.js";
import * as Relays from "./relays.js";

const $ = (id) => document.getElementById(id);
let ctx = { conn: () => null, toast() {} };

const ICON = { plex: "🎥", jellyfin: "🎬", emby: "🎬", audiobookshelf: "🎧", navidrome: "🎵", sunshine: "🎮", qbittorrent: "⬇️", homeassistant: "🏠" };
const icon = (id) => ICON[id] || "🔌";

export function init(c) {
  ctx = Object.assign(ctx, c || {});
  const dlg = $("services-dialog");
  if (dlg) { const close = $("services-close"); if (close) close.onclick = () => closeDialog(dlg); }
  const vclose = $("svc-viewer-close");
  if (vclose) vclose.onclick = closePanel;
}

export async function open() {
  const dlg = $("services-dialog");
  if (!dlg) return;
  openDialog(dlg);
  await refresh();
}

async function refresh() {
  const body = $("services-body");
  if (!body) return;
  const conn = ctx.conn();
  if (!conn || !conn.ready) { body.innerHTML = `<p class="fine">You're offline. Connect to open your services.</p>`; return; }
  body.innerHTML = `<p class="fine">Loading…</p>`;
  const r = await conn.op("svc-list", {});
  if (!r || r.error) { body.innerHTML = `<p class="fine">${esc((r && r.error) || "Couldn't load services.")}</p>`; return; }
  render(r);
}

function render(r) {
  const body = $("services-body");
  const list = r.services || [];
  const onPrimary = Relays.onPrimary();
  if (!list.length) {
    body.innerHTML = `<p class="fine">No services are shared with you${r.owner ? " yet, and none were found running on your computer" : ""}.</p>`;
    return;
  }
  body.innerHTML = `
    ${!onPrimary ? `<p class="fine services-warn">Your home computer looks offline, so off-site opening won't work until it's back. Services on your home network still open directly.</p>` : ""}
    <div class="services-grid">
      ${list.map((s) => `
        <div class="service-card ${s.running ? "up" : "down"}">
          <div class="service-head"><span class="service-icon">${icon(s.id)}</span>
            <div><strong>${esc(s.name)}</strong><br><small class="fine">${s.running ? "🟢 running" : "⚪ not running"}</small></div>
          </div>
          ${s.note ? `<p class="fine">${esc(s.note)}</p>` : ""}
          <div class="service-actions">
            <button type="button" class="primary small" data-open="${esc(s.id)}" ${s.running ? "" : "disabled"}>Open</button>
            ${r.owner ? `<button type="button" class="ghost small" data-share="${esc(s.id)}">Share…</button>` : ""}
          </div>
          ${r.owner ? `<div class="service-share" id="share-${esc(s.id)}" hidden></div>` : ""}
        </div>`).join("")}
    </div>`;
  body.querySelectorAll("[data-open]").forEach((b) => { b.onclick = () => openService(list.find((s) => s.id === b.getAttribute("data-open"))); });
  body.querySelectorAll("[data-share]").forEach((b) => { b.onclick = () => toggleShare(b.getAttribute("data-share")); });
}

// Opens the service INSIDE FreeMessenger, in a panel — not as a bare web link.
// It always goes through the home server's gateway (which makes the service
// embeddable), so the home server must be reachable.
async function openService(svc) {
  if (!svc) return;
  if (!Relays.onPrimary()) { ctx.toast("Your home computer is offline, so services can only open while it's on."); return; }
  const conn = ctx.conn();
  const r = conn && conn.ready ? await conn.op("svc-ticket", { service: svc.id }) : { error: "offline" };
  if (!r || r.error) { ctx.toast((r && r.error) || "Couldn't open that."); return; }
  openInPanel(svc, `${Relays.get()}/svc/${r.ticket}/${svc.id}${svc.web || "/"}`);
}

function openInPanel(svc, url) {
  const panel = $("svc-viewer"), frame = $("svc-frame");
  if (!panel || !frame) return;
  const title = $("svc-viewer-title"); if (title) title.textContent = `${icon(svc.id)} ${svc.name}`;
  frame.src = url;
  panel.hidden = false;
  document.body.classList.add("panel-open");
  const dlg = $("services-dialog"); if (dlg && dlg.open) closeDialog(dlg);
}

function closePanel() {
  const panel = $("svc-viewer"), frame = $("svc-frame");
  if (frame) frame.src = "about:blank";
  if (panel) panel.hidden = true;
  document.body.classList.remove("panel-open");
}

function toggleShare(id) {
  const box = $("share-" + id);
  if (!box) return;
  if (box.hidden) { box.hidden = false; loadShare(id); } else { box.hidden = true; }
}

async function loadShare(id) {
  const box = $("share-" + id);
  if (!box) return;
  box.innerHTML = `<p class="fine">Loading who has access…</p>`;
  const conn = ctx.conn();
  const r = conn && conn.ready ? await conn.op("svc-grants", {}) : { error: "offline" };
  const grants = (r && r.grants) || {};
  const shared = Object.keys(grants).filter((u) => (grants[u] || []).includes(id));
  box.innerHTML = `
    <form class="share-form">
      <span>@</span><input class="share-input" maxlength="20" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="username">
      <button type="submit" class="primary small">Give access</button>
    </form>
    <p class="fine">Only this one service. They can't see your others.</p>
    ${shared.length ? `<ul class="share-list">${shared.map((u) => `<li>@${esc(u)} <button type="button" class="link" data-revoke="${esc(u)}">remove</button></li>`).join("")}</ul>` : `<p class="fine">Not shared with anyone yet.</p>`}`;
  box.querySelector(".share-form").onsubmit = async (e) => {
    e.preventDefault();
    const who = box.querySelector(".share-input").value.trim().toLowerCase().replace(/^@/, "");
    if (!who) return;
    const g = await conn.op("svc-grant", { service: id, user: who });
    ctx.toast(g && g.ok ? `Gave @${who} access to ${id}.` : (g && g.error) || "Couldn't share.");
    if (g && g.ok) loadShare(id);
  };
  box.querySelectorAll("[data-revoke]").forEach((b) => {
    b.onclick = async () => {
      const who = b.getAttribute("data-revoke");
      const g = await conn.op("svc-grant", { service: id, user: who, on: false });
      ctx.toast(g && g.ok ? `Removed @${who}.` : "Couldn't update.");
      if (g && g.ok) loadShare(id);
    };
  });
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
