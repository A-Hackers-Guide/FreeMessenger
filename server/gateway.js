// Service gateway.
//
// This exposes THIS computer's own local services — Plex, Jellyfin,
// Audiobookshelf, Sunshine and anything else the owner lists — to the owner
// (and people the owner explicitly shares with), through the relay this
// computer already runs. So each person's own PC carries only their own
// traffic.
//
// It is deliberately NOT proxy.js. proxy.js is the locked-down PUBLIC web
// viewer: it blocks the LAN and strips scripts. This is the opposite — a full,
// streaming, scripts-and-websockets passthrough — so it is fenced in hard:
//
//   * Only a fixed allowlist of the owner's OWN services is reachable. There
//     is no request-controlled host or port, so it can't be pointed at the
//     rest of the LAN or the internet (no SSRF).
//   * Every request needs a short-lived ticket, and a ticket is only ever
//     handed to a signed-in account that is the owner or on the share list.
//   * Services are reached on 127.0.0.1 only.
//
// server.js calls issueTicket() from inside an authenticated op, and routes
// /svc/<ticket>/<id>/... (and websocket upgrades) here.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import crypto from "node:crypto";

// Well-known self-hosted services and the localhost port each listens on. The
// owner's config.json can override ports, drop entries, or add custom ones.
export const KNOWN = {
  plex: { name: "Plex", port: 32400, icon: "🎥" },
  jellyfin: { name: "Jellyfin", port: 8096, icon: "🎬" },
  emby: { name: "Emby", port: 8096, icon: "🎬" },
  audiobookshelf: { name: "Audiobookshelf", port: 13378, icon: "🎧" },
  navidrome: { name: "Navidrome", port: 4533, icon: "🎵" },
  sunshine: { name: "Sunshine", port: 47990, icon: "🎮", https: true },
  qbittorrent: { name: "qBittorrent", port: 8080, icon: "⬇️" },
  homeassistant: { name: "Home Assistant", port: 8123, icon: "🏠" },
};

// ---------- the owner's service list ----------

// A clean, validated list from config.json, falling back to the known set.
// Each entry: { id, name, port, icon, https }.
export function services(config) {
  const raw = config && Array.isArray(config.services) ? config.services : null;
  const out = [];
  const seen = new Set();
  const add = (id, def) => {
    id = String(id || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!id || seen.has(id)) return;
    const port = Number(def.port);
    if (!(port >= 1 && port <= 65535)) return;
    seen.add(id);
    out.push({ id, name: String(def.name || id).slice(0, 40), port, icon: String(def.icon || "🔌").slice(0, 8), https: !!def.https });
  };
  if (raw) {
    for (const s of raw) add(s.id || s.name, s);
  } else {
    for (const id of Object.keys(KNOWN)) add(id, KNOWN[id]);
  }
  return out;
}

// server.js passes its own MEDIA list (the single source of truth); each entry
// is { id, name, port, tls?, icon?, ... }.
function find(list, id) {
  id = String(id || "").toLowerCase();
  return (list || []).find((s) => s.id === id) || null;
}

// The account that owns this computer's services (reaches all of them). The
// site admin is handled separately and can reach everyone's, for moderation.
export function owner(config) {
  return String((config && config.owner) || "").toLowerCase();
}

// May `username` open service `serviceId`?
//   - the site admin can open ANY service (moderation);
//   - the owner can open ALL of their own services;
//   - anyone else can open ONLY the services granted to them by name.
// `grants` is { "<username>": ["<serviceId>", ...] }, kept by server.js.
export function authorize(config, username, serviceId, isAdmin, grants) {
  username = String(username || "").toLowerCase();
  if (isAdmin) return true;
  if (username && username === owner(config)) return true;
  const mine = grants && grants[username];
  return Array.isArray(mine) && mine.includes(String(serviceId));
}

// Pure helpers server.js uses to keep the grant list (then persists it).
export function grant(grants, username, serviceId) {
  username = String(username || "").toLowerCase();
  const g = Object.assign({}, grants);
  const list = new Set(g[username] || []);
  list.add(String(serviceId));
  g[username] = [...list];
  return g;
}
export function revoke(grants, username, serviceId) {
  username = String(username || "").toLowerCase();
  const g = Object.assign({}, grants);
  if (g[username]) {
    g[username] = g[username].filter((s) => s !== String(serviceId));
    if (!g[username].length) delete g[username];
  }
  return g;
}

// ---------- discovery ----------

// A service is "up" if something is listening on its localhost port. A plain
// TCP connect works for every service (HTTP, HTTPS, anything) and never needs
// a per-service health URL.
export function probe(port, timeout = 700) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => { sock.destroy(); resolve(true); });
    sock.setTimeout(timeout, () => { sock.destroy(); resolve(false); });
    sock.on("error", () => resolve(false));
  });
}

export async function status(list) {
  const out = (list || []).map((s) => ({ id: s.id, name: s.name, port: s.port, icon: s.icon || "🔌", tls: !!s.tls, web: s.web || "/", note: s.note || "" }));
  await Promise.all(out.map(async (s) => { s.running = await probe(s.port); }));
  return out;
}

// ---------- tickets ----------

const tickets = new Map(); // token -> { username, service, until }
const TICKET_MS = 2 * 3600e3;
const rnd = () => crypto.randomBytes(20).toString("hex"); // 40 hex chars

// A ticket is bound to ONE service, so a person granted one service can never
// use their ticket to reach another.
export function issueTicket(username, serviceId) {
  for (const [t, v] of tickets) if (v.until < Date.now()) tickets.delete(t);
  const token = rnd();
  tickets.set(token, { username: String(username), service: String(serviceId), until: Date.now() + TICKET_MS });
  return token;
}

export function checkTicket(token) {
  const v = tickets.get(String(token || ""));
  if (!v || v.until < Date.now()) return null;
  return v; // { username, service, until }
}

// ---------- the reverse proxy ----------

// Hop-by-hop headers must not be forwarded.
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

function cleanHeaders(headers) {
  const out = {};
  for (const k of Object.keys(headers)) if (!HOP.has(k.toLowerCase())) out[k] = headers[k];
  return out;
}

// Remove CSP directives that would stop the page being shown inside the
// FreeMessenger panel (we keep the rest of the policy).
function openEmbedding(h) {
  for (const k of Object.keys(h)) {
    const kl = k.toLowerCase();
    if (kl === "x-frame-options") delete h[k];
    else if (kl === "content-security-policy" || kl === "content-security-policy-report-only") {
      h[k] = String(h[k]).split(",").map((pol) => pol.split(";").filter((d) => !/^\s*frame-ancestors/i.test(d)).join(";")).join(",");
    }
  }
}

// So the service's own page works under the /svc/<id>/ path when framed: point
// root-absolute links at the prefix, add a <base>, and patch fetch/XHR/WebSocket
// to do the same for requests the page makes while running.
function rewriteHtml(html, base) {
  html = html
    .replace(/(\s(?:src|href|action|poster|data-src|data-href)\s*=\s*")\/(?!\/)/gi, `$1${base}/`)
    .replace(/(\s(?:src|href|action|poster|data-src|data-href)\s*=\s*')\/(?!\/)/gi, `$1${base}/`);
  const shim = `<base href="${base}/"><script>(function(){var B=${JSON.stringify(base)};function fx(u){try{if(typeof u==="string"&&u.charAt(0)==="/"&&u.charAt(1)!=="/")return B+u;}catch(e){}return u;}var f=window.fetch;if(f)window.fetch=function(u,o){return f(u&&u.url?u:fx(u),o);};var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){return xo.apply(this,[m,fx(u)].concat([].slice.call(arguments,2)));};var WS=window.WebSocket;if(WS){var N=function(u,p){if(typeof u==="string"&&u.charAt(0)==="/"&&u.charAt(1)!=="/")u=(location.protocol==="https:"?"wss://":"ws://")+location.host+B+u;return p?new WS(u,p):new WS(u);};N.prototype=WS.prototype;window.WebSocket=N;}}());</script>`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + shim) : shim + html;
}

const rewriteCss = (css, base) => css.replace(/url\(\s*(['"]?)\/(?!\/)/gi, (m, q) => `url(${q}${base}/`);

// Proxies one HTTP request to the service and streams the answer back.
// `base` is the public path prefix (/svc/<token>/<id>). HTML and CSS are
// rewritten so the service works inside the panel; everything else (scripts,
// images, video, downloads) streams straight through untouched.
export function proxyHttp(req, res, svc, rest, base) {
  const lib = (svc.tls || svc.https) ? https : http;
  const headers = cleanHeaders(req.headers);
  headers.host = "127.0.0.1:" + svc.port;
  delete headers["accept-encoding"]; // uncompressed, so we can rewrite the text
  const options = {
    host: "127.0.0.1", port: svc.port, method: req.method,
    path: rest || "/", headers,
    rejectUnauthorized: false, // local self-signed (e.g. Sunshine) is fine
    timeout: 30000,
  };
  const up = lib.request(options, (upRes) => {
    const h = cleanHeaders(upRes.headers);
    openEmbedding(h);
    if (h.location && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(h.location)) {
      h.location = base + h.location.replace(/^https?:\/\/[^/]+/i, "");
    } else if (h.location && h.location.startsWith("/")) {
      h.location = base + h.location;
    }
    const type = String(h["content-type"] || "").toLowerCase();
    const isHtml = /text\/html|application\/xhtml/.test(type);
    const isCss = /text\/css/.test(type);
    if (!isHtml && !isCss) { res.writeHead(upRes.statusCode || 502, h); return upRes.pipe(res); }
    // Buffer the (small) text document, rewrite it, then send.
    const chunks = []; let size = 0; let tooBig = false;
    upRes.on("data", (c) => { size += c.length; if (size > 16 * 1024 * 1024) tooBig = true; if (!tooBig) chunks.push(c); });
    upRes.on("end", () => {
      if (tooBig) { res.writeHead(upRes.statusCode || 502, h); return res.end(Buffer.concat(chunks)); }
      let body = Buffer.concat(chunks).toString("utf8");
      body = isCss ? rewriteCss(body, base) : rewriteHtml(body, base);
      delete h["content-length"];
      res.writeHead(upRes.statusCode || 502, h);
      res.end(body);
    });
    upRes.on("error", () => { try { res.end(); } catch {} });
  });
  up.on("timeout", () => up.destroy(new Error("service timeout")));
  up.on("error", () => { if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }); res.end("Service isn't reachable."); });
  req.pipe(up);
}

// Proxies a websocket upgrade to the service (Plex/Jellyfin notifications,
// Home Assistant, etc.). server.js calls this from its 'upgrade' handler.
export function proxyWs(req, socket, head, svc, rest) {
  const headers = cleanHeaders(req.headers);
  headers.host = "127.0.0.1:" + svc.port;
  headers.connection = "Upgrade";
  headers.upgrade = req.headers.upgrade;
  const up = http.request({ host: "127.0.0.1", port: svc.port, method: req.method, path: rest || "/", headers });
  up.on("upgrade", (upRes, upSocket) => {
    const lines = ["HTTP/1.1 101 Switching Protocols"];
    for (const k of Object.keys(upRes.headers)) lines.push(`${k}: ${upRes.headers[k]}`);
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) upSocket.unshift(head);
    socket.pipe(upSocket);
    upSocket.pipe(socket);
  });
  up.on("error", () => { try { socket.destroy(); } catch {} });
  up.end();
}

// Parses /svc/<token>/<id>/<rest...> and returns what the caller needs, or an
// error. Pure; no side effects.
export function route(pathname, list) {
  const m = /^\/svc\/([0-9a-f]{40})\/([a-z0-9_-]+)(\/.*|)$/i.exec(pathname);
  if (!m) return { error: "not found", code: 404 };
  const tk = checkTicket(m[1]);
  if (!tk) return { error: "The service link expired. Open it again from FreeMessenger.", code: 403 };
  const id = m[2].toLowerCase();
  // The ticket is for one service only; it can't be reused for another.
  if (tk.service !== id) return { error: "This link isn't for that service.", code: 403 };
  const svc = find(list, id);
  if (!svc) return { error: "No such service.", code: 404 };
  return { username: tk.username, svc, rest: m[3] || "/", base: `/svc/${m[1]}/${id}` };
}
