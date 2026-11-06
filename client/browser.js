// The web viewer: opens pages through the home server for people the admin
// allowed. The page is shown in a sandbox with scripts off, and the site
// sees the home server's address instead of yours.

import * as Relays from "./relays.js";

const $ = (id) => document.getElementById(id);
let ctx = null; // { conn(), toast() }
let ticket = null;

export function init(c) {
  ctx = c;
  $("browser-close").onclick = close;
  $("browser-form").onsubmit = (e) => {
    e.preventDefault();
    go($("browser-url").value);
  };
}

function close() {
  $("browser").hidden = true;
  $("browser-frame").src = "about:blank";
  document.body.classList.remove("panel-open");
}

export async function open(url) {
  if (!Relays.onPrimary()) return ctx.toast("The web viewer works only while the home server is on.");
  $("browser").hidden = false;
  document.body.classList.add("panel-open");
  if (url) go(url); else $("browser-url").focus();
}

async function go(raw) {
  let url = String(raw || "").trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = /\s/.test(url) || !/\./.test(url)
    ? "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(url)
    : "https://" + url;
  $("browser-url").value = url;
  const conn = ctx.conn();
  if (!ticket || ticket.until < Date.now()) {
    const r = conn && conn.ready ? await conn.op("proxy-ticket", {}) : { error: "Not connected." };
    if (r.error) { ctx.toast(r.error); return close(); }
    ticket = { id: r.ticket, until: Date.now() + 100 * 60e3 };
  }
  $("browser-frame").src = `${Relays.get()}/p/${ticket.id}/page?u=${encodeURIComponent(url)}`;
}
